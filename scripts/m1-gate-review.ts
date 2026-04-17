#!/usr/bin/env bun
/**
 * M1 Review Gate — concise dump of the seeded foundation for manual review.
 * Prints row counts + sample rows + price distribution + deck list.
 *
 * Run: bun run scripts/m1-gate-review.ts
 */
import { adminClient } from "../src/lib/supabase/admin";

const client = adminClient();

async function count(table: string): Promise<number> {
  const { count, error } = await client
    .from(table)
    .select("*", { count: "exact", head: true });
  if (error) throw new Error(`count ${table}: ${error.message}`);
  return count ?? 0;
}

async function main() {
  console.log("═══════════════════════════════════════════════════");
  console.log("M1 REVIEW GATE — FOUNDATION STATUS");
  console.log("═══════════════════════════════════════════════════\n");

  // Row counts
  console.log("📊 Row counts:");
  const tables = [
    "cards",
    "prices",
    "bots",
    "limitless_decks",
    "holdings",
    "trades",
    "competition_state",
    "leaderboard_current",
  ];
  for (const t of tables) {
    const n = await count(t);
    console.log(`   ${t.padEnd(22)} ${n.toString().padStart(4)} rows`);
  }

  // Card breakdown by set
  console.log("\n🃏 Card pool by set:");
  const { data: bySet } = await client.from("cards").select("set_id, set_name");
  const setCounts = new Map<string, { name: string; n: number }>();
  for (const row of bySet ?? []) {
    const cur = setCounts.get(row.set_id) ?? { name: row.set_name, n: 0 };
    cur.n++;
    setCounts.set(row.set_id, cur);
  }
  for (const [id, { name, n }] of [...setCounts].sort()) {
    console.log(`   ${id.padEnd(10)} ${name.padEnd(22)} ${n} cards`);
  }

  // Price source breakdown
  const { data: priceSrc } = await client.from("prices").select("source");
  const srcCounts = new Map<string, number>();
  for (const p of priceSrc ?? []) {
    srcCounts.set(p.source, (srcCounts.get(p.source) ?? 0) + 1);
  }
  console.log("\n💲 Price source breakdown:");
  for (const [s, n] of srcCounts) {
    console.log(`   ${s.padEnd(22)} ${n} cards`);
  }

  // Top 5 chase cards
  console.log("\n🏆 Top 5 chase cards:");
  const { data: top } = await client
    .from("prices")
    .select("card_id, market_price_usd, source, cards(name, rarity, set_id)")
    .order("market_price_usd", { ascending: false })
    .limit(5);
  for (const r of (top ?? []) as unknown as Array<{
    card_id: string;
    market_price_usd: number;
    source: string;
    cards: { name: string; rarity: string | null; set_id: string };
  }>) {
    console.log(
      `   $${r.market_price_usd.toFixed(2).padStart(7)}  ${r.cards.name.padEnd(28)}  ${(r.cards.rarity ?? "-").padEnd(30)} ${r.cards.set_id}  [${r.source}]`,
    );
  }

  // Bottom 5 (show the floor is real)
  console.log("\n🪣 Bottom 5 (at the $3 floor):");
  const { data: bottom } = await client
    .from("prices")
    .select("card_id, market_price_usd, source, cards(name, rarity, set_id)")
    .order("market_price_usd", { ascending: true })
    .limit(5);
  for (const r of (bottom ?? []) as unknown as Array<{
    card_id: string;
    market_price_usd: number;
    source: string;
    cards: { name: string; rarity: string | null; set_id: string };
  }>) {
    console.log(
      `   $${r.market_price_usd.toFixed(2).padStart(7)}  ${r.cards.name.padEnd(28)}  ${(r.cards.rarity ?? "-").padEnd(30)} ${r.cards.set_id}  [${r.source}]`,
    );
  }

  // Bots
  console.log("\n🤖 Bots seeded:");
  const { data: bots } = await client
    .from("bots")
    .select("bot_id, display_name, model_provider, model_id");
  for (const b of bots ?? []) {
    console.log(
      `   ${b.bot_id.padEnd(14)} ${b.display_name.padEnd(16)} ${b.model_provider}/${b.model_id}`,
    );
  }

  // Decks (just count + top placements)
  const { data: decks } = await client
    .from("limitless_decks")
    .select("deck_name, placement, event_name")
    .order("placement", { ascending: true, nullsFirst: false })
    .limit(6);
  console.log("\n🏅 Sample tournament decks (Claude's research pool):");
  for (const d of decks ?? []) {
    const p = d.placement ? `#${d.placement}` : "top 32";
    console.log(`   ${p.padEnd(7)} ${d.deck_name.padEnd(36)} ${d.event_name}`);
  }

  console.log(
    "\n═══════════════════════════════════════════════════",
  );
  console.log("READY FOR REVIEW");
  console.log("═══════════════════════════════════════════════════\n");
  console.log("If the numbers above look reasonable, approve M2 kickoff.");
  console.log(
    "You can also browse the data visually at:",
  );
  console.log(
    "   https://supabase.com/dashboard/project/dqvwiajfpdolxjwkhexh/editor",
  );
}

main().catch((e) => {
  console.error("❌ Error:", e);
  process.exit(1);
});
