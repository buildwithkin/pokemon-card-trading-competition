/**
 * IRON RULE — simulator must never write to live competition tables.
 *
 * The simulator has its own sim_* tables with a run_id dimension. It must
 * not touch daily_snapshots, holdings, trades, bot_notes, round_runs, or
 * leaderboard_current under any circumstance. Live-competition state is
 * sacred.
 *
 * This test is the regression gate: run a full sim, then count rows in the
 * live tables. The count must be zero-delta from before the sim.
 *
 * Currently a todo stub until a local Supabase harness exists. See the
 * checklist inside for what the real implementation must verify.
 */
import { describe, test } from "bun:test";

describe("sim-isolation — sims never pollute live tables", () => {
  test.todo(
    "running a full 3-day sim leaves daily_snapshots unchanged",
    () => {
      // 1. snapshot live table counts before
      // 2. POST /api/simulator/create + /advance × 3 with stubbed runTurn
      // 3. re-count live tables — delta must be 0 for:
      //    - daily_snapshots
      //    - holdings
      //    - trades
      //    - bot_notes
      //    - round_runs
      //    - leaderboard_current
      // 4. sim_* tables should have 3×3 snapshot rows, N trade rows, etc.
    },
  );

  test.todo(
    "sim_holdings enforce_sim_holdings_cap fires per-run, not globally",
    () => {
      // Two runs each buy 5 cards for the same bot → both succeed.
      // A 6th buy in either run → trigger rejects with 'cap' error.
    },
  );

  test.todo(
    "UNIQUE(run_id, bot_id, day, decision_index) blocks duplicate trade inserts",
  );
});
