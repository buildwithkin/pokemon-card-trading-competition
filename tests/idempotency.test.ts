/**
 * IDEMPOTENCY CONTRACT TEST
 *
 * The most important test in this repo. If it passes, a crash during the
 * 7-day real competition is survivable. If it fails, a single bad retry
 * corrupts a day's footage.
 *
 * Full implementation lands in Milestone 3 (multi-bot daily round) when the
 * Inngest worker + trade-write path exists.
 */
import { describe, test } from "bun:test";

describe("Layer 3 — trade idempotency", () => {
  test.todo(
    "replaying a bot-turn with same (bot_id, day, decision_index) is a no-op",
    () => {
      // Given: a bot has made 3 trades on Day 2
      // When: the Inngest worker replays those steps (simulated crash mid-run)
      // Then: the trades table still has exactly 3 rows for that bot/day
      // And: cash + holdings state is unchanged
    },
  );

  test.todo("UNIQUE constraint on (bot_id, day, decision_index) blocks dupes");

  test.todo("holdings trigger rejects a 6th row per bot (5-slot cap)");
});
