import { streamText, stepCountIs, hasToolCall, tool, type ToolSet } from "ai";
import { anthropic, openai, xai, getModel } from "./providers";
import { CLAUDE_SYSTEM_PROMPT } from "./personas/claude";
import { CHATGPT_SYSTEM_PROMPT } from "./personas/chatgpt";
import { GROK_SYSTEM_PROMPT } from "./personas/grok";
import { getTournamentDecksTool } from "./tools/limitless";
import { getTcgplayerDataTool } from "./tools/tcgplayer";
import {
  TradePlanSchema,
  validatePlan,
  type TradePlan,
  type PreviousNotes,
} from "./schema";
import { computeCost, preflightEstimate } from "./costEstimator";

export type BotConfig = {
  bot_id: string;
  display_name: string;
  persona: string;
  model_provider: string;
  model_id: string;
};

export type BotState = {
  bot_id: string;
  display_name: string;
  persona: string;
  cash_usd: number;
  holdings: Array<{
    card_id: string;
    name: string;
    buy_price_usd: number;
    current_market_price_usd: number;
  }>;
};

export type PoolCard = {
  card_id: string;
  name: string;
  set_id: string;
  rarity: string | null;
  market_price_usd: number;
};

export type TurnResult = {
  plan: TradePlan;
  bot_id: string;
  model_provider: string;
  model_id: string;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  step_count: number;
  raw_response: string;
  /** Tool names the model invoked, in call order. Helps diagnose "model
   * researched but never submitted" failures by showing what it DID call. */
  tools_called: string[];
  error: string | null;
};

/**
 * Live event emitted while a bot's turn runs. Subscribed to by the simulator
 * orchestrator, persisted to sim_turn_events, surfaced in the UI feed.
 *
 * `text` carries the model's reasoning between tool calls — a flushed
 * accumulation of text-delta chunks. Emitting one batched text event per
 * step boundary (and one final flush at end) keeps DB row count sane while
 * still giving the viewer "what was the model thinking" visibility.
 */
export type TurnEvent =
  | { type: "tool_call"; toolName: string; input: unknown; stepIndex: number }
  | {
      type: "tool_result";
      toolName: string;
      output: unknown;
      stepIndex: number;
    }
  | { type: "step_finish"; stepIndex: number }
  | { type: "text"; text: string; stepIndex: number }
  | { type: "error"; message: string };

const MAX_OUTPUT_TOKENS = 4000;
const MAX_STEPS = 6;
const PER_TURN_BUDGET_USD = 0.5;
const MAX_WEB_SEARCHES_PER_TURN = 1;

/**
 * submit_plan is the structured contract every bot MUST invoke to record
 * its plan. The tool's input schema IS TradePlanSchema, so the ai SDK +
 * provider API validate the plan shape at transport time — no regex, no
 * JSON.parse, no fence hunting. execute() is a no-op because we read the
 * call args off the toolCalls array after the stream completes.
 *
 * Why a tool instead of fenced text: model output drifts stochastically
 * (truncation, prose-only replies, wrong fence format). A tool call is
 * enforced structure; the model cannot submit a plan in the wrong shape.
 */
const submitPlanTool = tool({
  description:
    "Submit your final trade plan for today. Call exactly once at the very end of your turn. Pass the complete plan (actions, overall_strategy_md, watchlist, notes_for_tomorrow_md) as arguments.",
  inputSchema: TradePlanSchema,
  execute: async () => "plan recorded",
});

/**
 * Per-bot configuration: system prompt + tools + provider options.
 * One place to add or tune a bot.
 */
type BotTurnKit = {
  systemPrompt: string;
  tools: ToolSet;
  // `providerOptions` uses JSON-safe provider-specific settings (e.g. xAI Live Search params).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  providerOptions?: any;
};

