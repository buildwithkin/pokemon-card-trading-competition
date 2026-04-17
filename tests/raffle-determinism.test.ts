/**
 * RAFFLE DETERMINISM TEST
 *
 * The raffle draw happens on camera during the video. The seed is shown on
 * camera. Viewers who want to verify can re-run the draw with the same seed
 * and the same entries snapshot — must get the same winner.
 *
 * Pure function test — no DB needed. Just math.
 *
 * Full implementation lands in Milestone 7 when drawWinner() is written.
 */
import { describe, test } from "bun:test";

describe("Raffle draw — reproducibility", () => {
  test.todo(
    "drawWinner(seed, entries) returns the same winner when called 1000 times with same inputs",
  );

  test.todo(
    "weight field (1 + checkin_count) correctly skews the distribution",
    // Statistical test: given 1000 runs with seed rotated, distribution of
    // winner_user_id matches expected weights within 2σ.
  );

  test.todo(
    "drawWinner respects is_winner_pick=true filter (only bots who picked winning bot)",
  );

  test.todo("raffle_snapshot row contains seed + entries_json frozen at draw time");
});
