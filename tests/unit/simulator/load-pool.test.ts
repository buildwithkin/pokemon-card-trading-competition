/**
 * loadHistoricalPool + listAvailableBucketDates — DB-dependent behavior tests.
 * Currently todo stubs; fill in once a local Supabase harness lands.
 */
import { describe, test } from "bun:test";

describe("listAvailableBucketDates", () => {
  test.todo("returns distinct dates sorted ascending");
  test.todo("returns [] when price_buckets_canonical is empty");
});

describe("loadHistoricalPool", () => {
  test.todo(
    "returns one PoolCard per card that has a bucket at the given date",
  );
  test.todo("excludes cards that have no bucket on the given date");
  test.todo(
    "market_price_usd matches the price_buckets_canonical row for that (card, date)",
  );
  test.todo("returns [] when no cards have a bucket on the given date");
  test.todo("coerces numeric(10,2) string from supabase-js into JS number");
});
