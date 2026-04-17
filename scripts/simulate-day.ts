#!/usr/bin/env bun
/**
 * M3 validation — run one full Day of the competition with all 3 bots
 * concurrently, persist everything to the DB, verify invariants.
 *
 * Flow per bot:
 *   1. Load yesterday's notes from bot_notes
 *   2. Load current cash + holdings from DB
 *   3. Run the bot's turn (LLM call with tools)
 *   4. Validate + persist: trades, holdings, daily_snapshot, bot_notes
 *
 * All 3 bots run in parallel via Promise.all, each writing its own state.
 *
 * Usage:
 *   bun run simulate-day                # runs for the next day
 *   bun run simulate-day --day 3        # simulate a specific day
 *   bun run simulate-day --only grok    # run just one bot
 *
 * Idempotent: reruns for the same day are blocked by the UNIQUE(bot_id, day, decision_index)
 * constraint on the trades table + UNIQUE(day, round_no) on round_runs.
 */
import { adminClient } from "../src/lib/supabase/admin";
import {
  runTurn,
  type BotConfig,
  type BotState,
  type PoolCard,
  type TurnResult,
} from "../src/lib/bots/runTurn";
import type { PreviousNotes, TradePlan, WatchlistEntry } from "../src/lib/bots/schema";

// ---------- CLI parsing ----------
const args = process.argv.slice(2);
function getArg(flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : undefined;
}
const dayOverride = getArg("--day");
const onlyBot = getArg("--only");

// ---------- Helpers ----------
async function fetchAllRows<T>(
  runPage: (from: number, to: number) => Promise<T[]>,
): Promise<T[]> {
  const step = 1000;
  const all: T[] = [];
  let from = 0;
  while (true) {
    const rows = await runPage(from, from + step - 1);
    all.push(...rows);
    if (rows.length < step) break;
    from += step;
  }
  return all;
}

async function loadPool(): Promise<PoolCard[]> {
  const client = adminClient();

  const cards = await fetchAllRows(async (from, to) => {
    const { data, error } = await client
      .from("cards")
      .select("card_id, name, set_id, rarity")
      .range(from, to);
    if (error) throw error;
    return data ?? [];
  });

  const prices = await fetchAllRows(async (from, to) => {
    const { data, error } = await client
      .from("prices")
      .select("card_id, market_price_usd, captured_at")
      .order("captured_at", { ascending: false })
      .range(from, to);
    if (error) throw error;
    return data ?? [];
  });

  const latest = new Map<string, number>();
  for (const p of prices) {
    if (!latest.has(p.card_id)) latest.set(p.card_id, Number(p.market_price_usd));
  }

  return cards.flatMap((c) => {
    const price = latest.get(c.card_id);
    if (!price) return [];
    return [
      {
        card_id: c.card_id,
        name: c.name,
        set_id: c.set_id,
        rarity: c.rarity,
        market_price_usd: price,
      },
    ];
  });
}

async function loadBots(): Promise<BotConfig[]> {
  const client = adminClient();
  const { data, error } = await client
    .from("bots")
    .select("bot_id, display_name, persona, model_provider, model_id, starting_cash_usd")
    .order("bot_id");
  if (error) throw error;
  return (data ?? []).map((b) => ({
    bot_id: b.bot_id,
    display_name: b.display_name,
    persona: b.persona,
    model_provider: b.model_provider,
    model_id: b.model_id,
  }));
}

async function loadBotState(
  botId: string,
  startingCash: number,
  pool: PoolCard[],
): Promise<BotState> {
  const client = adminClient();

  const { data: bot } = await client
    .from("bots")
    .select("display_name, persona")
    .eq("bot_id", botId)
    .single();

  // Sum all realized gains/losses from trades
  const { data: trades } = await client
    .from("trades")
    .select("action, price_usd")
    .eq("bot_id", botId)
    .neq("action", "pass");

  let cash = startingCash;
  for (const t of trades ?? []) {
    if (t.action === "buy") cash -= Number(t.price_usd ?? 0);
    if (t.action === "sell") cash += Number(t.price_usd ?? 0);
  }

  // Current holdings with market prices
  const { data: holdings } = await client
    .from("holdings")
    .select("card_id, buy_price_usd, cards(name)")
    .eq("bot_id", botId);

  const mappedHoldings = ((holdings ?? []) as unknown as Array<{
    card_id: string;
    buy_price_usd: number;
    cards: { name: string };
  }>).map((h) => {
    const card = pool.find((p) => p.card_id === h.card_id);
    return {
      card_id: h.card_id,
      name: h.cards?.name ?? "(unknown)",
      buy_price_usd: Number(h.buy_price_usd),
      current_market_price_usd: card?.market_price_usd ?? Number(h.buy_price_usd),
    };
  });

  return {
    bot_id: botId,
    display_name: bot?.display_name ?? botId,
    persona: bot?.persona ?? "",
    cash_usd: cash,
    holdings: mappedHoldings,
  };
}

