import type { SupabaseClient } from "@supabase/supabase-js";
import { adminClient } from "@/lib/supabase/admin";
import {
  runTurn,
  type BotConfig,
  type BotState,
  type PoolCard,
  type TurnEvent,
  type TurnResult,
} from "@/lib/bots/runTurn";
import type {
  PreviousNotes,
  TradePlan,
  WatchlistEntry,
} from "@/lib/bots/schema";
import {
  listAvailableBucketDates,
  loadHistoricalPool,
} from "./loadHistoricalPool";

const STARTING_CASH_USD = 1000;
const STUCK_HEARTBEAT_MS = 2 * 60 * 1000; // 2 minutes

export type PerBotResult = {
  bot_id: string;
  display_name: string;
  turn: TurnResult;
  persistError: string | null;
  actionsApplied: number;
};

export type AdvanceResult = {
  run_id: string;
  advanced_to_day: number;
  sim_bucket_date: string;
  status: "paused" | "completed";
  perBot: PerBotResult[];
  total_cost_usd: number;
  pool_size: number;
};

export class SimAdvanceError extends Error {
  code:
    | "not_found"
    | "already_advancing"
    | "already_completed"
    | "no_bucket"
    | "out_of_range"
    | "internal";
  httpStatus: number;
  constructor(
    code: SimAdvanceError["code"],
    message: string,
    httpStatus = 400,
  ) {
    super(message);
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

/**
 * Advance a sim by exactly one bucket. Caller-facing unit of work behind the
 * "Next Day" button. Idempotent-ish: double-click is rejected via the
 * status='advancing' lock; crash mid-turn leaves the run in 'advancing' and
 * the heartbeat stale, which the UI surfaces as "Stuck".
 */
export async function advanceSimDay(run_id: string): Promise<AdvanceResult> {
  const client = adminClient();

  // Step 1: claim the lock. Select + update in two round-trips rather than
  // a true FOR UPDATE since supabase-js lacks row-lock primitives; the
  // status=paused guard in the update clause gives us effective optimistic
  // concurrency (only one caller can flip paused -> advancing).
  const { data: run, error: readErr } = await client
    .from("sim_runs")
    .select(
      "run_id, start_bucket_date, duration_days, current_day, status, total_cost_usd",
    )
    .eq("run_id", run_id)
    .maybeSingle();
  if (readErr) throw new SimAdvanceError("internal", readErr.message, 500);
  if (!run) throw new SimAdvanceError("not_found", `sim ${run_id} not found`, 404);
  if (run.status === "advancing")
    throw new SimAdvanceError(
      "already_advancing",
      "another advance is already in flight",
      409,
    );
  if (run.status === "completed" || run.status === "failed")
    throw new SimAdvanceError(
      "already_completed",
      `sim is ${run.status}; no more advances allowed`,
      409,
    );
  if (run.current_day >= run.duration_days)
    throw new SimAdvanceError(
      "already_completed",
      "sim has reached its duration",
      409,
    );

  const { error: lockErr, data: locked } = await client
    .from("sim_runs")
    .update({
      status: "advancing",
      last_heartbeat_at: new Date().toISOString(),
    })
    .eq("run_id", run_id)
    .eq("status", "paused")
    .select("run_id")
    .maybeSingle();
  if (lockErr) throw new SimAdvanceError("internal", lockErr.message, 500);
  if (!locked)
    throw new SimAdvanceError(
      "already_advancing",
      "another advance claimed the lock first",
      409,
    );

  try {
    // Step 2: resolve the target sim_bucket_date.
    const allBuckets = await listAvailableBucketDates();
    const startIdx = allBuckets.indexOf(run.start_bucket_date);
    if (startIdx < 0) {
      throw new SimAdvanceError(
        "out_of_range",
        `start_bucket_date ${run.start_bucket_date} no longer in coverage`,
        500,
      );
    }
    const nextSimDay = run.current_day + 1;
    const bucketIdx = startIdx + nextSimDay - 1;
    if (bucketIdx >= allBuckets.length) {
      throw new SimAdvanceError(
        "out_of_range",
        "next bucket not available (price history ran out)",
        500,
      );
    }
    const simBucketDate = allBuckets[bucketIdx];

    // Step 3: load the pool at that date. `pool_at_date` interpolates between
    // each card's enclosing buckets, so every card with any bucket is always
    // priceable — no per-day carry-forward bandage required.
    const pool = await loadHistoricalPool(simBucketDate);

    // Step 4: load bot configs.
    const { data: bots, error: botsErr } = await client
      .from("bots")
      .select("bot_id, display_name, persona, model_provider, model_id")
      .order("bot_id");
    if (botsErr) throw new SimAdvanceError("internal", botsErr.message, 500);
    const botConfigs = (bots ?? []) as BotConfig[];

    // Step 5: per-bot: load state + previous notes, run turn, persist.
    const settled = await Promise.allSettled(
      botConfigs.map(async (bot) => {
        const state = await loadSimBotState(run_id, bot.bot_id, pool);
        const previousNotes = await loadSimPreviousNotes(
          run_id,
          bot.bot_id,
          nextSimDay,
        );

        // Emit turn_start so the live feed has a "Claude is thinking..." row
        // before any tool call lands.
        await persistTurnEvent(client, {
          run_id,
          bot_id: bot.bot_id,
          day: nextSimDay,
          step_index: 0,
          event_type: "turn_start",
          tool_name: null,
          payload: { model: `${bot.model_provider}/${bot.model_id}` },
        });

        const turn = await runTurn({
          botConfig: bot,
          state,
          pool,
          dayOfCompetition: nextSimDay,
          totalDays: run.duration_days,
          previousNotes,
          onEvent: (event: TurnEvent) =>
            persistTurnEvent(
              client,
              mapTurnEventToRow(run_id, bot.bot_id, nextSimDay, event),
            ),
        });

        // Terminal "turn_done" so the feed knows this bot is finished.
        // On error, include rich diagnostics: step_count (how far the model
        // got), tokens_out (did it run the output cap?), raw_tail (what it
        // actually said at the end). Enough to diagnose truncation vs
        // prose-only vs tool-finish-without-submit.
        await persistTurnEvent(client, {
          run_id,
          bot_id: bot.bot_id,
          day: nextSimDay,
          step_index: turn.step_count,
          event_type: turn.error ? "error" : "turn_done",
          tool_name: null,
          payload: turn.error
            ? {
                message: turn.error,
                raw_tail: turn.raw_response
                  ? turn.raw_response.slice(-800)
                  : "",
                tools_called: turn.tools_called,
                step_count: turn.step_count,
                tokens_in: turn.tokens_in,
                tokens_out: turn.tokens_out,
                cost_usd: turn.cost_usd,
              }
            : {
                actions: turn.plan.actions.length,
                cost_usd: turn.cost_usd,
                tokens_in: turn.tokens_in,
                tokens_out: turn.tokens_out,
              },
        });
        const persist = await persistSimTurnResult({
          run_id,
          bot,
          state,
          plan: turn.plan,
          day: nextSimDay,
          simBucketDate,
          pool,
          result: turn,
        });
        return {
          bot_id: bot.bot_id,
          display_name: bot.display_name,
          turn,
          actionsApplied: persist.actionsApplied,
          persistError: persist.error,
        } satisfies PerBotResult;
      }),
    );

    const perBot: PerBotResult[] = [];
    for (let i = 0; i < settled.length; i++) {
      const s = settled[i];
      if (s.status === "fulfilled") {
        perBot.push(s.value);
      } else {
        // One bot crashing doesn't take down the whole advance — the others
        // persist their turns. Surface the error on the crashed bot's row.
        const bot = botConfigs[i];
        perBot.push({
          bot_id: bot.bot_id,
          display_name: bot.display_name,
          turn: {
            plan: {
              actions: [],
              overall_strategy_md: "Turn threw before completion.",
              watchlist: [],
              notes_for_tomorrow_md:
                s.reason instanceof Error
                  ? s.reason.message
                  : String(s.reason),
            },
            bot_id: bot.bot_id,
            model_provider: bot.model_provider,
            model_id: bot.model_id,
            tokens_in: 0,
            tokens_out: 0,
            cost_usd: 0,
            step_count: 0,
            raw_response: "",
            tools_called: [],
            error:
              s.reason instanceof Error ? s.reason.message : String(s.reason),
          },
          actionsApplied: 0,
          persistError:
            s.reason instanceof Error ? s.reason.message : String(s.reason),
        });
      }
    }

    const roundCost = perBot.reduce((sum, b) => sum + b.turn.cost_usd, 0);

    // Step 6: close the advance. Flip paused (or completed) and bump totals.
    const nextStatus: "paused" | "completed" =
      nextSimDay >= run.duration_days ? "completed" : "paused";
    const { error: closeErr } = await client
      .from("sim_runs")
      .update({
        status: nextStatus,
        current_day: nextSimDay,
        total_cost_usd: Number(
          (Number(run.total_cost_usd ?? 0) + roundCost).toFixed(4),
        ),
        last_heartbeat_at: new Date().toISOString(),
        completed_at: nextStatus === "completed" ? new Date().toISOString() : null,
      })
      .eq("run_id", run_id);
    if (closeErr) throw new SimAdvanceError("internal", closeErr.message, 500);

    return {
      run_id,
      advanced_to_day: nextSimDay,
      sim_bucket_date: simBucketDate,
      status: nextStatus,
      perBot,
      total_cost_usd: Number(
        (Number(run.total_cost_usd ?? 0) + roundCost).toFixed(4),
      ),
      pool_size: pool.length,
    };
  } catch (err) {
    // Leave status='advancing' so the stale heartbeat surfaces the stuck
    // state; don't reset to 'paused' because partial writes may have landed.
    // A cleanup action can later mark it failed.
    await client
      .from("sim_runs")
      .update({
        error_message: err instanceof Error ? err.message : String(err),
        last_heartbeat_at: new Date().toISOString(),
      })
      .eq("run_id", run_id);
    throw err;
  }
}

/**
 * Rebuilds the bot's state for a given sim day from the sim ledger:
 *   cash     = $1000 - sum(sim_trades.price_usd where action='buy')
 *                    + sum(sim_trades.price_usd where action='sell')
 *   holdings = rows currently in sim_holdings for (run_id, bot_id),
 *              revalued at today's market prices from the passed pool.
 */
export async function loadSimBotState(
  run_id: string,
  bot_id: string,
  pool: PoolCard[],
): Promise<BotState> {
  const client = adminClient();

  const { data: bot } = await client
    .from("bots")
    .select("display_name, persona")
    .eq("bot_id", bot_id)
    .single();

  const { data: trades } = await client
    .from("sim_trades")
    .select("action, price_usd")
    .eq("run_id", run_id)
    .eq("bot_id", bot_id)
    .neq("action", "pass");

  let cash = STARTING_CASH_USD;
  for (const t of trades ?? []) {
    const price = Number(t.price_usd ?? 0);
    if (t.action === "buy") cash -= price;
    if (t.action === "sell") cash += price;
  }

  const { data: holdings } = await client
    .from("sim_holdings")
    .select("card_id, buy_price_usd, cards(name)")
    .eq("run_id", run_id)
    .eq("bot_id", bot_id);

  const mappedHoldings = ((holdings ?? []) as unknown as Array<{
    card_id: string;
    buy_price_usd: number | string;
    cards: { name: string } | null;
  }>).map((h) => {
    const card = pool.find((p) => p.card_id === h.card_id);
    return {
      card_id: h.card_id,
      name: h.cards?.name ?? "(unknown)",
      buy_price_usd: Number(h.buy_price_usd),
      current_market_price_usd:
        card?.market_price_usd ?? Number(h.buy_price_usd),
    };
  });

  return {
    bot_id,
    display_name: bot?.display_name ?? bot_id,
    persona: bot?.persona ?? "",
    cash_usd: Number(cash.toFixed(2)),
    holdings: mappedHoldings,
  };
}

export async function loadSimPreviousNotes(
  run_id: string,
  bot_id: string,
  currentSimDay: number,
): Promise<PreviousNotes | null> {
  const client = adminClient();
  const { data } = await client
    .from("sim_bot_notes")
    .select("day, notes_for_tomorrow_md, watchlist_json, overall_strategy_md")
    .eq("run_id", run_id)
    .eq("bot_id", bot_id)
    .lt("day", currentSimDay)
    .order("day", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!data) return null;
  return {
    day: data.day,
    overall_strategy_md: data.overall_strategy_md,
    notes_for_tomorrow_md: data.notes_for_tomorrow_md,
    watchlist: (data.watchlist_json ?? []) as WatchlistEntry[],
  };
}

type PersistTurnArgs = {
  run_id: string;
  bot: BotConfig;
  state: BotState;
  plan: TradePlan;
  day: number;
  simBucketDate: string;
  pool: PoolCard[];
  result: TurnResult;
};

/**
 * Mirrors persistTurnResult in scripts/simulate-day.ts but writes to sim_*
 * tables and scopes every INSERT/DELETE/UPSERT by run_id.
 */
export async function persistSimTurnResult({
  run_id,
  bot,
  state,
  plan,
  day,
  simBucketDate,
  pool,
  result,
}: PersistTurnArgs): Promise<{ actionsApplied: number; error: string | null }> {
  const client = adminClient();
  let actionsApplied = 0;

  // 1. sim_trades: one row per action; a single 'pass' row if no actions.
  type TradeRow = {
    run_id: string;
    bot_id: string;
    day: number;
    decision_index: number;
    action: "buy" | "sell" | "pass";
    card_id: string | null;
    price_usd: number | null;
    reasoning_md: string;
    sources_json: unknown;
    llm_tokens_in: number;
    llm_tokens_out: number;
    llm_cost_usd: number;
  };
  const tradeRows: TradeRow[] = plan.actions.map((a, idx) => {
    const card = pool.find((p) => p.card_id === a.card_id);
    return {
      run_id,
      bot_id: bot.bot_id,
      day,
      decision_index: idx,
      action: a.action,
      card_id: a.card_id,
      price_usd: card?.market_price_usd ?? null,
      reasoning_md: a.reasoning_md,
      sources_json: a.sources,
      llm_tokens_in: result.tokens_in,
      llm_tokens_out: result.tokens_out,
      llm_cost_usd: result.cost_usd,
    };
  });
  if (plan.actions.length === 0) {
    tradeRows.push({
      run_id,
      bot_id: bot.bot_id,
      day,
      decision_index: 0,
      action: "pass",
      card_id: null,
      price_usd: null,
      reasoning_md: plan.overall_strategy_md,
      sources_json: [],
      llm_tokens_in: result.tokens_in,
      llm_tokens_out: result.tokens_out,
      llm_cost_usd: result.cost_usd,
    });
  }
  const { error: tradeErr } = await client.from("sim_trades").insert(tradeRows);
  if (tradeErr)
    return { actionsApplied: 0, error: `sim_trades insert: ${tradeErr.message}` };

  // 2. Execute each action against sim_holdings + running cash.
  let runningCash = state.cash_usd;
  for (const a of plan.actions) {
    const card = pool.find((p) => p.card_id === a.card_id);
    if (!card) continue;
    if (a.action === "buy") {
      runningCash -= card.market_price_usd;
      const { error } = await client.from("sim_holdings").insert({
        run_id,
        bot_id: bot.bot_id,
        card_id: a.card_id,
        buy_price_usd: card.market_price_usd,
        bought_at_day: day,
      });
      if (error)
        return { actionsApplied, error: `sim_holdings insert: ${error.message}` };
    } else if (a.action === "sell") {
      runningCash += card.market_price_usd;
      const { error } = await client
        .from("sim_holdings")
        .delete()
        .eq("run_id", run_id)
        .eq("bot_id", bot.bot_id)
        .eq("card_id", a.card_id);
      if (error)
        return { actionsApplied, error: `sim_holdings delete: ${error.message}` };
    }
    actionsApplied++;
  }

  // 3. Daily snapshot: revalue holdings at today's pool prices.
  const { data: holdingsNow } = await client
    .from("sim_holdings")
    .select("card_id, buy_price_usd")
    .eq("run_id", run_id)
    .eq("bot_id", bot.bot_id);

  const holdingsValue = (holdingsNow ?? []).reduce(
    (sum, h: { card_id: string; buy_price_usd: number | string }) => {
      const card = pool.find((p) => p.card_id === h.card_id);
      return sum + (card?.market_price_usd ?? Number(h.buy_price_usd));
    },
    0,
  );

  const { error: snapErr } = await client.from("sim_daily_snapshots").upsert(
    {
      run_id,
      bot_id: bot.bot_id,
      day,
      sim_bucket_date: simBucketDate,
      cash_usd: Number(runningCash.toFixed(2)),
      holdings_value_usd: Number(holdingsValue.toFixed(2)),
      total_value_usd: Number((runningCash + holdingsValue).toFixed(2)),
      rank: null,
    },
    { onConflict: "run_id,bot_id,day" },
  );
  if (snapErr)
    return { actionsApplied, error: `sim_daily_snapshots: ${snapErr.message}` };

  // 4. sim_bot_notes: today's notes + watchlist + strategy.
  const { error: notesErr } = await client.from("sim_bot_notes").upsert(
    {
      run_id,
      bot_id: bot.bot_id,
      day,
      notes_for_tomorrow_md: plan.notes_for_tomorrow_md,
      watchlist_json: plan.watchlist,
      overall_strategy_md: plan.overall_strategy_md,
    },
    { onConflict: "run_id,bot_id,day" },
  );
  if (notesErr)
    return { actionsApplied, error: `sim_bot_notes: ${notesErr.message}` };

  return { actionsApplied, error: null };
}

/**
 * Helper the viewer page uses to detect stuck runs. A run whose status is
 * 'advancing' and whose heartbeat is older than STUCK_HEARTBEAT_MS is
 * almost certainly crashed; the UI renders a "Stuck" badge for those.
 */
export function isStuck(status: string, lastHeartbeatAt: string): boolean {
  if (status !== "advancing") return false;
  const lastMs = new Date(lastHeartbeatAt).getTime();
  return Date.now() - lastMs > STUCK_HEARTBEAT_MS;
}

// ═══════════════════════════════════════════════════════════════════════════
// sim_turn_events helpers — power the live activity feed on the viewer page.
// ═══════════════════════════════════════════════════════════════════════════

type TurnEventRow = {
  run_id: string;
  bot_id: string;
  day: number;
  step_index: number;
  event_type:
    | "turn_start"
    | "tool_call"
    | "tool_result"
    | "step_finish"
    | "turn_done"
    | "error"
    | "text";
  tool_name: string | null;
  payload: Record<string, unknown>;
};

// Tool input previews are short (queries, card_ids).
const INPUT_PREVIEW_CHARS = 500;
// Tool output previews are bumped — search results and tcgplayer payloads are
// dense and the user wants to see "what did the bot actually receive".
const OUTPUT_PREVIEW_CHARS = 2000;
// Reasoning text gets the most generous cap so the bot's narration is readable.
const TEXT_PREVIEW_CHARS = 4000;

function preview(value: unknown, max: number): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.slice(0, max);
  try {
    return JSON.stringify(value).slice(0, max);
  } catch {
    return String(value).slice(0, max);
  }
}

export function mapTurnEventToRow(
  run_id: string,
  bot_id: string,
  day: number,
  event: TurnEvent,
): TurnEventRow {
  if (event.type === "tool_call") {
    return {
      run_id,
      bot_id,
      day,
      step_index: event.stepIndex,
      event_type: "tool_call",
      tool_name: event.toolName,
      payload: { input_preview: preview(event.input, INPUT_PREVIEW_CHARS) },
    };
  }
  if (event.type === "tool_result") {
    return {
      run_id,
      bot_id,
      day,
      step_index: event.stepIndex,
      event_type: "tool_result",
      tool_name: event.toolName,
      payload: { output_preview: preview(event.output, OUTPUT_PREVIEW_CHARS) },
    };
  }
  if (event.type === "step_finish") {
    return {
      run_id,
      bot_id,
      day,
      step_index: event.stepIndex,
      event_type: "step_finish",
      tool_name: null,
      payload: {},
    };
  }
  if (event.type === "text") {
    return {
      run_id,
      bot_id,
      day,
      step_index: event.stepIndex,
      event_type: "text",
      tool_name: null,
      payload: { text: event.text.slice(0, TEXT_PREVIEW_CHARS) },
    };
  }
  return {
    run_id,
    bot_id,
    day,
    step_index: 0,
    event_type: "error",
    tool_name: null,
    payload: { message: event.message },
  };
}

export async function persistTurnEvent(
  client: SupabaseClient,
  row: TurnEventRow,
): Promise<void> {
  // Fire-and-swallow on error — the live feed is nice-to-have; a single
  // failed insert should never abort a turn.
  try {
    await client.from("sim_turn_events").insert(row);
  } catch {
    // swallow
  }
}