function getBotKit(botId: string): BotTurnKit {
  switch (botId) {
    case "claude":
      return {
        systemPrompt: CLAUDE_SYSTEM_PROMPT,
        tools: {
          web_search: anthropic.tools.webSearch_20250305({
            maxUses: MAX_WEB_SEARCHES_PER_TURN,
          }),
          get_tournament_decks_for_card: getTournamentDecksTool,
          get_tcgplayer_data: getTcgplayerDataTool,
          submit_plan: submitPlanTool,
        } as unknown as ToolSet,
      };
    case "chatgpt":
      return {
        systemPrompt: CHATGPT_SYSTEM_PROMPT,
        tools: {
          web_search: openai.tools.webSearchPreview({
            searchContextSize: "medium",
          }),
          get_tcgplayer_data: getTcgplayerDataTool,
          submit_plan: submitPlanTool,
        } as unknown as ToolSet,
      };
    case "grok":
      return {
        systemPrompt: GROK_SYSTEM_PROMPT,
        tools: {
          get_tcgplayer_data: getTcgplayerDataTool,
          // xAI Agent Tools API (Responses-API-only)
          web_search: xai.tools.webSearch(),
          x_search: xai.tools.xSearch(),
          submit_plan: submitPlanTool,
        } as unknown as ToolSet,
      };
    default:
      throw new Error(`No bot kit registered for bot_id: ${botId}`);
  }
}

function emptyPlan(reason: string): TradePlan {
  return {
    actions: [],
    overall_strategy_md: reason,
    watchlist: [],
    notes_for_tomorrow_md: `(auto-generated empty plan: ${reason})`,
  };
}

function formatPreviousNotes(prev: PreviousNotes | null): string {
  if (!prev) {
    return "## Your notes from yesterday\n(none — this is Day 1 for you.)\n\n";
  }
  const watchlistStr =
    prev.watchlist.length === 0
      ? "  (empty)"
      : prev.watchlist
          .map(
            (w, i) =>
              `  [${i + 1}] ${w.card_id}${w.current_price_observed_usd !== undefined ? ` @ $${w.current_price_observed_usd.toFixed(2)} yesterday` : ""}\n      Reason watching: ${w.reason_watching_md}\n      Trigger to buy: ${w.trigger_to_buy_md}`,
          )
          .join("\n");

  return `## Your notes from Day ${prev.day} (read these FIRST)

### Notes you wrote to your future self:
${prev.notes_for_tomorrow_md}

### Your watchlist from yesterday:
${watchlistStr}

### Your overall strategy yesterday (for context):
${prev.overall_strategy_md}

---

`;
}

