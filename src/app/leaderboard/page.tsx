import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { serverClient } from "@/lib/supabase/server";
import {
  LeaderboardChart,
  type BotId,
  type ChartRow,
} from "@/components/leaderboard-chart";
import { RankTable, type RankRow } from "@/components/rank-table";
import { ModeSwitcher } from "@/components/mode-switcher";
import { CreateSimForm } from "@/components/create-sim-form";
import { NextDayButton } from "@/components/next-day-button";
import { DeleteSimButton } from "@/components/delete-sim-button";
import { LiveTurnFeed } from "@/components/live-turn-feed";
import {
  BotHoldings,
  type BotHoldingsRow,
  type HoldingCard,
} from "@/components/bot-holdings";
import { listAvailableBucketDates } from "@/lib/simulator/loadHistoricalPool";
import { isStuck } from "@/lib/simulator/simOrchestrator";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

const STARTING_USD = 1000;
const BOT_IDS: readonly BotId[] = ["claude", "chatgpt", "grok"];
const BOT_COLOR_CLASS: Record<BotId, string> = {
  claude: "text-neon-cyan",
  chatgpt: "text-emerald-400",
  grok: "text-neon-magenta",
};

type SnapshotRow = {
  bot_id: BotId;
  day: number;
  sim_bucket_date?: string | null;
  cash_usd: string | number;
  holdings_value_usd: string | number;
  total_value_usd: string | number;
};

type BotRow = { bot_id: BotId; display_name: string };

type SimRunRow = {
  run_id: string;
  start_bucket_date: string;
  duration_days: number;
  current_day: number;
  status: "paused" | "advancing" | "completed" | "failed";
  total_cost_usd: string | number;
  requested_at: string;
  last_heartbeat_at: string;
  completed_at: string | null;
  error_message: string | null;
};

type HoldingRow = {
  bot_id: BotId;
  card_id: string;
  buy_price_usd: string | number;
  bought_at_day: number;
  cards:
    | {
        name: string;
        set_id: string;
        number: string;
        rarity: string | null;
        image_url: string;
      }
    | null;
};

type TradeRow = {
  bot_id: BotId;
  day: number;
  decision_index: number;
  action: "buy" | "sell" | "pass";
  card_id: string | null;
  price_usd: string | number | null;
  reasoning_md: string;
  llm_cost_usd: string | number | null;
};

const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});

function toNumber(v: string | number | null | undefined): number {
  if (v === null || v === undefined) return 0;
  return typeof v === "number" ? v : Number(v);
}

function isUuid(v: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}

type PageProps = {
  searchParams: Promise<{ sim?: string | string[] }>;
};

/**
 * Unified leaderboard: live competition by default, simulation mode via
 * ?sim=<run_id> (or ?sim=new to create one). Same chart + rank table
 * components render for both, so the visual language is identical.
 */
