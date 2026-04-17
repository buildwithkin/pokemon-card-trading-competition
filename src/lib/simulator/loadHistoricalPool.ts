import { adminClient } from "@/lib/supabase/admin";
import type { PoolCard } from "@/lib/bots/runTurn";

/**
 * Returns the sorted distinct list of bucket_start_date values present in
 * price_buckets_canonical. The simulator uses this as its calendar: each sim
 * day advances to the next entry.
 *
 * TCGPlayer's detailed-history endpoint returns 3-day-wide buckets, but the
 * window phase is set by when we first scraped each card — two cards scraped
 * a day apart end up on two interleaved 3-day schedules. The distinct list
 * is therefore ~90 dates over 90 days (several interleaved cadences), not
 * the ~30 a shared calendar would give. Pricing on every date still works
 * because `pool_at_date` linearly interpolates between a card's enclosing
 * buckets (see loadHistoricalPool below). Supabase's default 1000-row cap
 * forces us to paginate; de-dupe in JS.
 */
export async function listAvailableBucketDates(): Promise<string[]> {
  const client = adminClient();
  const seen = new Set<string>();
  const step = 1000;
  let from = 0;
  while (true) {
    const { data, error } = await client
      .from("price_buckets_canonical")
      .select("bucket_start_date")
      .order("bucket_start_date", { ascending: true })
      .range(from, from + step - 1);
    if (error) throw new Error(`listAvailableBucketDates: ${error.message}`);
    if (!data || data.length === 0) break;
    for (const row of data) {
      if (typeof row.bucket_start_date === "string") {
        seen.add(row.bucket_start_date);
      }
    }
    if (data.length < step) break;
    from += step;
  }
  return [...seen].sort();
}

/**
 * Returns the pool of tradable cards at a specific historical date.
 *
 * Every card with at least one bucket gets a price, linearly interpolated
 * between the enclosing on-or-before and on-or-after `price_buckets_canonical`
 * rows (carry-forward/back at the edges). See migration 0009 for the SQL.
 *
 * This is why the function takes a single date and no carry-forward list:
 * pricing is always well-defined for every card, so bots can never reference
 * a card on day N that "doesn't exist" on day N+1 just because the buckets
 * for those two cards live on different 3-day phases.
 */
export async function loadHistoricalPool(
  bucketStartDate: string,
): Promise<PoolCard[]> {
  const client = adminClient();

  const { data: priced, error: rpcErr } = await client.rpc("pool_at_date", {
    target_date: bucketStartDate,
  });
  if (rpcErr) throw new Error(`loadHistoricalPool rpc: ${rpcErr.message}`);
  if (!priced || priced.length === 0) return [];

  const pricedRows = priced as Array<{
    card_id: string;
    market_price_usd: string | number;
    price_source: string;
  }>;
  const cardIds = pricedRows.map((r) => r.card_id);

  // Bulk-fetch metadata in chunks of 1000 (Postgres `IN (...)` limit via
  // PostgREST). Typical card universe is <1k so this is usually one query.
  const cardMeta = new Map<
    string,
    { name: string; set_id: string; rarity: string | null }
  >();
  const step = 1000;
  for (let i = 0; i < cardIds.length; i += step) {
    const slice = cardIds.slice(i, i + step);
    const { data, error } = await client
      .from("cards")
      .select("card_id, name, set_id, rarity")
      .in("card_id", slice);
    if (error) throw new Error(`loadHistoricalPool cards: ${error.message}`);
    for (const c of data ?? []) {
      cardMeta.set(c.card_id, {
        name: c.name,
        set_id: c.set_id,
        rarity: c.rarity,
      });
    }
  }

  const pool: PoolCard[] = [];
  for (const r of pricedRows) {
    const meta = cardMeta.get(r.card_id);
    if (!meta) continue;
    pool.push({
      card_id: r.card_id,
      name: meta.name,
      set_id: meta.set_id,
      rarity: meta.rarity,
      market_price_usd: Number(r.market_price_usd),
    });
  }
  return pool;
}
