#!/usr/bin/env bun
/**
 * Verify the 0001_initial_schema.sql migration actually ran.
 * Probes each expected table. Reports what's live vs missing.
 *
 * Run: bun run scripts/verify-schema.ts
 */
import { adminClient } from "../src/lib/supabase/admin";

const EXPECTED_TABLES = [
  // Competition core (Layer 1 + 2)
  "cards",
  "prices",
  "limitless_decks",
  // Layer 3 — bot state
  "bots",
  "holdings",
  "trades",
  "daily_snapshots",
  "round_runs",
  "leaderboard_current",
  "competition_state",
  // Public voting
  "users",
  "votes",
  "checkins",
  // Raffle + GDPR
  "raffle_snapshot",
  "raffle_winner",
  "privacy_consents",
  "deletion_requests",
  // Operator
  "operator_actions",
];

async function main() {
  console.log(`🔍 Probing ${EXPECTED_TABLES.length} expected tables...\n`);
  const client = adminClient();

  const results: { table: string; status: "ok" | "missing" | "error"; msg?: string }[] = [];

  for (const table of EXPECTED_TABLES) {
    const { error } = await client.from(table).select("*").limit(0);
    if (!error) {
      results.push({ table, status: "ok" });
    } else if (error.code === "PGRST205" || error.code === "42P01") {
      results.push({ table, status: "missing" });
    } else {
      results.push({ table, status: "error", msg: error.message });
    }
  }

  let okCount = 0;
  for (const r of results) {
    const icon = r.status === "ok" ? "✅" : r.status === "missing" ? "❌" : "⚠️";
    const note = r.status === "ok" ? "" : `  ← ${r.status}${r.msg ? `: ${r.msg}` : ""}`;
    console.log(`  ${icon} ${r.table}${note}`);
    if (r.status === "ok") okCount++;
  }

  console.log(
    `\n${okCount}/${EXPECTED_TABLES.length} tables present.`,
  );

  if (okCount === EXPECTED_TABLES.length) {
    // Bonus: verify seed bots landed
    const { data: bots } = await client.from("bots").select("bot_id, display_name");
    console.log(`\n🤖 Bots seeded: ${bots?.length ?? 0}`);
    for (const b of bots ?? []) {
      console.log(`   - ${b.bot_id}: ${b.display_name}`);
    }

    // Verify competition_state single row
    const { data: cs } = await client.from("competition_state").select("*");
    console.log(
      `\n🎮 competition_state rows: ${cs?.length ?? 0} (should be 1)`,
    );

    // Verify leaderboard_current single row
    const { data: lb } = await client.from("leaderboard_current").select("id");
    console.log(
      `📊 leaderboard_current rows: ${lb?.length ?? 0} (should be 1)`,
    );

    console.log("\n✨ Schema is live. Ready for M1-C (seed-pool.ts).");
  } else {
    console.log(
      "\n⚠️  Migration incomplete. Re-run the SQL in the Supabase dashboard.",
    );
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("\n❌ Error:", err.message);
  process.exit(1);
});