async function loadPreviousNotes(
  botId: string,
  today: number,
): Promise<PreviousNotes | null> {
  const client = adminClient();
  const { data } = await client
    .from("bot_notes")
    .select("day, notes_for_tomorrow_md, watchlist_json, overall_strategy_md")
    .eq("bot_id", botId)
    .lt("day", today)
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

async function nextDayToSimulate(): Promise<number> {
  if (dayOverride) return parseInt(dayOverride, 10);
  const client = adminClient();
  const { data } = await client
    .from("round_runs")
    .select("day")
    .eq("status", "completed")
    .order("day", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data?.day ?? 0) + 1;
}

async function persistTurnResult(
  botConfig: BotConfig,
  state: BotState,
  plan: TradePlan,
  day: number,
  pool: PoolCard[],
  result: TurnResult,
): Promise<{ actionsApplied: number; error: string | null }> {
  const client = adminClient();
  let actionsApplied = 0;

  // 1. Write trades rows (one per action, plus a 'pass' row if no actions)
  type TradeRow = {
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
      bot_id: botConfig.bot_id,
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
      bot_id: botConfig.bot_id,
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
  const { error: tradeErr } = await client.from("trades").insert(tradeRows);
  if (tradeErr) return { actionsApplied: 0, error: `trades insert: ${tradeErr.message}` };

  // 2. Execute each action against holdings + cash
  let runningCash = state.cash_usd;
  for (const a of plan.actions) {
    const card = pool.find((p) => p.card_id === a.card_id);
    if (!card) continue;
    if (a.action === "buy") {
      runningCash -= card.market_price_usd;
      const { error } = await client.from("holdings").insert({
        bot_id: botConfig.bot_id,
        card_id: a.card_id,
        buy_price_usd: card.market_price_usd,
        bought_at_day: day,
      });
      if (error) return { actionsApplied, error: `holdings insert: ${error.message}` };
    } else if (a.action === "sell") {
      runningCash += card.market_price_usd;
      const { error } = await client
        .from("holdings")
        .delete()
        .eq("bot_id", botConfig.bot_id)
        .eq("card_id", a.card_id);
      if (error) return { actionsApplied, error: `holdings delete: ${error.message}` };
    }
    actionsApplied++;
  }

  // 3. Daily snapshot (cash + holdings valuation + rank placeholder)
  const { data: holdingsNow } = await client
    .from("holdings")
    .select("card_id, buy_price_usd")
    .eq("bot_id", botConfig.bot_id);
  const holdingsValue = (holdingsNow ?? []).reduce((sum, h) => {
    const card = pool.find((p) => p.card_id === h.card_id);
    return sum + (card?.market_price_usd ?? Number(h.buy_price_usd));
  }, 0);

  const { error: snapErr } = await client.from("daily_snapshots").upsert(
    {
      bot_id: botConfig.bot_id,
      day,
      cash_usd: Number(runningCash.toFixed(2)),
      holdings_value_usd: Number(holdingsValue.toFixed(2)),
      total_value_usd: Number((runningCash + holdingsValue).toFixed(2)),
      rank: null,
    },
    { onConflict: "bot_id,day" },
  );
  if (snapErr) return { actionsApplied, error: `snapshot: ${snapErr.message}` };

  // 4. bot_notes — write today's notes + watchlist for tomorrow
  const { error: notesErr } = await client.from("bot_notes").upsert(
    {
      bot_id: botConfig.bot_id,
      day,
      notes_for_tomorrow_md: plan.notes_for_tomorrow_md,
      watchlist_json: plan.watchlist,
      overall_strategy_md: plan.overall_strategy_md,
    },
    { onConflict: "bot_id,day" },
  );
  if (notesErr) return { actionsApplied, error: `bot_notes: ${notesErr.message}` };

  return { actionsApplied, error: null };
}

// ---------- Main ----------
async function main() {
  const day = await nextDayToSimulate();
  console.log(`🎲 simulate-day  —  Day ${day}\n`);

  // Verify keys
  if (!process.env.ANTHROPIC_API_KEY)
    console.warn("⚠️  ANTHROPIC_API_KEY missing — Claude will fail");
  if (!process.env.OPENAI_API_KEY)
    console.warn("⚠️  OPENAI_API_KEY missing — ChatGPT will fail");
  if (!process.env.XAI_API_KEY)
    console.warn("⚠️  XAI_API_KEY missing — Grok will fail");

  const client = adminClient();

  // Open the round
  const { error: roundErr } = await client.from("round_runs").insert({
    day,
    round_no: 1,
    actor: "cron",
    status: "running",
  });
  if (roundErr && !roundErr.message.includes("duplicate")) {
    console.error(`❌ round_runs insert: ${roundErr.message}`);
    process.exit(1);
  }

  const pool = await loadPool();
  const bots = await loadBots();
  const activeBots = onlyBot ? bots.filter((b) => b.bot_id === onlyBot) : bots;

  console.log(
    `📦 Pool: ${pool.length} cards  |  🤖 Bots: ${activeBots.map((b) => b.display_name).join(", ")}\n`,
  );

  // Load state + notes + run each bot concurrently
  type RunOutput = {
    bot: BotConfig;
    state: BotState;
    result: TurnResult;
    persistResult: { actionsApplied: number; error: string | null };
  };

  const t0 = Date.now();
  const settled = await Promise.allSettled(
    activeBots.map(async (bot) => {
      const startingCash = 1000.0;
      const state = await loadBotState(bot.bot_id, startingCash, pool);
      const previousNotes = await loadPreviousNotes(bot.bot_id, day);

      console.log(
        `▶️  ${bot.display_name} (${bot.model_provider}/${bot.model_id}) starting...`,
      );
      const result = await runTurn({
        botConfig: bot,
        state,
        pool,
        dayOfCompetition: day,
        previousNotes,
      });
      console.log(
        `   ✓ ${bot.display_name} done — ${result.plan.actions.length} actions, $${result.cost_usd.toFixed(4)}, ${result.step_count} steps, ${result.error ? `ERROR: ${result.error}` : "clean"}`,
      );

      const persistResult = await persistTurnResult(
        bot,
        state,
        result.plan,
        day,
        pool,
        result,
      );
      return { bot, state, result, persistResult };
    }),
  );
  const elapsed = Date.now() - t0;

  const outputs: RunOutput[] = [];
  for (let i = 0; i < settled.length; i++) {
    const r = settled[i];
    if (r.status === "fulfilled") {
      outputs.push(r.value);
    } else {
      const botName = activeBots[i]?.display_name ?? "(unknown)";
      const botId = activeBots[i]?.bot_id ?? "(unknown)";
      console.error(`\n💥 ${botName} (${botId}) THREW:`);
      console.error(`   ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`);
    }
  }

  // Close the round
  await client
    .from("round_runs")
    .update({ status: "completed", completed_at: new Date().toISOString() })
    .eq("day", day)
    .eq("round_no", 1);

  // ---------- Report ----------
  console.log("\n═══════════════════════════════════════════════════════════");
  console.log(`DAY ${day} ROUND COMPLETE  (elapsed ${(elapsed / 1000).toFixed(1)}s)`);
  console.log("═══════════════════════════════════════════════════════════\n");

  let totalCost = 0;
  for (const out of outputs) {
    console.log(`━━━ ${out.bot.display_name} (${out.bot.model_provider}/${out.bot.model_id}) ━━━`);
    console.log(`Start cash: $${out.state.cash_usd.toFixed(2)}  |  Holdings: ${out.state.holdings.length}/5`);
    console.log(`Actions this turn: ${out.result.plan.actions.length}`);
    for (const a of out.result.plan.actions) {
      const card = pool.find((p) => p.card_id === a.card_id);
      console.log(
        `  - ${a.action.toUpperCase().padEnd(4)} ${a.card_id.padEnd(12)} @ $${card?.market_price_usd.toFixed(2)}  ${card?.name ?? "?"}`,
      );
    }
    if (out.result.plan.actions.length === 0) console.log("  (pass — no actions)");
    console.log(`Watchlist (${out.result.plan.watchlist.length}):`);
    for (const w of out.result.plan.watchlist.slice(0, 3)) {
      console.log(
        `  ⊙ ${w.card_id.padEnd(12)} ${w.current_price_observed_usd !== undefined ? `@ $${w.current_price_observed_usd.toFixed(2)}` : ""}  trigger: ${w.trigger_to_buy_md.slice(0, 80)}`,
      );
    }
    if (out.result.plan.watchlist.length > 3)
      console.log(`  ... (+${out.result.plan.watchlist.length - 3} more)`);
    console.log(`Notes (first 200 chars): ${out.result.plan.notes_for_tomorrow_md.slice(0, 200)}...`);
    console.log(`Cost: $${out.result.cost_usd.toFixed(4)}  |  Tokens: ${out.result.tokens_in} in / ${out.result.tokens_out} out  |  Steps: ${out.result.step_count}`);
    if (out.result.error) console.log(`⚠️  ERROR: ${out.result.error}`);
    if (out.persistResult.error) console.log(`⚠️  PERSIST ERROR: ${out.persistResult.error}`);
    console.log("");
    totalCost += out.result.cost_usd;
  }

  // Leaderboard from daily_snapshots
  const { data: snaps } = await client
    .from("daily_snapshots")
    .select("bot_id, cash_usd, holdings_value_usd, total_value_usd")
    .eq("day", day)
    .order("total_value_usd", { ascending: false });
  console.log("📊 LEADERBOARD (Day", day, "close):");
  for (let i = 0; i < (snaps ?? []).length; i++) {
    const s = snaps![i];
    console.log(
      `  ${i + 1}. ${s.bot_id.padEnd(14)} $${s.total_value_usd.toFixed(2).padStart(9)}  (cash $${s.cash_usd.toFixed(2)} + holdings $${s.holdings_value_usd.toFixed(2)})`,
    );
  }

  console.log(`\n💰 Round total cost: $${totalCost.toFixed(4)}`);
  console.log(`✨ Day ${day} persisted. Notes saved for tomorrow.`);
}

main().catch((err) => {
  console.error("\n❌ Error:", err);
  process.exit(1);
});
