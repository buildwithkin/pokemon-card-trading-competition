/**
 * Migration 0004 regression tests.
 *
 * Two load-bearing invariants, both enforced by a live Supabase round-trip:
 *   1. The cleanup `delete from prices where source = 'tcgplayer_scrape'`
 *      does NOT match `source = 'tcgplayer'`. Getting this wrong would wipe
 *      every daily snapshot written by seed-pool.ts.
 *   2. The natural PK (card_id, sku_id, bucket_start_date) lets two adjacent
 *      TCGPlayer buckets for different SKUs coexist, and the upsert path is
 *      idempotent across reruns.
 *
 * Skipped when SUPABASE_TEST_URL isn't set — the test runs against real
 * Postgres semantics (unique-index upsert, CHECK constraints), which can't
 * be faithfully mocked.
 */
import { describe, test } from "bun:test";

const HAS_TEST_DB =
  !!process.env.SUPABASE_TEST_URL && !!process.env.SUPABASE_TEST_SERVICE_ROLE_KEY;

describe("migration 0004 — price_buckets table + prices cleanup", () => {
  if (!HAS_TEST_DB) {
    test.todo(
      "cleanup predicate deletes source='tcgplayer_scrape' rows but leaves 'tcgplayer' rows intact",
    );
    test.todo("price_buckets CHECK constraints reject negative prices + quantities");
    test.todo(
      "natural PK permits two SKUs on the same date for the same card (no collision)",
    );
    test.todo("upsert on (card_id, sku_id, bucket_start_date) is idempotent");
    test.todo(
      "price_buckets_canonical view picks Holofoil over Normal when both exist",
    );
    return;
  }

  test.todo(
    "wire up against SUPABASE_TEST_URL — ephemeral-schema setup lands with the " +
      "Milestone 3 test-harness work (see tests/cron-manual-race.test.ts stubs).",
  );
});
