#!/usr/bin/env bun
/**
 * Quick read-only coverage report for the two price-data sources.
 *
 *   prices         — daily pokemontcg.io snapshot (current market price).
 *   price_buckets  — 3-month TCGPlayer detailed-history buckets (trade data).
 *
 * Answers, per card:
 *   - does it have today's daily snapshot?
 *   - how many distinct bucket days of trade history does it have?
 *   - which cards are still missing a backfill?
 */
import { adminClient } from "../src/lib/supabase/admin";

async function main() {
  const client = adminClient();

  const { data: allCards, error: e1 } = await client
    .from("cards")
    .select("card_id, name, set_id, number, rarity, tcgplayer_url")
    .order("name");
  if (e1) throw e1;

  const { data: priceRows, error: e2 } = await client
    .from("prices")
    .select("card_id");
  if (e2) throw e2;

  const dailyCountByCard = new Map<string, number>();
  for (const r of priceRows ?? []) {
    dailyCountByCard.set(
      r.card_id,
      (dailyCountByCard.get(r.card_id) ?? 0) + 1,
    );
  }

  // Aggregate bucket coverage per card by pulling (card_id, bucket_start_date)
  // and deduping in-memory. Supabase REST has no group-by — a bounded pull is
  // fine at ~250k rows (the 3M bucket projection).
  const bucketDaysByCard = new Map<string, Set<string>>();
  {
    let from = 0;
    const step = 1000;
    while (true) {
      const { data, error } = await client
        .from("price_buckets")
        .select("card_id, bucket_start_date")
        .range(from, from + step - 1);
      if (error) throw error;
      if (!data || data.length === 0) break;
      for (const r of data) {
        if (!bucketDaysByCard.has(r.card_id))
          bucketDaysByCard.set(r.card_id, new Set());
        bucketDaysByCard.get(r.card_id)!.add(r.bucket_start_date);
      }
      if (data.length < step) break;
      from += step;
    }
  }

  const noDaily: typeof allCards = [];
  const noHistory: typeof allCards = [];
  const partialHistory: typeof allCards = [];
  const fullHistory: typeof allCards = [];
  for (const c of allCards) {
    const daily = dailyCountByCard.get(c.card_id) ?? 0;
    const buckets = bucketDaysByCard.get(c.card_id)?.size ?? 0;
    if (daily === 0) noDaily.push(c);
    if (buckets === 0) noHistory.push(c);
    else if (buckets < 20) partialHistory.push(c);
    else fullHistory.push(c);
  }

  console.log(`Total cards:                ${allCards.length}`);
  console.log(`  Missing daily snapshot:   ${noDaily.length}`);
  console.log(`  Missing history entirely: ${noHistory.length}`);
  console.log(`  Partial history (<20 d):  ${partialHistory.length}`);
  console.log(`  Full history (>=20 d):    ${fullHistory.length}`);
  const missingUrl = allCards.filter((c) => !c.tcgplayer_url).length;
  console.log(`\nCards missing tcgplayer_url: ${missingUrl}`);

  if (noHistory.length > 0) {
    console.log("\nCards with NO TCGPlayer bucket history:");
    for (const c of noHistory.slice(0, 50)) {
      console.log(
        `  ${c.card_id.padEnd(14)} ${c.name.padEnd(32)} ${(c.rarity ?? "-").padEnd(28)} ${c.set_id}/${c.number}`,
      );
    }
    if (noHistory.length > 50) {
      console.log(`  ... and ${noHistory.length - 50} more`);
    }
  }
  if (partialHistory.length > 0) {
    console.log("\nCards with PARTIAL history (<20 distinct bucket days):");
    for (const c of partialHistory.slice(0, 30)) {
      const n = bucketDaysByCard.get(c.card_id)?.size ?? 0;
      console.log(
        `  ${c.card_id.padEnd(14)} ${String(n).padStart(3)} days  ${c.name.padEnd(32)} ${c.set_id}/${c.number}`,
      );
    }
    if (partialHistory.length > 30) {
      console.log(`  ... and ${partialHistory.length - 30} more`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
