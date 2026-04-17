import { serverClient } from "@/lib/supabase/server";
import { PoolGrid, type PoolCard } from "./pool-grid";

export const dynamic = "force-dynamic"; // always fetch fresh during review

export default async function PoolPage() {
  const client = serverClient();

  // Join cards + today's prices (latest captured_at per card). Public RLS covers this.
  const { data: cards, error: cardErr } = await client
    .from("cards")
    .select(
      "card_id, name, set_id, set_name, number, rarity, artist, image_url",
    );
  if (cardErr) throw cardErr;

  const { data: prices, error: priceErr } = await client
    .from("prices")
    .select("card_id, market_price_usd, low_price_usd, high_price_usd, source, is_stale, captured_at")
    .order("captured_at", { ascending: false });
  if (priceErr) throw priceErr;

  // Most-recent price per card_id
  const latestByCard = new Map<
    string,
    {
      market_price_usd: number;
      low_price_usd: number | null;
      high_price_usd: number | null;
      source: string;
      is_stale: boolean;
    }
  >();
  for (const p of prices ?? []) {
    if (!latestByCard.has(p.card_id)) {
      latestByCard.set(p.card_id, {
        market_price_usd: Number(p.market_price_usd),
        low_price_usd: p.low_price_usd !== null ? Number(p.low_price_usd) : null,
        high_price_usd: p.high_price_usd !== null ? Number(p.high_price_usd) : null,
        source: p.source,
        is_stale: p.is_stale,
      });
    }
  }

  // Every card in the DB has a real price (cleaned during seed).
  // Skip cards where price lookup fails (shouldn't happen, defensive).
  const pool: PoolCard[] = (cards ?? []).flatMap((c) => {
    const p = latestByCard.get(c.card_id);
    if (!p) return [];
    return [{
      card_id: c.card_id,
      name: c.name,
      set_id: c.set_id,
      set_name: c.set_name,
      number: c.number,
      rarity: c.rarity,
      artist: c.artist,
      image_url: c.image_url,
      market_price_usd: p.market_price_usd,
      low_price_usd: p.low_price_usd,
      high_price_usd: p.high_price_usd,
      source: p.source,
      is_stale: p.is_stale,
    }];
  });

  return (
    <main className="min-h-screen bg-background text-foreground">
      <header className="border-border/40 sticky top-0 z-10 border-b bg-background/80 backdrop-blur">
        <div className="mx-auto max-w-7xl px-4 py-4 sm:px-6">
          <div className="flex flex-wrap items-end justify-between gap-2">
            <div>
              <h1 className="text-2xl font-bold tracking-tight text-neon-cyan sm:text-3xl">
                Chaos Arena — Card Pool
              </h1>
              <p className="text-muted-foreground text-sm">
                M1 review view. {pool.length} SV + ME era cards. {pool.filter(c => c.market_price_usd !== null).length} with real TCGPlayer prices.
              </p>
            </div>
            <p className="text-accent text-xs font-mono">
              v0 / milestone 1 / review gate
            </p>
          </div>
        </div>
      </header>
      <PoolGrid cards={pool} />
    </main>
  );
}