function buildTurnPrompt(
  state: BotState,
  pool: PoolCard[],
  dayOfCompetition: number,
  totalDays: number,
  previousNotes: PreviousNotes | null,
): string {
  const notesSection = formatPreviousNotes(previousNotes);

  const portfolioLines =
    state.holdings.length === 0
      ? "  (empty — you hold no cards yet)"
      : state.holdings
          .map(
            (h) =>
              `  - ${h.card_id.padEnd(12)} ${h.name.padEnd(30)} bought $${h.buy_price_usd.toFixed(2)} → now $${h.current_market_price_usd.toFixed(2)} (${h.current_market_price_usd >= h.buy_price_usd ? "+" : ""}$${(h.current_market_price_usd - h.buy_price_usd).toFixed(2)})`,
          )
          .join("\n");

  // Mark-to-market total the bot reasons against. This is your score if the
  // competition ended right now: cash on hand plus the liquidation value of
  // every holding at today's market prices. Small models (Haiku, mini) are
  // unreliable at adding these in their head — hand them the number.
  const holdingsMtm = state.holdings.reduce(
    (sum, h) => sum + h.current_market_price_usd,
    0,
  );
  const totalValue = state.cash_usd + holdingsMtm;
  const pnlFromStart = totalValue - 1000;
  const pnlSign = pnlFromStart >= 0 ? "+" : "";

  // Top 40 most expensive + 20 midrange sample
  const sorted = [...pool].sort(
    (a, b) => b.market_price_usd - a.market_price_usd,
  );
  const top40 = sorted.slice(0, 40);
  const midStart = Math.floor(sorted.length / 2) - 10;
  const mid20 = sorted.slice(midStart, midStart + 20);
  const poolSample = [...top40, ...mid20];
  const poolLines = poolSample
    .map(
      (c) =>
        `  ${c.card_id.padEnd(12)} $${c.market_price_usd.toFixed(2).padStart(8)}  ${(c.rarity ?? "-").padEnd(28)} ${c.name}`,
    )
    .join("\n");

  const slotsOpen = 5 - state.holdings.length;
  const heldCardIds = state.holdings.map((h) => h.card_id);
  const heldListInline =
    heldCardIds.length === 0
      ? "(none — you hold no cards)"
      : heldCardIds.join(", ");

  const daysRemaining = totalDays - dayOfCompetition;
  const stage =
    dayOfCompetition === 1
      ? "DRAFT DAY — you start with $1,000 and no cards. Build a portfolio."
      : daysRemaining === 0
        ? "FINAL DAY — this is the last chance to trade; whatever you hold at close is your score."
        : daysRemaining === 1
          ? `Day ${dayOfCompetition} of ${totalDays} — ONE bucket left after this. Be ready to sell or hold into close.`
          : `Day ${dayOfCompetition} of ${totalDays} — ${daysRemaining} buckets remain after today.`;

  return `${notesSection}## ${stage}

## Score right now: $${totalValue.toFixed(2)} (${pnlSign}$${pnlFromStart.toFixed(2)} vs $1,000 start)
  cash        $${state.cash_usd.toFixed(2)}
  holdings    $${holdingsMtm.toFixed(2)} (marked at today's market prices)

## Your holdings (${state.holdings.length}/5 slots, ${slotsOpen} open):
${portfolioLines}

## Card pool snapshot (${poolSample.length} of ${pool.length} cards — top prices + midrange):
  ${"card_id".padEnd(12)} ${"price".padStart(9)}  ${"rarity".padEnd(28)} name
${poolLines}

---

Plan TODAY's actions. Read your notes above first.

You can:
- Buy up to ${slotsOpen} new cards (if you have cash)
- Sell any card currently in your portfolio
- Do both (sell one, buy another)
- Pass (empty actions array) — valid if nothing is compelling

## HARD RULES — an invalid plan is rejected whole, the day is wasted:
1. **ONE COPY PER CARD, EVER.** Each card_id can appear in your portfolio at most once. This is NOT stock-market position sizing — you CANNOT "buy 3× Tinkatink" to size up. Quantity per action is fixed at 1. This rule trips plans two ways, both rejected:
   a. Buying a card_id you already hold. You currently hold: ${heldListInline}. None of those card_ids may appear in a "buy" action this turn.
   b. The same card_id appearing more than once in your actions array this turn. e.g. [buy sv2-216, buy sv2-216] is INVALID. If you want exposure to a card, you buy it ONCE. If you want more exposure, you can't — pick a DIFFERENT card_id.
2. You have ${slotsOpen} open slot(s). Buys in this plan cannot exceed ${slotsOpen}. If the portfolio is full and you want a new card, sell one first in the same plan.
3. Total buy cost cannot exceed your cash on hand ($${state.cash_usd.toFixed(2)}). Check the math before submitting.
4. You can only sell card_ids that appear in "Your holdings" above.

Before calling submit_plan, re-read your actions array and confirm: (a) no duplicate card_ids, (b) no buys for cards you already hold, (c) buy count ≤ open slots, (d) total buy cost ≤ cash.

Update your watchlist. Write notes to tomorrow-you. End with ONE JSON block.`;
}

