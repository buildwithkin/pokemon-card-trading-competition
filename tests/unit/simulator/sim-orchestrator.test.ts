/**
 * Simulator orchestrator — pure-function tests + stubs for DB-dependent tests.
 *
 * Every test in here that requires a real Supabase connection is a test.todo
 * until the project gets a local Supabase harness (npx supabase start). The
 * stub bodies document the expected behavior precisely enough to fill in
 * later. See the IRON RULE regression test at the bottom.
 */
import { describe, expect, test } from "bun:test";
import { isStuck } from "@/lib/simulator/simOrchestrator";

describe("isStuck", () => {
  test("returns false when status is not 'advancing'", () => {
    const now = new Date().toISOString();
    expect(isStuck("paused", now)).toBe(false);
    expect(isStuck("completed", now)).toBe(false);
    expect(isStuck("failed", now)).toBe(false);
  });

  test("returns false when advancing and heartbeat is fresh", () => {
    const now = new Date().toISOString();
    expect(isStuck("advancing", now)).toBe(false);
  });

  test("returns false when advancing and heartbeat is 1 minute old", () => {
    const oneMinAgo = new Date(Date.now() - 60 * 1000).toISOString();
    expect(isStuck("advancing", oneMinAgo)).toBe(false);
  });

  test("returns true when advancing and heartbeat is older than 2 minutes", () => {
    const threeMinAgo = new Date(Date.now() - 3 * 60 * 1000).toISOString();
    expect(isStuck("advancing", threeMinAgo)).toBe(true);
  });

  test("returns true when advancing and heartbeat is 10 minutes old", () => {
    const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    expect(isStuck("advancing", tenMinAgo)).toBe(true);
  });
});

describe("loadSimBotState — DB-dependent (todo until local supabase)", () => {
  test.todo(
    "returns $1000 cash and empty holdings when no sim_trades exist",
  );
  test.todo(
    "after a buy: cash drops by trade price, holding appears in state",
  );
  test.todo(
    "after a buy + sell of same card: cash returns to ~$1000, holdings empty",
  );
  test.todo(
    "holding's current_market_price_usd uses today's pool, not buy_price",
  );
});

describe("loadSimPreviousNotes — DB-dependent", () => {
  test.todo("returns null when no prior sim_bot_notes rows exist");
  test.todo("returns the most recent prior day's notes, not today's");
  test.todo("filters by run_id — other runs' notes don't leak");
});

describe("advanceSimDay — DB-dependent", () => {
  test.todo("404 when run_id doesn't exist");
  test.todo("409 when status is already 'advancing' (double-click race)");
  test.todo("409 when current_day already equals duration_days");
  test.todo(
    "happy path: writes 3 snapshot rows + 3 bot_notes rows + trades per action",
  );
  test.todo(
    "flips status to 'completed' when advanced_to_day equals duration_days",
  );
  test.todo(
    "leaves status 'advancing' (not reset to paused) if a bot turn throws — UI detects stuck heartbeat",
  );
});
