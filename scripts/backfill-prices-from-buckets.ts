#!/usr/bin/env bun
/**
 * Backfill the `prices` table from the existing `price_buckets` history by
 * sampling `pool_at_date()` once per calendar day. Result: a real per-day,
 * per-card price series synthesized from the same curve we'd plot on a chart
 * (linear interp between enclosing buckets, carry-forward/back at edges).
 *
 * Each backfilled row is tagged with a source describing how its price was
 * derived, so you can later filter "real bucket day" vs interpolated:
 *   - bucket_exact         — target day landed on a real bucket
 *   - bucket_interpolated  — between two enclosing buckets
 *   - bucket_carry_forward — past the latest bucket for that card
 *   - bucket_carry_back    — before the earliest bucket for that card
 *
 * Idempotent. PK is (card_id, captured_at) and we upsert with
 * ignoreDuplicates, so existing rows (genuine daily snapshots from
 * seed:pool, or prior backfills) are never overwritten.
 *
 * Usage:
 *   bun run scripts/backfill-prices-from-buckets.ts          # last 30 days
 *   bun run scripts/backfill-prices-from-buckets.ts --days 90
 *   bun run scripts/backfill-prices-from-buckets.ts --start 2026-01-17 --end 2026-04-16
 */
import { adminClient } from "../src/lib/supabase/admin";

const args = process.argv.slice(2);
function getArg(flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : undefined;
}

const DAYS = parseInt(getArg("--days") ?? "30", 10);
const START = getArg("--start");
const END = getArg("--end");

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function dateRange(): string[] {
  if (START && END) {
    const out: string[] = [];
    const cursor = new Date(`${START}T00:00:00Z`);
    const end = new Date(`${END}T00:00:00Z`);
    while (cursor <= end) {
      out.push(isoDay(cursor));
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    return out;
  }
  // Default: yesterday back DAYS days. Today is left alone — seed:pool
  // writes today's genuine snapshot via the daily cron.
  const out: string[] = [];
  const cursor = new Date();
  cursor.setUTCDate(cursor.getUTCDate() - 1);
  for (let i = 0; i < DAYS; i++) {
    out.push(isoDay(cursor));
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  return out.reverse();
}

const SOURCE_BY_PRICE_SOURCE: Record<string, string> = {
  exact: "bucket_exact",
  interpolated: "bucket_interpolated",
  carry_forward: "bucket_carry_forward",
  carry_back: "bucket_carry_back",
};

async function backfillOneDay(day: string): Promise<{
  written: number;
  skipped: number;
  bySource: Record<string, number>;
}> {
  const c = adminClient();
  const { data, error } = await c.rpc("pool_at_date", { target_date: day });
  if (error) throw new Error(`pool_at_date(${day}): ${error.message}`);

  const rows = (data ?? []) as Array<{
    card_id: string;
    market_price_usd: string | number;
    price_source: string;
  }>;

  const bySource: Record<string, number> = {};
  for (const r of rows) {
    bySource[r.price_source] = (bySource[r.price_source] ?? 0) + 1;
  }

  const upsertRows = rows.map((r) => ({
    card_id: r.card_id,
    captured_at: day,
    market_price_usd: Number(r.market_price_usd),
    source: SOURCE_BY_PRICE_SOURCE[r.price_source] ?? "bucket_unknown",
  }));

  // ignoreDuplicates: never overwrite a genuine snapshot (or a prior
  // backfill row) — the PK (card_id, captured_at) keeps things stable.
  const step = 1000;
  let written = 0;
  for (let i = 0; i < upsertRows.length; i += step) {
    const slice = upsertRows.slice(i, i + step);
    const { error: upErr, count } = await c
      .from("prices")
      .upsert(slice, {
        onConflict: "card_id,captured_at",
        ignoreDuplicates: true,
        count: "exact",
      });
    if (upErr) throw new Error(`upsert ${day}: ${upErr.message}`);
    written += count ?? 0;
  }

  return { written, skipped: upsertRows.length - written, bySource };
}

const days = dateRange();
console.log(
  `Backfilling ${days.length} days: ${days[0]} → ${days[days.length - 1]}`,
);

let totalWritten = 0;
let totalSkipped = 0;
const totalBySource: Record<string, number> = {};

for (const day of days) {
  const { written, skipped, bySource } = await backfillOneDay(day);
  totalWritten += written;
  totalSkipped += skipped;
  for (const [k, v] of Object.entries(bySource)) {
    totalBySource[k] = (totalBySource[k] ?? 0) + v;
  }
  const sourceTag = Object.entries(bySource)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
  console.log(
    `  ${day}  written=${written}  skipped=${skipped}  (${sourceTag})`,
  );
}

console.log(
  `\nDone. ${totalWritten} rows written, ${totalSkipped} already existed.`,
);
console.log("price_source totals:", totalBySource);