/**
 * Repair common JSON escape issues that LLMs emit inside markdown strings.
 * Does NOT attempt to recover from structural damage (missing commas, unbalanced
 * braces). Only handles character-level escape noise.
 *
 * Cases handled:
 *   - \X where X is not a valid JSON escape char (u, ", \, /, b, f, n, r, t)
 *     → \\X. Covers the common `\w`, `\$`, `\p`, `\_` patterns that show up in
 *     regex-looking or LaTeX-looking reasoning strings.
 *   - Literal raw tab inside a string → \t. Models sometimes paste tabbed
 *     content without escaping.
 *   - Trailing comma before } or ] → removed.
 *
 * Returns the repaired text; the caller should retry JSON.parse with it.
 */
function repairJson(raw: string): string {
  let out = raw.replace(/\\([^"\\/bfnrtu])/g, "\\\\$1");
  out = out.replace(/\t/g, "\\t");
  out = out.replace(/,(\s*[}\]])/g, "$1");
  return out;
}

/**
 * Last-ditch fallback when the model didn't wrap its output in a ```json
 * fence. Scans for the LAST balanced top-level `{ ... }` object in the raw
 * text and returns its substring. Handles braces inside strings correctly
 * so we don't get tricked by a `{` inside a reasoning sentence.
 */
function findRawJsonObject(text: string): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  let start = -1;
  let lastComplete: { s: number; e: number } | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      if (depth > 0) {
        depth--;
        if (depth === 0 && start >= 0) {
          lastComplete = { s: start, e: i + 1 };
          start = -1;
        }
      }
    }
  }
  return lastComplete ? text.slice(lastComplete.s, lastComplete.e) : null;
}

function extractJsonBlock(text: string): unknown {
  const fences = text.match(/```json\s*([\s\S]*?)\s*```/g);
  let candidate: string | null = null;

  if (fences && fences.length > 0) {
    const last = fences[fences.length - 1];
    candidate = last.replace(/```json\s*/, "").replace(/\s*```$/, "");
  } else {
    // Fallback: the model emitted JSON without a fence. Grab the last
    // balanced {...} object in the raw text. Covers the "No ```json fenced
    // block" case that used to auto-pass the turn.
    candidate = findRawJsonObject(text);
    if (!candidate) {
      throw new Error(
        "No ```json fenced block and no raw JSON object found in model output",
      );
    }
  }

  try {
    return JSON.parse(candidate);
  } catch (firstErr) {
    try {
      return JSON.parse(repairJson(candidate));
    } catch {
      throw firstErr;
    }
  }
}

/**
 * Run one bot's daily turn.
 *
 * - Loads the bot's kit (system prompt + tools + provider options) by bot_id
 * - Injects previous notes into the prompt if provided
 * - Runs the LLM with web-search + research tools
 * - Parses + validates the plan
 * - Returns the plan, usage, and cost
 *
 * Failure modes all resolve to an empty plan (safe default):
 *   - Pre-flight cost exceeds per-turn budget → circuit breaker pass
 *   - Claude/GPT/Grok output doesn't parse → pass with error noted
 *   - Plan violates state invariants → pass with error noted
 */
