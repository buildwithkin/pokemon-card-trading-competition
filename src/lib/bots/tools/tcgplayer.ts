import { tool } from "ai";
import { z } from "zod";
import { adminClient } from "@/lib/supabase/admin";

/**
 * Shared tool: look up authoritative TCGPlayer pricing + liquidity for one card.
 *
 * Returns:
 *   - current_* : today's pokemontcg.io market/low/high (from `prices`)
 *   - recent_activity[] : last 14 days from `price_buckets`, one entry per
 *     (condition, variant) — market price, trade low/high, quantity sold,
 *     transaction count — so the bot can reason about liquidity and spread,
 *     not just price level.
 *   - tcgplayer_url : direct link to the TCGPlayer product page.
 *
 * Available to: Claude, ChatGPT, Grok.
 */
export const getTcgplayerDataTool = tool({
  description:
    "Look up authoritative TCGPlayer pricing for a specific card by card_id. Returns: " +
    "(a) today's market/low/high from pokemontcg.io, (b) the last 14 days of " +
    "per-(condition, variant) activity — market price, trade low/high, quantity_sold, " +
    "transaction_count — so you can judge liquidity and spread, not just price. " +
    "Also returns a direct TCGPlayer URL for deeper fetch with your web-search tool.",
  inputSchema: z.object({
    card_id: z
      .string()
      .describe("pokemontcg.io card_id like 'me2-125' or 'sv8pt5-161'"),
  }),
  execute: async ({ card_id }) => {
    const client = adminClient();
    const { data: card, error: cardErr } = await client
      .from("cards")
      .select("card_id, name, set_id, set_name, number, rarity, artist, tcgplayer_url")
      .eq("card_id", card_id)
      .maybeSingle();

    if (cardErr) return { error: cardErr.message };
    if (!card) return { error: `card_id ${card_id} not in the competition pool` };

    const cutoff = new Date(Date.now() - 14 * 86_400_000)
      .toISOString()
      .slice(0, 10);

    const [latestRes, bucketRes] = await Promise.all([
      client
        .from("prices")
        .select("captured_at, market_price_usd, low_price_usd, high_price_usd, source, is_stale")
        .eq("card_id", card_id)
        .order("captured_at", { ascending: false })
        .limit(1),
      client
        .from("price_buckets")
        .select(
          "bucket_start_date, condition, variant, market_price_usd, low_sale_usd, high_sale_usd, quantity_sold, transaction_count",
        )
        .eq("card_id", card_id)
        .gte("bucket_start_date", cutoff)
        .order("bucket_start_date", { ascending: false }),
    ]);

    if (latestRes.error) return { error: latestRes.error.message };
    if (bucketRes.error) return { error: bucketRes.error.message };

    const latest = latestRes.data?.[0];
    const buckets = bucketRes.data ?? [];

    const recent_activity = buckets.map((b) => ({
      bucket_start_date: b.bucket_start_date,
      condition: b.condition,
      variant: b.variant,
      market_price_usd: Number(b.market_price_usd),
      low_sale_usd: b.low_sale_usd !== null ? Number(b.low_sale_usd) : null,
      high_sale_usd: b.high_sale_usd !== null ? Number(b.high_sale_usd) : null,
      quantity_sold: b.quantity_sold,
      transaction_count: b.transaction_count,
    }));

    const totalQtyLast14 = recent_activity.reduce(
      (s, b) => s + b.quantity_sold,
      0,
    );

    return {
      card_id: card.card_id,
      name: card.name,
      set_id: card.set_id,
      set_name: card.set_name,
      number: card.number,
      rarity: card.rarity,
      artist: card.artist,
      current_market_price_usd: latest ? Number(latest.market_price_usd) : null,
      current_low_price_usd:
        latest?.low_price_usd != null ? Number(latest.low_price_usd) : null,
      current_high_price_usd:
        latest?.high_price_usd != null ? Number(latest.high_price_usd) : null,
      captured_at: latest?.captured_at ?? null,
      is_stale: latest?.is_stale ?? false,
      total_quantity_sold_last_14d: totalQtyLast14,
      recent_activity,
      tcgplayer_url:
        card.tcgplayer_url ??
        `https://prices.pokemontcg.io/tcgplayer/${card.card_id}`,
      hint:
        "recent_activity is ordered newest-first and includes every condition/variant " +
        "the card trades in. Liquidity = sum of quantity_sold; spread = high_sale_usd - low_sale_usd.",
    };
  },
});
