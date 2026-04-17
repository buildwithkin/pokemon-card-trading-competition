#!/usr/bin/env bun
/**
 * Seed the card universe for the Scarlet & Violet + Mega Evolution era.
 *
 * Layer 1 work (one-time setup). Populates `cards` + today's real-price row
 * in `prices`. NO synthetic/estimated prices — if TCGPlayer hasn't indexed a
 * card, it stores the card with no price row. You can filter "tradeable pool"
 * as cards that exist in both `cards` AND `prices`.
 *
 * Usage:
 *   bun run seed:pool
 *   POKEMONTCG_API_KEY=... bun run seed:pool   # higher rate limit
 *
 * Idempotent: rerunning upserts by card_id and (card_id, captured_at).
 */
import { adminClient } from "../src/lib/supabase/admin";

// Full Scarlet & Violet + Mega Evolution + Sword & Shield + Sun & Moon era sets.
const ERA_SET_IDS = [
  // SV main
  "sv1",
  "sv2",
  "sv3",
  "sv3pt5",
  "sv4",
  "sv4pt5",
  "sv5",
  "sv6",
  "sv6pt5",
  "sv7",
  "sv8",
  "sv8pt5",
  "sv9",
  "sv10",
  // SV special
  "svp", // Black Star Promos
  "sve", // Energies (likely filtered out by price floor)
  "zsv10pt5", // Black Bolt
  "rsv10pt5", // White Flare
  // Mega Evolution era
  "me1",
  "me2",
  "me2pt5",
  "me3",
  // Sword & Shield main
  "swsh1", // Sword & Shield
  "swsh2", // Rebel Clash
  "swsh3", // Darkness Ablaze
  "swsh4", // Vivid Voltage
  "swsh5", // Battle Styles
  "swsh6", // Chilling Reign
  "swsh7", // Evolving Skies
  "swsh8", // Fusion Strike
  "swsh9", // Brilliant Stars
  "swsh10", // Astral Radiance
  "swsh11", // Lost Origin
  "swsh12", // Silver Tempest
  // Sword & Shield special
  "swsh12pt5", // Crown Zenith
  "swshp", // Black Star Promos
  "swsh35", // Champion's Path
  "swsh45", // Shining Fates
  "swsh10pt5", // Pokémon GO
  // Celebrations
  "cel25",
  "cel25c", // Celebrations Classic Collection
  // Sun & Moon main
  "sm1", // Sun & Moon
  "sm2", // Guardians Rising
  "sm3", // Burning Shadows
  "sm4", // Crimson Invasion
  "sm5", // Ultra Prism
  "sm6", // Forbidden Light
  "sm7", // Celestial Storm
  "sm8", // Lost Thunder
  "sm9", // Team Up
  "sm10", // Unbroken Bonds
  "sm11", // Unified Minds
  "sm12", // Cosmic Eclipse
  // Sun & Moon special
  "sm35", // Shining Legends
  "sm75", // Dragon Majesty
  "sm115", // Hidden Fates
  "smp", // Black Star Promos
  "det1", // Detective Pikachu (SM era crossover)
];

const MIN_MARKET_PRICE_USD = 3.0;
const API_BASE = "https://api.pokemontcg.io/v2";
const TODAY = new Date().toISOString().slice(0, 10);

type TcgVariantPrice = {
  low?: number | null;
  mid?: number | null;
  high?: number | null;
  market?: number | null;
  directLow?: number | null;
};

type PokemonCard = {
  id: string;
  name: string;
  set: { id: string; name: string };
  number: string;
  rarity?: string | null;
  artist?: string | null;
  subtypes?: string[];
  images: { small: string; large: string };
  tcgplayer?: {
    url?: string;
    prices?: Record<string, TcgVariantPrice>;
  };
};

function apiHeaders(): HeadersInit {
  const key = process.env.POKEMONTCG_API_KEY;
  return key ? { "X-Api-Key": key } : {};
}

/**
 * Variant priority for picking "the" canonical price for a card.
 *
 * Canonical printings are what collectors think of as "the card":
 *   - `holofoil` for cards with a holo version (most Rare Holo+, all modern chase cards)
 *   - `normal` for cards without holos (commons, uncommons, most promos)
 *   - older sets use `1stEdition*` / `unlimited*`
 *
 * `reverseHolofoil` is a SECONDARY printing — collectors chase it, it's often priced
 * higher than the canonical variant, but it's NOT what someone means by "the price
 * of this card." Picking it creates a jarring disconnect when users click through
 * to TCGPlayer and see a different price for the default printing.
 */
