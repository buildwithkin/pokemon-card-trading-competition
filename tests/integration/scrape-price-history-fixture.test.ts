/**
 * Fixture-based integration test for the scraper's JSON ingestion path.
 *
 * Mocks global fetch to return the saved TCGPlayer detailed-history payload
 * (tests/fixtures/tcgplayer-detailed-history.json), then drives the
 * scraper's parsing + row-mapping end-to-end without hitting the network
 * or the database. Catches:
 *   - response shape drift (keys renamed, types flipped)
 *   - row counts across multiple SKUs in one response
 *   - zero-sale bucket preservation (chart continuity regression)
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fixture from "../fixtures/tcgplayer-detailed-history.json" with { type: "json" };
import { rowsFromSku } from "../../scripts/scrape-price-history";

type FetchFn = typeof fetch;

describe("scraper — fixture-driven JSON ingestion", () => {
  let originalFetch: FetchFn;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request) => {
      const href = typeof url === "string" ? url : url.toString();
      if (href.includes("/price/history/") && href.includes("detailed")) {
        return new Response(JSON.stringify(fixture), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected fetch in test: ${href}`);
    }) as FetchFn;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("fixture parses into the expected total row count", () => {
    const allRows = fixture.result.flatMap((sku) =>
      rowsFromSku("me1-180", sku as any),
    );
    // 3 NM/Holofoil + 1 LP/Holofoil + 0 NM/Reverse-Holofoil = 4 total
    expect(allRows.length).toBe(4);
  });

  test("every emitted row carries card_id, sku_id, and source", () => {
    const allRows = fixture.result.flatMap((sku) =>
      rowsFromSku("me1-180", sku as any),
    );
    for (const r of allRows) {
      expect(r.card_id).toBe("me1-180");
      expect(r.sku_id).toBeString();
      expect(r.source).toBe("tcgplayer_detailed_history");
    }
  });

  test("all variants + conditions round-trip from fixture", () => {
    const allRows = fixture.result.flatMap((sku) =>
      rowsFromSku("me1-180", sku as any),
    );
    const pairs = new Set(
      allRows.map((r) => `${r.condition}|${r.variant}`),
    );
    // Fixture has two active SKUs; empty-bucket SKU emits nothing.
    expect(pairs.has("Near Mint|Holofoil")).toBe(true);
    expect(pairs.has("Lightly Played|Holofoil")).toBe(true);
  });

  test("bucket_start_date ordering from TCGPlayer is newest-first and round-trips unchanged", () => {
    // TCGPlayer's fixture response comes newest-first. We preserve that
    // ordering into the row array — the DB upsert doesn't care, but the
    // count-no-prices coverage report does.
    const rows = rowsFromSku(
      "me1-180",
      fixture.result[0] as any,
    );
    expect(rows.map((r) => r.bucket_start_date)).toEqual([
      "2026-04-14",
      "2026-04-11",
      "2026-01-25",
    ]);
  });

  test("regression — zero-sale buckets preserve marketPrice, null out trade fields", () => {
    // Migration comment promises: we store zero-sale buckets so charts draw
    // a continuous line. The low/high/count fields must be null, not 0,
    // because "$0 trades" is meaningless — lock this in.
    const rows = rowsFromSku("me1-180", fixture.result[0] as any);
    const zero = rows.find((r) => r.bucket_start_date === "2026-01-25");
    expect(zero).toBeDefined();
    expect(zero!.market_price_usd).toBeGreaterThan(0);
    expect(zero!.quantity_sold).toBe(0);
    expect(zero!.transaction_count).toBe(0);
    expect(zero!.low_sale_usd).toBeNull();
    expect(zero!.high_sale_usd).toBeNull();
  });
});
