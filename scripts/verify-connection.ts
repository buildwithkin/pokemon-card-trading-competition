#!/usr/bin/env bun
/**
 * Verify Supabase connection works with the keys in .env.local.
 * Does NOT touch schema — pure read test.
 *
 * Run: bun run scripts/verify-connection.ts
 */
import { adminClient } from "../src/lib/supabase/admin";

async function main() {
  console.log("🔌 Checking env vars...");

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const service = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url) throw new Error("NEXT_PUBLIC_SUPABASE_URL missing");
  if (!anon) throw new Error("NEXT_PUBLIC_SUPABASE_ANON_KEY missing");
  if (!service) throw new Error("SUPABASE_SERVICE_ROLE_KEY missing");

  console.log(`  URL: ${url}`);
  console.log(
    `  anon key:    ${anon.slice(0, 20)}...${anon.slice(-6)} (len ${anon.length})`,
  );
  console.log(
    `  service key: ${service.slice(0, 20)}...${service.slice(-6)} (len ${service.length})`,
  );

  if (anon === service) {
    throw new Error(
      "anon and service keys are identical — you pasted the same key twice",
    );
  }

  console.log("\n🔗 Connecting to Supabase...");
  const client = adminClient();

  // Probe a table that definitely doesn't exist.
  // PGRST205 = "relation does not exist" → auth worked, project is live.
  // 401/403 = auth failed.
  // Network error = wrong URL.
  const { error } = await client
    .from("__probe_nonexistent_table__")
    .select("*")
    .limit(1);

  if (!error) {
    // Unexpected success (table somehow exists?) — still a valid connection.
    console.log("✅ Connected successfully (probe table unexpectedly exists)");
  } else if (error.code === "PGRST205" || error.code === "42P01") {
    console.log("✅ Connected successfully");
    console.log(`   (expected probe error: ${error.code} "relation does not exist")`);
  } else if (error.code === "PGRST301" || error.message.includes("JWT")) {
    console.error("\n❌ Auth failed — check your service role key");
    console.error("   code:", error.code);
    console.error("   message:", error.message);
    process.exit(1);
  } else {
    console.error("\n⚠️  Unexpected error (may still be a valid connection):");
    console.error("   code:", error.code);
    console.error("   message:", error.message);
    console.error("   hint:", error.hint ?? "(none)");
    process.exit(1);
  }

  console.log("\n✨ Ready for M1-B schema migration.");
}

main().catch((err) => {
  console.error("\n❌ Error:", err.message);
  process.exit(1);
});
