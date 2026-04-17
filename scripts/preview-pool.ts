#!/usr/bin/env bun
/**
 * Quick read-only dump of the seeded card pool — used to build limitless_decks.
 */
import { adminClient } from "../src/lib/supabase/admin";

async function main() {
  const client = adminClient();
  const { data, error } = await client
    .from("cards")
    .select("card_id, name, rarity, set_id")
    .ilike("name", "Mega %")
    .order("name");
  if (error) throw error;
  console.log(`${data.length} Mega Pokemon cards in pool:\n`);
  for (const c of data) {
    console.log(
      `  ${c.card_id.padEnd(12)} ${c.name.padEnd(30)} ${(c.rarity ?? "-").padEnd(30)} ${c.set_id}`,
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