export async function runTurn({
  botConfig,
  state,
  pool,
  dayOfCompetition,
  totalDays = 7,
  previousNotes = null,
  onEvent,
}: {
  botConfig: BotConfig;
  state: BotState;
  pool: PoolCard[];
  dayOfCompetition: number;
  totalDays?: number;
  previousNotes?: PreviousNotes | null;
  onEvent?: (event: TurnEvent) => void | Promise<void>;
}): Promise<TurnResult> {
  const kit = getBotKit(botConfig.bot_id);
  const prompt = buildTurnPrompt(
    state,
    pool,
    dayOfCompetition,
    totalDays,
    previousNotes,
  );

  const estimatedCost = preflightEstimate(
    botConfig.model_id,
    prompt.length + kit.systemPrompt.length,
    MAX_OUTPUT_TOKENS,
  );
  if (estimatedCost > PER_TURN_BUDGET_USD) {
    return {
      plan: emptyPlan(
        `Circuit breaker: worst-case turn cost $${estimatedCost.toFixed(4)} exceeds per-turn cap $${PER_TURN_BUDGET_USD}.`,
      ),
      bot_id: botConfig.bot_id,
      model_provider: botConfig.model_provider,
      model_id: botConfig.model_id,
      tokens_in: 0,
      tokens_out: 0,
      cost_usd: 0,
      step_count: 0,
      raw_response: "",
      tools_called: [],
      error: null,
    };
  }

  const model = getModel(botConfig.model_provider, botConfig.model_id);

  const result = streamText({
    model,
    system: kit.systemPrompt,
    prompt,
    tools: kit.tools,
    // Stop the turn as soon as submit_plan is invoked. Two bugs depend on this:
    //   1. Claude: Anthropic's hosted web_search returns its tool_result inline
    //      on the same assistant message as the tool_use. If we run another step
    //      after submit_plan, the SDK re-sends that assistant message and the
    //      reconstruction loses the web_search_tool_result block, so Anthropic
    //      rejects with "tool use ... without a corresponding web_search_tool_result".
    //   2. ChatGPT: result.toolCalls returns only the FINAL step's calls (see
    //      ai/dist/index.mjs get toolCalls() → this.finalStep.toolCalls). If an
    //      empty trailing step runs after submit_plan, the aggregated view drops
    //      the submit_plan call and we fall into the text-parse fallback.
    // stepCountIs(MAX_STEPS) stays as the backstop for runaway research loops.
    stopWhen: [stepCountIs(MAX_STEPS), hasToolCall("submit_plan")],
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    // Provider-enforced backstop: if the model burns through steps doing
    // research without calling submit_plan, the final allowed step gets its
    // tool choice locked to submit_plan. Guarantees the turn produces a
    // structured plan instead of trailing reasoning text that we can't parse.
    // Earlier steps remain free so research tools (web_search, tcgplayer,
    // limitless) still get called naturally.
    prepareStep: async ({ stepNumber }: { stepNumber: number }) => {
      if (stepNumber >= MAX_STEPS - 1) {
        return {
          toolChoice: {
            type: "tool" as const,
            toolName: "submit_plan",
          },
        };
      }
      return {};
    },
    ...(kit.providerOptions
      ? { providerOptions: kit.providerOptions }
      : {}),
  });

  // Drain the full stream so events fire as they happen. We always iterate
  // (even with no onEvent) so the underlying request always completes; the
  // overhead of an unconsumed callback is negligible.
  //
  // We capture the FIRST stream-level error in `streamErrorMsg` so we can
  // surface it as the real failure later, instead of letting the empty-text
  // path masquerade as a "parse error". This was the bug: a 401 / 429 / 5xx
  // from the provider would emit one error event, we'd swallow it, then
  // report the misleading "no JSON block" downstream.
  let stepIndex = 0;
  let streamErrorMsg: string | null = null;
  // Buffer text-delta chunks per step. Flushed before any non-text event
  // so reasoning text appears in the feed in correct chronological order
  // relative to tool calls. Avoids one DB row per token.
  let textBuffer = "";
  const flushText = async (): Promise<void> => {
    if (!onEvent) {
      textBuffer = "";
      return;
    }
    const trimmed = textBuffer.trim();
    if (trimmed.length > 0) {
      await onEvent({
        type: "text",
        text: trimmed,
        stepIndex,
      });
    }
    textBuffer = "";
  };

  try {
    for await (const part of result.fullStream) {
      const p = part as {
        type: string;
        toolName?: string;
        input?: unknown;
        output?: unknown;
        args?: unknown;
        result?: unknown;
        error?: unknown;
        delta?: unknown;
        text?: unknown;
        textDelta?: unknown;
      };
      if (p.type === "error" && streamErrorMsg === null) {
        streamErrorMsg =
          p.error instanceof Error ? p.error.message : String(p.error);
      }
      // Accumulate streamed text. ai SDK v6 uses `text-delta` with the
      // chunk in either `delta`, `textDelta`, or `text` depending on the
      // exact event family — try all defensively.
      if (p.type === "text-delta" || p.type === "text") {
        const chunk =
          typeof p.delta === "string"
            ? p.delta
            : typeof p.textDelta === "string"
              ? p.textDelta
              : typeof p.text === "string"
                ? p.text
                : "";
        if (chunk.length > 0) textBuffer += chunk;
        continue;
      }
      if (!onEvent) continue;
      if (p.type === "tool-call") {
        // Flush any buffered reasoning before the tool call so the feed
        // shows text → tool_call in chronological order.
        await flushText();
        await onEvent({
          type: "tool_call",
          toolName: p.toolName ?? "(unknown)",
          input: p.input ?? p.args ?? null,
          stepIndex,
        });
      } else if (p.type === "tool-result") {
        await onEvent({
          type: "tool_result",
          toolName: p.toolName ?? "(unknown)",
          output: p.output ?? p.result ?? null,
          stepIndex,
        });
      } else if (p.type === "finish-step" || p.type === "step-finish") {
        await flushText();
        await onEvent({ type: "step_finish", stepIndex });
        stepIndex++;
      } else if (p.type === "error") {
        await onEvent({
          type: "error",
          message:
            p.error instanceof Error ? p.error.message : String(p.error),
        });
      }
    }
    // Final flush at end of stream — captures any trailing reasoning text
    // that arrived after the last tool call / step boundary.
    await flushText();
  } catch (streamErr) {
    streamErrorMsg =
      streamErr instanceof Error ? streamErr.message : String(streamErr);
    if (onEvent) {
      await onEvent({ type: "error", message: streamErrorMsg });
    }
    // Don't rethrow — let the downstream path build a proper TurnResult so
    // the orchestrator can persist the error event with diagnostic context.
  }

  // Each await below can also throw lazily if the stream errored. Catch
  // defensively so we always reach the structured TurnResult return.
  let text = "";
  let usage: { inputTokens?: number; outputTokens?: number } | undefined;
  let steps: unknown[] = [];
  try {
    text = await result.text;
    usage = await result.usage;
    steps = (await result.steps) as unknown[];
  } catch (lateErr) {
    if (streamErrorMsg === null) {
      streamErrorMsg =
        lateErr instanceof Error ? lateErr.message : String(lateErr);
    }
  }

  const tokensIn = usage?.inputTokens ?? 0;
  const tokensOut = usage?.outputTokens ?? 0;
  const cost = computeCost(botConfig.model_id, tokensIn, tokensOut);

  // Aggregate tool calls across ALL steps. result.toolCalls (what the SDK
  // returns via `await result.toolCalls`) is bound to finalStep.toolCalls only
  // (see ai/dist/index.mjs: `get toolCalls() { return this.finalStep.toolCalls }`).
  // So for multi-step turns we walk the steps array ourselves — otherwise any
  // trailing empty step would clobber the record of submit_plan being called.
  const allToolCalls: Array<{ toolName?: string; input?: unknown }> =
    steps.flatMap(
      (s) =>
        ((s as { toolCalls?: Array<{ toolName?: string; input?: unknown }> })
          .toolCalls ?? []),
    );

  // List of every tool the model invoked across the turn, in call order.
  // Crucial for diagnosing "model researched a bunch but never submitted" failures.
  const toolsCalled: string[] = allToolCalls
    .map((tc) => tc.toolName ?? "(unknown)")
    .filter((name) => name && name !== "(unknown)");

  try {
    // If the stream itself failed (provider 5xx, auth, rate limit), that's
    // the real problem — surface it without pretending to parse empty text.
    if (streamErrorMsg !== null) {
      throw new Error(`Provider error: ${streamErrorMsg}`);
    }

    // If the model produced literally nothing — no text, no tool call, no
    // tokens billed — it's almost certainly an upstream failure that didn't
    // surface as an explicit error event. Surface a clear diagnostic.
    if (
      text.length === 0 &&
      allToolCalls.length === 0 &&
      tokensIn === 0 &&
      tokensOut === 0
    ) {
      throw new Error(
        "Model returned no output (0 tokens, no text, no tool call). Likely a provider failure, rate limit, or auth issue — check the API key for this provider.",
      );
    }

    // Preferred path: the model called submit_plan with args the SDK already
    // validated against TradePlanSchema. No regex, no JSON.parse.
    const submitCall = [...allToolCalls]
      .reverse()
      .find((tc) => tc.toolName === "submit_plan") as
      | { input?: TradePlan }
      | undefined;

    // If submit_plan was called but with no input (Zod rejected the args at
    // the SDK layer), surface a precise error so we know the model TRIED.
    if (
      submitCall &&
      (submitCall.input === undefined || submitCall.input === null)
    ) {
      throw new Error(
        `submit_plan was called but its arguments failed schema validation (input was missing). Tools called: [${toolsCalled.join(", ")}]`,
      );
    }

    let plan: TradePlan;
    if (submitCall?.input) {
      plan = submitCall.input;
    } else {
      // Fallback: legacy fence extraction for turns that emitted JSON as text.
      // If we end up here, the model didn't call submit_plan at all — include
      // the list of tools it DID call so we can see what it was doing.
      try {
        const raw = extractJsonBlock(text);
        plan = TradePlanSchema.parse(raw);
      } catch (parseErr) {
        const baseMsg =
          parseErr instanceof Error ? parseErr.message : String(parseErr);
        throw new Error(
          `${baseMsg}. Tools called: [${toolsCalled.join(", ") || "none"}]. Steps: ${steps.length}/${MAX_STEPS}. tokens_out=${tokensOut}.`,
        );
      }
    }

    // Drop invalid actions instead of failing the whole turn — keeps any
    // legitimate buys/sells the bot got right and surfaces the dropped ones
    // as a validator note in `notes_for_tomorrow_md` so next turn's prompt
    // shows the bot what it should fix (typically: watchlist the card with
    // a price trigger instead of trying to buy it now).
    const { cleanedPlan, dropped } = validatePlan(plan, state, pool);
    if (dropped.length > 0) {
      const dropLines = dropped
        .map(
          (d) =>
            `  - action[${d.index}] (${d.action.action} ${d.action.card_id}): ${d.reason}`,
        )
        .join("\n");
      const note =
        `[VALIDATOR NOTE — yesterday's plan had ${dropped.length} dropped action(s):\n` +
        `${dropLines}\n` +
        `These were stripped before execution. If you still want them, ` +
        `move them to your watchlist with a specific trigger_to_buy_md ` +
        `(e.g. "buy if price < $X" or "buy after I sell <holding>"), or ` +
        `re-plan around the actual cash you have today.]\n\n`;
      cleanedPlan.notes_for_tomorrow_md = note + cleanedPlan.notes_for_tomorrow_md;
    }
    return {
      plan: cleanedPlan,
      bot_id: botConfig.bot_id,
      model_provider: botConfig.model_provider,
      model_id: botConfig.model_id,
      tokens_in: tokensIn,
      tokens_out: tokensOut,
      cost_usd: cost,
      step_count: steps.length,
      raw_response: text,
      tools_called: toolsCalled,
      error: null,
    };
  } catch (err) {
    return {
      plan: emptyPlan(
        `Parse/validation error: ${err instanceof Error ? err.message : String(err)}`,
      ),
      bot_id: botConfig.bot_id,
      model_provider: botConfig.model_provider,
      model_id: botConfig.model_id,
      tokens_in: tokensIn,
      tokens_out: tokensOut,
      cost_usd: cost,
      step_count: steps.length,
      raw_response: text,
      tools_called: toolsCalled,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
