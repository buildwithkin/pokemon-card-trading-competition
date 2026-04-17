import { NextRequest, NextResponse } from "next/server";
import { serverClient } from "@/lib/supabase/server";

/**
 * Returns the data the card chart modal needs:
 *   - `daily_snapshot`: today's pokemontcg.io row from `prices` — used as the
 *     "live" anchor (latest known price for the price-changed-today readout).
 *   - `history`: a per-day price series, one row per calendar day. The line
 *     comes from `prices` (genuine daily snapshot OR backfilled-from-buckets
 *     interpolated row, both stored in the same table). On dates that hit a
 *     real `price_buckets_canonical` bucket, we additionally attach the
 *     bucket's low/high/quantity/trades so the tooltip can show real trade
 *     context. `source` tells the chart how each point was derived:
 *       tcgplayer            — pokemontcg.io daily snapshot
 *       bucket_exact         — backfill: target day landed on a real bucket
 *       bucket_interpolated  — backfill: between two enclosing buckets
 *       bucket_carry_forward — backfill: past the latest bucket
 *       bucket_carry_back    — backfill: before the earliest bucket
 */
export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ cardId: string }> },
) {
  const { cardId } = await ctx.params;
  const client = serverClient();

  const [pricesRes, bucketsRes] = await Promise.all([
    client
      .from("prices")
      .select(
        "captured_at, market_price_usd, low_price_usd, high_price_usd, source, is_stale",
      )
      .eq("card_id", cardId)
      .order("captured_at", { ascending: true }),
    client
      .from("price_buckets_canonical")
      .select(
        "bucket_start_date, low_sale_usd, high_sale_usd, quantity_sold, transaction_count, condition, variant",
      )
      .eq("card_id", cardId)
      .order("bucket_start_date", { ascending: true }),
  ]);

  if (pricesRes.error) {
    return NextResponse.json({ error: pricesRes.error.message }, { status: 500 });
  }
  if (bucketsRes.error) {
    return NextResponse.json({ error: bucketsRes.error.message }, { status: 500 });
  }

  // Index bucket metadata by date for the merge below. price_buckets_canonical
  // already collapses to one row per (card, bucket_start_date) via DISTINCT ON.
  const bucketByDate = new Map<
    string,
    {
      low: number | null;
      high: number | null;
      quantity: number;
      trades: number;
      condition: string;
      variant: string;
    }
  >();
  for (const b of bucketsRes.data ?? []) {
    bucketByDate.set(b.bucket_start_date, {
      low: b.low_sale_usd !== null ? Number(b.low_sale_usd) : null,
      high: b.high_sale_usd !== null ? Number(b.high_sale_usd) : null,
      quantity: b.quantity_sold,
      trades: b.transaction_count,
      condition: b.condition,
      variant: b.variant,
    });
  }

  const history = (pricesRes.data ?? []).map((r) => {
    const bucket = bucketByDate.get(r.captured_at);
    return {
      date: r.captured_at,
      price: Number(r.market_price_usd),
      source: r.source,
      // Prefer bucket-level low/high (real trade extremes inside a 3-day
      // window) over the pokemontcg.io daily low/high (a single observation).
      low:
        bucket?.low ??
        (r.low_price_usd !== null ? Number(r.low_price_usd) : null),
      high:
        bucket?.high ??
        (r.high_price_usd !== null ? Number(r.high_price_usd) : null),
      quantity: bucket?.quantity ?? 0,
      trades: bucket?.trades ?? 0,
      condition: bucket?.condition ?? null,
      variant: bucket?.variant ?? null,
    };
  });

  const last = history.length > 0 ? history[history.length - 1] : null;

  return NextResponse.json({
    daily_snapshot: last
      ? {
          date: last.date,
          price: last.price,
          low: last.low,
          high: last.high,
          stale: false,
        }
      : null,
    history,
  });
}