export default async function LeaderboardPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const simParamRaw = params.sim;
  const simParam =
    typeof simParamRaw === "string"
      ? simParamRaw
      : Array.isArray(simParamRaw)
        ? simParamRaw[0]
        : undefined;

  const simEnabled = process.env.NEXT_PUBLIC_ENABLE_SIMULATOR === "true";

  // Gate: if simulator is disabled and the URL asks for it, drop to live.
  if (simParam && !simEnabled) {
    redirect("/leaderboard");
  }

  const mode: "live" | "sim" = simParam ? "sim" : "live";

  return (
    <main className="mx-auto max-w-6xl space-y-6 p-4 sm:p-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-3xl font-bold tracking-tight text-foreground">
            Leaderboard
          </h1>
          <p className="text-sm text-muted-foreground">
            {mode === "live"
              ? "Live competition — portfolio value per bot, end-of-day snapshots."
              : "Simulation — step through historical price buckets, watch the bots react."}
          </p>
        </div>
        {simEnabled && <ModeSwitcher currentMode={mode} />}
      </header>

      {mode === "live" ? (
        <LiveLeaderboardView />
      ) : simParam === "new" || simParam === "NEW" ? (
        <SimStartView />
      ) : simParam && isUuid(simParam) ? (
        <SimRunView runId={simParam} />
      ) : (
        // Any other ?sim=... value: redirect to the picker.
        <SimStartView invalidParam={simParam} />
      )}
    </main>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// LIVE MODE
// ═══════════════════════════════════════════════════════════════════════════

async function LiveLeaderboardView() {
  const client = serverClient();
  const [snapsRes, botsRes, holdingsRes, pricesRes] = await Promise.all([
    client
      .from("daily_snapshots")
      .select("bot_id, day, cash_usd, holdings_value_usd, total_value_usd")
      .order("day", { ascending: true }),
    client.from("bots").select("bot_id, display_name"),
    client
      .from("holdings")
      .select(
        "bot_id, card_id, buy_price_usd, bought_at_day, cards(name, set_id, number, rarity, image_url)",
      ),
    client
      .from("prices")
      .select("card_id, market_price_usd, captured_at")
      .order("captured_at", { ascending: false }),
  ]);

  const snapshots = (snapsRes.data as SnapshotRow[] | null) ?? [];
  const bots = (botsRes.data as BotRow[] | null) ?? [];
  const holdings = (holdingsRes.data as HoldingRow[] | null) ?? [];
  const pricesLatest = new Map<string, number>();
  for (const p of (pricesRes.data as
    | Array<{ card_id: string; market_price_usd: string | number }>
    | null) ?? []) {
    if (!pricesLatest.has(p.card_id)) {
      pricesLatest.set(p.card_id, toNumber(p.market_price_usd));
    }
  }
  const botName = new Map<BotId, string>(
    bots.map((b) => [b.bot_id, b.display_name]),
  );
  const holdingsRows = buildHoldingsRows(
    holdings,
    BOT_IDS,
    botName,
    (cardId) => pricesLatest.get(cardId) ?? null,
  );

  const pivoted = new Map<number, ChartRow>();
  for (let d = 1; d <= 7; d++) pivoted.set(d, { day: d });
  for (const r of snapshots) {
    const row = pivoted.get(r.day);
    if (!row) continue;
    row[r.bot_id] = toNumber(r.total_value_usd);
  }
  const rows = [...pivoted.values()];
  const hasData = snapshots.length > 0;

  let latestRanks: RankRow[] = [];
  if (hasData) {
    const latestDay = Math.max(...snapshots.map((s) => s.day));
    const latest = snapshots.filter((s) => s.day === latestDay);
    latestRanks = latest
      .map<RankRow>((s) => ({
        bot_id: s.bot_id,
        display_name: botName.get(s.bot_id) ?? s.bot_id,
        cash: toNumber(s.cash_usd),
        holdings: toNumber(s.holdings_value_usd),
        total: toNumber(s.total_value_usd),
        delta: toNumber(s.total_value_usd) - STARTING_USD,
      }))
      .sort((a, b) => b.total - a.total);
  }

  return (
    <>
      <LeaderboardChart rows={rows} hasData={hasData} />
      {hasData ? (
        <RankTable rows={latestRanks} />
      ) : (
        <EmptyRoster botName={botName} />
      )}
      <BotHoldings rows={holdingsRows} />
    </>
  );
}

function buildHoldingsRows(
  holdings: HoldingRow[],
  botIds: readonly BotId[],
  botName: Map<BotId, string>,
  marketPriceFor: (cardId: string) => number | null,
): BotHoldingsRow[] {
  const byBot = new Map<BotId, HoldingCard[]>();
  for (const id of botIds) byBot.set(id, []);
  for (const h of holdings) {
    const list = byBot.get(h.bot_id);
    if (!list || !h.cards) continue;
    list.push({
      card_id: h.card_id,
      name: h.cards.name,
      set_id: h.cards.set_id,
      number: h.cards.number,
      rarity: h.cards.rarity,
      image_url: h.cards.image_url,
      buy_price_usd: toNumber(h.buy_price_usd),
      bought_at_day: h.bought_at_day,
      market_price_usd: marketPriceFor(h.card_id),
    });
  }
  for (const list of byBot.values()) {
    list.sort((a, b) => a.bought_at_day - b.bought_at_day);
  }
  return botIds.map((id) => ({
    bot_id: id,
    display_name: botName.get(id) ?? id,
    cards: byBot.get(id) ?? [],
  }));
}

function EmptyRoster({ botName }: { botName: Map<BotId, string> }) {
  return (
    <div className="rounded-lg border border-border/40 bg-card/50 p-4">
      <div className="mb-2 text-xs uppercase tracking-wide text-muted-foreground">
        Roster — starting $1,000 each
      </div>
      <ul className="flex flex-wrap gap-3 text-sm">
        {BOT_IDS.map((id) => (
          <li
            key={id}
            className={cn(
              "rounded-md border border-border/40 bg-background/40 px-3 py-1.5 font-semibold",
              BOT_COLOR_CLASS[id],
            )}
          >
            {botName.get(id) ?? id}
          </li>
        ))}
      </ul>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// SIM MODE — picker + start form
// ═══════════════════════════════════════════════════════════════════════════

async function SimStartView({ invalidParam }: { invalidParam?: string } = {}) {
  const available = await listAvailableBucketDates();
  const client = serverClient();
  const { data: runs } = await client
    .from("sim_runs")
    .select(
      "run_id, start_bucket_date, duration_days, current_day, status, total_cost_usd, requested_at",
    )
    .order("requested_at", { ascending: false })
    .limit(12);
  const runList =
    (runs as Pick<
      SimRunRow,
      | "run_id"
      | "start_bucket_date"
      | "duration_days"
      | "current_day"
      | "status"
      | "total_cost_usd"
      | "requested_at"
    >[] | null) ?? [];

  return (
    <>
      {invalidParam && (
        <p className="rounded-md border border-rose-400/40 bg-rose-400/10 px-3 py-2 text-xs text-rose-300">
          Unknown simulation <code className="font-mono">{invalidParam}</code>.
        </p>
      )}

      <section className="rounded-lg border border-border/40 bg-card/50 p-5">
        <h2 className="mb-4 text-lg font-semibold text-foreground">
          Start a new simulation
        </h2>
        {available.length === 0 ? (
          <p className="text-sm text-rose-300">
            No price buckets available. Run{" "}
            <code className="rounded bg-background/60 px-1 py-0.5 text-xs">
              bun run seed:history
            </code>{" "}
            first.
          </p>
        ) : (
          <CreateSimForm availableBuckets={available} />
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold text-foreground">Recent runs</h2>
        {runList.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No simulations yet. Start one above.
          </p>
        ) : (
          <ul className="grid gap-2 sm:grid-cols-2">
            {runList.map((r) => (
              <li key={r.run_id} className="relative">
                <Link
                  href={`/leaderboard?sim=${r.run_id}`}
                  className="flex items-center justify-between gap-4 rounded-md border border-border/40 bg-card/40 px-4 py-3 pr-24 text-sm transition hover:border-border hover:bg-card"
                >
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <div className="truncate font-mono text-foreground">
                      {r.start_bucket_date}
                      <span className="text-muted-foreground"> · </span>
                      <span className="text-muted-foreground">
                        day {r.current_day}/{r.duration_days}
                      </span>
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {new Date(r.requested_at).toLocaleString()} · cost{" "}
                      {usd.format(toNumber(r.total_cost_usd))}
                    </div>
                  </div>
                  <SimStatusPill status={r.status} />
                </Link>
                <div className="absolute right-2 top-1/2 -translate-y-1/2">
                  <DeleteSimButton runId={r.run_id} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

function SimStatusPill({ status }: { status: SimRunRow["status"] }) {
  const className =
    status === "paused"
      ? "border-neon-cyan/40 bg-neon-cyan/10 text-neon-cyan"
      : status === "advancing"
        ? "border-amber-400/40 bg-amber-400/10 text-amber-300"
        : status === "completed"
          ? "border-emerald-400/40 bg-emerald-400/10 text-emerald-300"
          : "border-rose-400/40 bg-rose-400/10 text-rose-300";
  return (
    <span
      className={cn(
        "shrink-0 rounded-full border px-2.5 py-0.5 text-[10px] font-mono font-semibold uppercase tracking-wider",
        className,
      )}
    >
      {status}
    </span>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// SIM MODE — active run view
// ═══════════════════════════════════════════════════════════════════════════

async function SimRunView({ runId }: { runId: string }) {
  const client = serverClient();
  const [runRes, snapsRes, tradesRes, botsRes, holdingsRes] = await Promise.all([
    client.from("sim_runs").select("*").eq("run_id", runId).maybeSingle(),
    client
      .from("sim_daily_snapshots")
      .select(
        "bot_id, day, sim_bucket_date, cash_usd, holdings_value_usd, total_value_usd",
      )
      .eq("run_id", runId)
      .order("day", { ascending: true }),
    client
      .from("sim_trades")
      .select(
        "bot_id, day, decision_index, action, card_id, price_usd, reasoning_md, llm_cost_usd",
      )
      .eq("run_id", runId)
      .order("day", { ascending: true })
      .order("decision_index", { ascending: true }),
    client.from("bots").select("bot_id, display_name"),
    client
      .from("sim_holdings")
      .select(
        "bot_id, card_id, buy_price_usd, bought_at_day, cards(name, set_id, number, rarity, image_url)",
      )
      .eq("run_id", runId),
  ]);

  // Pre-fetch current day's events for the live feed (SSR'd first paint).
  // We do this after we know run.current_day below, so defer to after the
  // main run row is validated.

  const run = runRes.data as SimRunRow | null;
  if (!run) notFound();

  const snaps = (snapsRes.data as SnapshotRow[] | null) ?? [];
  const trades = (tradesRes.data as TradeRow[] | null) ?? [];
  const bots = (botsRes.data as BotRow[] | null) ?? [];
  const simHoldings = (holdingsRes.data as HoldingRow[] | null) ?? [];
  const botName = new Map<BotId, string>(
    bots.map((b) => [b.bot_id, b.display_name]),
  );

  const pivoted = new Map<number, ChartRow>();
  for (let d = 0; d <= run.duration_days; d++) pivoted.set(d, { day: d });
  for (const s of snaps) {
    const row = pivoted.get(s.day);
    if (!row) continue;
    row[s.bot_id] = toNumber(s.total_value_usd);
  }
  const rows = [...pivoted.values()];
  const hasData = snaps.some((s) => s.day > 0);

  const latestByBot = new Map<BotId, SnapshotRow>();
  for (const s of snaps) {
    const prev = latestByBot.get(s.bot_id);
    if (!prev || s.day > prev.day) latestByBot.set(s.bot_id, s);
  }
  const rankRows: RankRow[] = [...latestByBot.values()]
    .map<RankRow>((s) => ({
      bot_id: s.bot_id,
      display_name: botName.get(s.bot_id) ?? s.bot_id,
      cash: toNumber(s.cash_usd),
      holdings: toNumber(s.holdings_value_usd),
      total: toNumber(s.total_value_usd),
      delta: toNumber(s.total_value_usd) - STARTING_USD,
    }))
    .sort((a, b) => b.total - a.total);

  const stuck = isStuck(run.status, run.last_heartbeat_at);
  const latestBucketDate = snaps
    .filter((s) => s.sim_bucket_date)
    .slice(-1)[0]?.sim_bucket_date;

  const simMarketPrices = new Map<string, number>();
  if (latestBucketDate && simHoldings.length > 0) {
    const { data: priced } = await client.rpc("pool_at_date", {
      target_date: latestBucketDate,
    });
    for (const p of (priced as
      | Array<{ card_id: string; market_price_usd: string | number }>
      | null) ?? []) {
      simMarketPrices.set(p.card_id, toNumber(p.market_price_usd));
    }
  }
  const simHoldingsRows = buildHoldingsRows(
    simHoldings,
    BOT_IDS,
    botName,
    (cardId) => simMarketPrices.get(cardId) ?? null,
  );

  // Live-feed day: if advancing, it's the day being worked on (current_day+1);
  // otherwise show the most recent completed day's events for replay.
  const feedDay =
    run.status === "advancing" ? run.current_day + 1 : run.current_day;
  let initialEvents: Array<{
    event_id: number;
    bot_id: BotId;
    day: number;
    step_index: number;
    event_type:
      | "turn_start"
      | "tool_call"
      | "tool_result"
      | "step_finish"
      | "turn_done"
      | "error";
    tool_name: string | null;
    payload: Record<string, unknown>;
    created_at: string;
  }> = [];
  if (feedDay >= 1) {
    const { data: eventData } = await client
      .from("sim_turn_events")
      .select(
        "event_id, bot_id, day, step_index, event_type, tool_name, payload, created_at",
      )
      .eq("run_id", runId)
      .eq("day", feedDay)
      .order("event_id", { ascending: true })
      .limit(500);
    initialEvents = (eventData ?? []) as typeof initialEvents;
  }

  const advanceDisabled =
    run.status !== "paused" || run.current_day >= run.duration_days;
  const disabledReason =
    run.status === "completed"
      ? "This simulation is complete."
      : run.status === "failed"
        ? "This simulation failed."
        : run.status === "advancing" && !stuck
          ? "Bots are running the current day — hold tight."
          : stuck
            ? "Simulation is stuck (no heartbeat in 2+ min). Reset needed."
            : null;

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border/30 bg-card/30 px-4 py-3 text-sm">
        <div className="flex items-center gap-3">
          <Link
            href="/leaderboard?sim=new"
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            ← All simulations
          </Link>
          <span className="font-mono text-xs text-muted-foreground">
            {run.run_id.slice(0, 8)}
          </span>
          <DeleteSimButton
            runId={run.run_id}
            variant="prominent"
            redirectTo="/leaderboard?sim=new"
            label="Delete sim"
          />
        </div>
        <div className="flex flex-wrap items-center gap-4 text-xs">
          <span className="font-mono text-muted-foreground">
            Start {run.start_bucket_date}
          </span>
          <span className="font-mono text-muted-foreground">
            Day {run.current_day}/{run.duration_days}
            {latestBucketDate ? ` · ${latestBucketDate}` : ""}
          </span>
          <span className="font-mono text-muted-foreground">
            Cost {usd.format(toNumber(run.total_cost_usd))}
          </span>
          <SimStatusPill status={stuck ? "failed" : run.status} />
        </div>
      </div>

      {run.error_message && (
        <div className="rounded-md border border-rose-400/40 bg-rose-400/10 px-4 py-3 text-sm text-rose-300">
          <strong className="font-mono">Error:</strong> {run.error_message}
        </div>
      )}

      <LeaderboardChart rows={rows} hasData={hasData} />

      <div className="flex items-center justify-center py-2">
        <NextDayButton
          runId={run.run_id}
          disabled={advanceDisabled}
          disabledReason={disabledReason}
        />
      </div>

      {feedDay >= 1 && (
        <LiveTurnFeed
          runId={run.run_id}
          day={feedDay}
          status={run.status}
          initialEvents={initialEvents}
        />
      )}

      {hasData ? (
        <RankTable rows={rankRows} />
      ) : (
        <SimEmptyRoster botName={botName} />
      )}

      <BotHoldings rows={simHoldingsRows} />

      <TradeLog trades={trades} botName={botName} />
    </>
  );
}

function SimEmptyRoster({ botName }: { botName: Map<BotId, string> }) {
  return (
    <div className="rounded-lg border border-border/40 bg-card/50 p-4">
      <div className="mb-2 text-xs uppercase tracking-wide text-muted-foreground">
        Roster — starting $1,000 each · click Next Day to run day 1
      </div>
      <ul className="flex flex-wrap gap-3 text-sm">
        {BOT_IDS.map((id) => (
          <li
            key={id}
            className={cn(
              "rounded-md border border-border/40 bg-background/40 px-3 py-1.5 font-semibold",
              BOT_COLOR_CLASS[id],
            )}
          >
            {botName.get(id) ?? id}
          </li>
        ))}
      </ul>
    </div>
  );
}

function TradeLog({
  trades,
  botName,
}: {
  trades: TradeRow[];
  botName: Map<BotId, string>;
}) {
  if (trades.length === 0) return null;
  const byDay = new Map<number, TradeRow[]>();
  for (const t of trades) {
    const arr = byDay.get(t.day) ?? [];
    arr.push(t);
    byDay.set(t.day, arr);
  }
  const days = [...byDay.keys()].sort((a, b) => b - a);

  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold text-foreground">Trade log</h2>
      <div className="space-y-3">
        {days.map((day) => (
          <details
            key={day}
            className="rounded-lg border border-border/40 bg-card/40"
            open={day === days[0]}
          >
            <summary className="cursor-pointer px-4 py-2.5 text-sm font-semibold text-foreground">
              Day {day}
              <span className="ml-2 font-normal text-muted-foreground">
                ({byDay.get(day)!.length} action
                {byDay.get(day)!.length === 1 ? "" : "s"})
              </span>
            </summary>
            <ul className="divide-y divide-border/20">
              {byDay
                .get(day)!
                .sort((a, b) => {
                  if (a.bot_id !== b.bot_id)
                    return a.bot_id.localeCompare(b.bot_id);
                  return a.decision_index - b.decision_index;
                })
                .map((t, i) => (
                  <li
                    key={`${t.bot_id}-${t.decision_index}-${i}`}
                    className="px-4 py-3 text-sm"
                  >
                    <div className="mb-1 flex items-center gap-2 text-xs">
                      <span
                        className={cn(
                          "font-mono font-semibold uppercase tracking-wider",
                          BOT_COLOR_CLASS[t.bot_id],
                        )}
                      >
                        {botName.get(t.bot_id) ?? t.bot_id}
                      </span>
                      <span
                        className={cn(
                          "rounded-sm px-1.5 py-0.5 font-mono uppercase",
                          t.action === "buy"
                            ? "bg-emerald-400/15 text-emerald-300"
                            : t.action === "sell"
                              ? "bg-rose-400/15 text-rose-300"
                              : "bg-muted/40 text-muted-foreground",
                        )}
                      >
                        {t.action}
                      </span>
                      {t.card_id && (
                        <span className="font-mono text-muted-foreground">
                          {t.card_id}
                          {t.price_usd !== null
                            ? ` @ ${usd.format(toNumber(t.price_usd))}`
                            : ""}
                        </span>
                      )}
                      {t.llm_cost_usd !== null && (
                        <span className="ml-auto font-mono text-[11px] text-muted-foreground">
                          cost {usd.format(toNumber(t.llm_cost_usd))}
                        </span>
                      )}
                    </div>
                    <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-foreground/90">
                      {t.reasoning_md}
                    </p>
                  </li>
                ))}
            </ul>
          </details>
        ))}
      </div>
    </section>
  );
}
