#!/usr/bin/env bun
/**
 * Seed the `limitless_decks` table with tournament deck archetypes for the
 * Mega Evolution era competition.
 *
 * **These are hand-curated plausible archetypes, not real Limitless TCG data.**
 * v1 will replace this with a real scraper. For v0, it gives Claude bot
 * something tool-call-shaped to reason about when evaluating whether a card is
 * "meta" or "rogue."
 *
 * All referenced card_ids exist in the seeded pool (verified at run time).
 *
 * Usage: bun run seed:limitless
 */
import { adminClient } from "../src/lib/supabase/admin";

type DeckSeed = {
  deck_name: string;
  placement: number | null;
  event_name: string;
  event_date: string; // YYYY-MM-DD
  card_ids: string[];
};

// Only references card_ids that exist in the current priced pool (me1 + me2).
// me2pt5 / me3 cards are excluded because TCGPlayer hasn't priced those sets yet,
// so they're not in the `cards` table.
const DECKS: DeckSeed[] = [
  {
    deck_name: "Mega Charizard X Fire Aggro",
    placement: 1,
    event_name: "Regional: Atlanta",
    event_date: "2026-02-14",
    card_ids: ["me2-13", "me2-109", "me2-125"],
  },
  {
    deck_name: "Mega Charizard X Reserve List",
    placement: 2,
    event_name: "Regional: Atlanta",
    event_date: "2026-02-14",
    card_ids: ["me2-130", "me2-125"],
  },
  {
    deck_name: "Mega Gardevoir Psychic Toolbox",
    placement: 1,
    event_name: "Regional: Portland",
    event_date: "2026-02-28",
    card_ids: ["me1-187", "me1-159", "me1-178"],
  },
  {
    deck_name: "Mega Lucario Fighting Aggro",
    placement: 3,
    event_name: "Regional: Portland",
    event_date: "2026-02-28",
    card_ids: ["me1-160", "me1-188", "me1-179"],
  },
  {
    deck_name: "Mega Venusaur Grass Stall",
    placement: null,
    event_name: "Regional: Portland",
    event_date: "2026-02-28",
    card_ids: ["me1-155", "me1-177"],
  },
  {
    deck_name: "Mega Absol Dark Assassin",
    placement: 2,
    event_name: "Regional: Melbourne",
    event_date: "2026-01-10",
    card_ids: ["me1-161", "me1-180"],
  },
  {
    deck_name: "Mega Latias Psychic Control",
    placement: 4,
    event_name: "Regional: Melbourne",
    event_date: "2026-01-10",
    card_ids: ["me1-163", "me1-181"],
  },
  {
    deck_name: "Mega Kangaskhan Normal Aggro",
    placement: null,
    event_name: "Regional: Melbourne",
    event_date: "2026-01-10",
    card_ids: ["me1-164", "me1-182"],
  },
  {
    deck_name: "Mega Lopunny Fighting Speed",
    placement: 4,
    event_name: "Regional: Dallas",
    event_date: "2026-03-28",
    card_ids: ["me2-128"],
  },
  {
    deck_name: "Mega Sharpedo Dark Spike",
    placement: null,
    event_name: "Regional: Dallas",
    event_date: "2026-03-28",
    card_ids: ["me2-127"],
  },
  {
    deck_name: "Mega Charizard Burn Variant",
    placement: 1,
    event_name: "Regional: Amsterdam",
    event_date: "2026-04-11",
    card_ids: ["me2-13", "me2-130"],
  },
  {
    deck_name: "Mega Gardevoir Psychic (budget build)",
    placement: null,
    event_name: "Regional: Amsterdam",
    event_date: "2026-04-11",
    card_ids: ["me1-159", "me1-187"],
  },
  {
    deck_name: "Mega Lucario Fighting (2nd place cut)",
    placement: 2,
    event_name: "Regional: Amsterdam",
    event_date: "2026-04-11",
    card_ids: ["me1-188", "me1-160"],
  },
  {
    deck_name: "Mega Absol Alpha",
    placement: null,
    event_name: "Regional: Tokyo",
    event_date: "2026-04-04",
    card_ids: ["me1-180", "me1-161"],
  },
  {
    deck_name: "Mega Latias Flight Control",
    placement: 3,
    event_name: "Regional: Tokyo",
    event_date: "2026-04-04",
    card_ids: ["me1-181", "me1-163"],
  },
  {
    deck_name: "Mega Venusaur Poison Stall",
    placement: 4,
    event_name: "Regional: Tokyo",
    event_date: "2026-04-04",
    card_ids: ["me1-177", "me1-155"],
  },
];

async function main() {
  console.log(`🏆 Seeding ${DECKS.length} tournament deck archetypes...\n`);

  const client = adminClient();

  // Verify every referenced card_id exists in our pool — catches typos early.
  const allCardIds = new Set(DECKS.flatMap((d) => d.card_ids));
  const { data: existing, error: checkErr } = await client
    .from("cards")
    .select("card_id")
    .in("card_id", Array.from(allCardIds));
  if (checkErr) {
    console.error("❌ Failed to check card existence:", checkErr.message);
    process.exit(1);
  }
  const existingSet = new Set((existing ?? []).map((r) => r.card_id));
  const missing = Array.from(allCardIds).filter((id) => !existingSet.has(id));
  if (missing.length > 0) {
    console.error(
      `❌ ${missing.length} referenced card_ids missing from cards table:`,
      missing.join(", "),
    );
    console.error("   Did you run seed:pool first?");
    process.exit(1);
  }

  // Idempotent: truncate + re-insert so deck list can evolve without duplicates.
  const { error: delErr } = await client.from("limitless_decks").delete().neq("deck_id", -1);
  if (delErr) {
    console.error("❌ Failed to clear limitless_decks:", delErr.message);
    process.exit(1);
  }

  const { error: insErr } = await client.from("limitless_decks").insert(DECKS);
  if (insErr) {
    console.error("❌ Failed to insert decks:", insErr.message);
    process.exit(1);
  }

  console.log("✅ Deck archetypes seeded:");
  for (const d of DECKS) {
    const placementStr = d.placement ? `#${d.placement}` : "top 32";
    console.log(
      `   ${placementStr.padEnd(7)} ${d.deck_name.padEnd(36)} ${d.event_name} (${d.event_date})`,
    );
  }
  console.log(`\n✨ ${DECKS.length} decks ready. Claude's research tool is armed.`);
}

main().catch((e) => {
  console.error("\n❌ Error:", e);
  process.exit(1);
});
