#!/usr/bin/env bun
/**
 * Sanity-check that migration 0004 landed:
 * - price_buckets table exists and is queryable
 * - tcgplayer_scrape rows have been deleted from prices
 */
import { adminClient } from "../src/lib/supabase/admin";

const c = adminClient();

const { count: bucketCount, error: bErr } = await c
  .from("price_buckets")
  .select("*", { count: "exact", head: true });
if (bErr) {
  console.log("ERROR querying price_buckets:", bErr.message);
  process.exit(1);
}
console.log("price_buckets rows:           ", bucketCount);

const { count: staleCount, error: sErr } = await c
  .from("prices")
  .select("*", { count: "exact", head: true })
  .eq("source", "tcgplayer_scrape");
if (sErr) {
  console.log("ERROR querying prices:", sErr.message);
  process.exit(1);
}
console.log("stale tcgplayer_scrape rows:  ", staleCount);

const { count: dailyCount } = await c
  .from("prices")
  .select("*", { count: "exact", head: true })
  .eq("source", "tcgplayer");
console.log("daily tcgplayer rows (intact):", dailyCount);