const VARIANT_PRIORITY = [
  "holofoil",
  "normal",
  "1stEditionHolofoil",
  "1stEdition",
  "unlimitedHolofoil",
  "unlimited",
];

function bestVariantSpread(
  card: PokemonCard,
): { market: number; low: number | null; high: number | null; variant: string } | null {
  const prices = card.tcgplayer?.prices;
  if (!prices) return null;

  // Prefer canonical variants in priority order
  for (const key of VARIANT_PRIORITY) {
    const v = prices[key];
    if (v && typeof v.market === "number" && v.market > 0) {
      return {
        market: v.market,
        low: typeof v.low === "number" ? v.low : null,
        high: typeof v.high === "number" ? v.high : null,
        variant: key,
      };
    }
  }

  // Fallback: if none of the canonical variants have a market price,
  // use whatever variant is present (e.g. only reverseHolofoil).
  // This should be rare.
  for (const [key, v] of Object.entries(prices)) {
    if (v && typeof v.market === "number" && v.market > 0) {
      return {
        market: v.market,
        low: typeof v.low === "number" ? v.low : null,
        high: typeof v.high === "number" ? v.high : null,
        variant: key,
      };
    }
  }

  return null;
}

async function fetchCardsInSet(setId: string): Promise<PokemonCard[]> {
  const all: PokemonCard[] = [];
  let page = 1;
  const pageSize = 250;

  while (true) {
    const url = `${API_BASE}/cards?q=set.id:${setId}&pageSize=${pageSize}&page=${page}`;
    const res = await fetch(url, { headers: apiHeaders() });
    if (!res.ok) {
      throw new Error(`pokemontcg.io ${res.status} fetching ${setId} p${page}`);
    }
    const body = (await res.json()) as {
      data: PokemonCard[];
      totalCount: number;
    };
    all.push(...body.data);
    if (all.length >= body.totalCount || body.data.length === 0) break;
    page++;
  }
  return all;
}

