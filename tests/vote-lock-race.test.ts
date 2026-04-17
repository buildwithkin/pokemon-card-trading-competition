/**
 * VOTE-LOCK RACE TEST
 *
 * At 08:00 on Competition Day 1, two crons fire:
 *   - /api/cron/lock-votes   → sets competition_state.voting_locked = true
 *   - /api/cron/daily-round  → kicks off the first bot round
 *
 * A user hitting /api/vote at 07:59:59.9 must either:
 *   (a) land their vote BEFORE the lock fires, OR
 *   (b) be rejected cleanly because the lock already flipped
 *
 * NOT acceptable: ghost vote that gets written AFTER the lock (would corrupt
 * the raffle by admitting entries that didn't exist at draw time).
 *
 * Full implementation lands in Milestone 6 when /api/vote exists.
 */
import { describe, test } from "bun:test";

describe("Vote lock — race safety", () => {
  test.todo(
    "concurrent INSERT into votes + UPDATE lock: vote-then-lock succeeds, lock-then-vote rejects",
  );

  test.todo(
    "vote insert uses WHERE NOT EXISTS(SELECT 1 FROM competition_state WHERE voting_locked=true)",
  );

  test.todo("post-lock vote attempts return 409 Conflict with clear error body");

  test.todo(
    "locked_at is backfilled onto existing votes when the lock cron runs",
  );
});
