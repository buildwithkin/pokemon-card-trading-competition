/**
 * CRON / MANUAL OVERRIDE RACE TEST
 *
 * Prevents the 2am-Friday bug where cron fires at 08:00 and operator clicks
 * "Run round now" at 08:00:03 — both pass the 5-min rate limit, both spawn
 * rounds, bots trade twice.
 *
 * Mitigation in production: Postgres advisory lock + Inngest concurrency key
 * + round_runs UNIQUE(day, round_no).
 *
 * Full implementation lands in Milestone 3 when /api/cron/daily-round exists.
 */
import { describe, test } from "bun:test";

describe("Concurrency — daily round endpoint", () => {
  test.todo("two parallel POSTs to /api/cron/daily-round for same day → one succeeds, one 409s");

  test.todo(
    "advisory lock is released on success AND on error (no stuck lock after crash)",
  );

  test.todo(
    "operator-triggered round after scheduled round increments round_no to 2",
  );

  test.todo("Inngest concurrency key blocks duplicate function invocations");
});