async function main() {
  console.log(
    `🌱 Seeding full SV + ME era (${ERA_SET_IDS.length} sets, real prices only, $${MIN_MARKET_PRICE_USD.toFixed(2)} floor)\n`,
  );

  const client = adminClient();

  type CardRow = {
    card_id: string;
    name: string;
    set_id: string;
    set_name: string;
    number: string;
    rarity: string | null;
    artist: string | null;
    image_url: string;
    is_mega_evolution: boolean;
  };

  type PriceRow = {
    card_id: string;
    captured_at: string;
    market_price_usd: number;
    low_price_usd: number | null;
    high_price_usd: number | null;
    source: string;
    is_stale: boolean;
  };

  const allCards: CardRow[] = [];
  const allPrices: PriceRow[] = [];
  const stats: Record<
    string,
    { name: string; total: number; priced: number; tradeable: number; no_price: number }
  > = {};

  for (const setId of ERA_SET_IDS) {
    process.stdout.write(`📦 ${setId}...`);
    let cards: PokemonCard[];
    try {
      cards = await fetchCardsInSet(setId);
    } catch (e: unknown) {
      console.log(` ❌ ${e instanceof Error ? e.message : e}`);
      stats[setId] = { name: "ERROR", total: 0, priced: 0, tradeable: 0, no_price: 0 };
      continue;
    }

    let priced = 0;
    let tradeable = 0;
    let noPrice = 0;

    for (const c of cards) {
      const isMega =
        (c.subtypes ?? []).some((s) => s.toLowerCase() === "mega") ||
        c.name.toLowerCase().startsWith("mega ");

      const spread = bestVariantSpread(c);
      if (spread) {
        priced++;
        if (spread.market >= MIN_MARKET_PRICE_USD) {
          tradeable++;
          // ONLY store cards that pass the price filter.
          // Cards without real prices or below $3 are not stored at all.
          allCards.push({
            card_id: c.id,
            name: c.name,
            set_id: c.set.id,
            set_name: c.set.name,
            number: c.number,
            rarity: c.rarity ?? null,
            artist: c.artist ?? null,
            image_url: c.images.large,
            is_mega_evolution: isMega,
          });
          allPrices.push({
            card_id: c.id,
            captured_at: TODAY,
            market_price_usd: Number(spread.market.toFixed(2)),
            low_price_usd:
              spread.low !== null ? Number(spread.low.toFixed(2)) : null,
            high_price_usd:
              spread.high !== null ? Number(spread.high.toFixed(2)) : null,
            source: "tcgplayer",
            is_stale: false,
          });
        }
      } else {
        noPrice++;
      }
    }

    stats[setId] = {
      name: cards[0]?.set.name ?? setId,
      total: cards.length,
      priced,
      tradeable,
      no_price: noPrice,
    };
    console.log(
      ` ${cards.length} cards (${tradeable} tradeable, ${noPrice} no price)`,
    );
  }

  console.log(`\n💾 Upserting ${allCards.length} cards to Supabase...`);
  // Batch in chunks of 500 to stay under Supabase row limits
  for (let i = 0; i < allCards.length; i += 500) {
    const chunk = allCards.slice(i, i + 500);
    const { error } = await client
      .from("cards")
      .upsert(chunk, { onConflict: "card_id" });
    if (error) {
      console.error(`❌ Card upsert failed (batch ${i}):`, error.message);
      process.exit(1);
    }
  }

  console.log(`💾 Upserting ${allPrices.length} price rows for ${TODAY}...`);
  for (let i = 0; i < allPrices.length; i += 500) {
    const chunk = allPrices.slice(i, i + 500);
    const { error } = await client
      .from("prices")
      .upsert(chunk, { onConflict: "card_id,captured_at" });
    if (error) {
      console.error(`❌ Price upsert failed (batch ${i}):`, error.message);
      process.exit(1);
    }
  }

  // Summary
  console.log("\n════════════════════════════════════════════════════════");
  console.log("SEED SUMMARY — REAL PRICES ONLY");
  console.log("════════════════════════════════════════════════════════");
  console.log(
    `${"Set".padEnd(12)} ${"Name".padEnd(24)} ${"Total".padStart(5)} ${"Priced".padStart(7)} ${"Trade".padStart(7)} ${"NoPx".padStart(6)}`,
  );
  console.log("-".repeat(70));

  let totalCards = 0;
  let totalPriced = 0;
  let totalTradeable = 0;
  let totalNoPrice = 0;
  for (const [sid, s] of Object.entries(stats)) {
    console.log(
      `${sid.padEnd(12)} ${s.name.padEnd(24)} ${s.total.toString().padStart(5)} ${s.priced.toString().padStart(7)} ${s.tradeable.toString().padStart(7)} ${s.no_price.toString().padStart(6)}`,
    );
    totalCards += s.total;
    totalPriced += s.priced;
    totalTradeable += s.tradeable;
    totalNoPrice += s.no_price;
  }
  console.log("-".repeat(70));
  console.log(
    `${"TOTAL".padEnd(12)} ${"".padEnd(24)} ${totalCards.toString().padStart(5)} ${totalPriced.toString().padStart(7)} ${totalTradeable.toString().padStart(7)} ${totalNoPrice.toString().padStart(6)}`,
  );

  // Price distribution for tradeable cards
  if (allPrices.length > 0) {
    const prices = allPrices.map((r) => r.market_price_usd).sort((a, b) => a - b);
    const median = prices[Math.floor(prices.length / 2)];
    const p90 = prices[Math.floor(prices.length * 0.9)];
    console.log("\nPrice distribution (tradeable cards, real TCGPlayer data):");
    console.log(`  min    $${prices[0].toFixed(2)}`);
    console.log(`  median $${median.toFixed(2)}`);
    console.log(`  p90    $${p90.toFixed(2)}`);
    console.log(`  max    $${prices[prices.length - 1].toFixed(2)}`);

    const top10 = [...allPrices]
      .sort((a, b) => b.market_price_usd - a.market_price_usd)
      .slice(0, 10);
    console.log("\nTop 10 most expensive:");
    for (const p of top10) {
      const card = allCards.find((c) => c.card_id === p.card_id);
      console.log(
        `  $${p.market_price_usd.toFixed(2).padStart(7)}  ${(card?.name ?? "?").padEnd(30)} ${(card?.rarity ?? "-").padEnd(28)} ${card?.set_id ?? "?"}`,
      );
    }
  }

  console.log(
    `\n✨ ${allCards.length} cards stored. ${allPrices.length} have real prices at $${MIN_MARKET_PRICE_USD.toFixed(2)}+. ${totalNoPrice} have NO TCGPlayer data (investigate in /pool).`,
  );
}

main().catch((err) => {
  console.error("\n❌ Error:", err);
  process.exit(1);
});
