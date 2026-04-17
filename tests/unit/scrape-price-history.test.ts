/**
 * Unit tests for the pure helpers exported from
 * scripts/scrape-price-history.ts. These exercise the parsing + mapping
 * paths that turn TCGPlayer JSON into rows we persist — they're the thing
 * most likely to regress if TCGPlayer's payload shape changes.
 *
 * Does NOT touch the network or the database.
 */
import { describe, expect, test } from "bun:test";
import {
  parseNumeric,
  productIdFromUrl,
  rowsFromSku,
} from "../../scripts/scrape-price-history";
import fixture from "../fixtures/tcgplayer-detailed-history.json" with { type: "json" };

describe("productIdFromUrl", () => {
  test("extracts id from the canonical URL", () => {
    expect(
      productIdFromUrl(
        "https://www.tcgplayer.com/product/654519?Condition=Near+Mint&Printing=Holofoil&Language=English",
      ),
    ).toBe("654519");
  });

  test("works without query params", () => {
    expect(productIdFromUrl("https://www.tcgplayer.com/product/490071")).toBe(
      "490071",
    );
  });

  test("rejects non-TCGPlayer hosts", () => {
    // Legacy prices.pokemontcg.io redirect — we only accept the resolved URL
    // because the JSON endpoint is keyed on the numeric product id.
    expect(
      productIdFromUrl("https://prices.pokemontcg.io/tcgplayer/me1-180"),
    ).toBeNull();
  });

  test("rejects TCGPlayer URLs that aren't product pages", () => {
    expect(productIdFromUrl("https://www.tcgplayer.com/search?q=pikachu")).toBeNull();
  });

  test("rejects garbage input without throwing", () => {
    expect(productIdFromUrl("not a url")).toBeNull();
    expect(productIdFromUrl("")).toBeNull();
  });
});

describe("parseNumeric", () => {
  test("parses a simple numeric string", () => {
    expect(parseNumeric("62.83")).toBe(62.83);
  });

  test("parses an integer string as a number", () => {
    expect(parseNumeric("14")).toBe(14);
  });

  test("returns null on empty string", () => {
    expect(parseNumeric("")).toBeNull();
  });

  test("returns null on NaN", () => {
    expect(parseNumeric("abc")).toBeNull();
  });

  test("trims whitespace", () => {
    expect(parseNumeric("  42  ")).toBe(42);
  });

  test("zero is a valid numeric (TCGPlayer uses it as a carry-forward signal)", () => {
    // rowsFromSku decides how to interpret zero — parseNumeric just parses.
    expect(parseNumeric("0")).toBe(0);
  });
});

describe("rowsFromSku", () => {
  // Pluck the fixture SKUs for use across assertions.
  const sku_nm_holo = fixture.result.find((s) => s.skuId === "8938020")!;
  const sku_lp_holo = fixture.result.find((s) => s.skuId === "8938021")!;
  const sku_nm_reverse = fixture.result.find((s) => s.skuId === "8938022")!;

  test("maps a healthy bucket into a row with every field populated", () => {
    const rows = rowsFromSku("me1-180", sku_nm_holo);
    const r = rows.find((x) => x.bucket_start_date === "2026-04-14")!;
    expect(r).toBeDefined();
    expect(r.card_id).toBe("me1-180");
    expect(r.sku_id).toBe("8938020");
    expect(r.condition).toBe("Near Mint");
    expect(r.variant).toBe("Holofoil");
    expect(r.language).toBe("English");
    expect(r.market_price_usd).toBe(62.83);
    expect(r.low_sale_usd).toBe(58.1);
    expect(r.high_sale_usd).toBe(68.4);
    expect(r.low_sale_ship_usd).toBe(59.41);
    expect(r.high_sale_ship_usd).toBe(88.39);
    expect(r.quantity_sold).toBe(14);
    expect(r.transaction_count).toBe(14);
    expect(r.source).toBe("tcgplayer_detailed_history");
  });

  test("preserves zero-sale buckets (chart continuity) but nulls out trade fields", () => {
    // 2026-01-25 had 0 trades — TCGPlayer carries forward the last market
    // price. We keep the bucket row so the chart draws a continuous line,
    // but we set low/high/ship fields to null because "0" in those fields
    // is semantically "no data," not "$0 trades."
    const rows = rowsFromSku("me1-180", sku_nm_holo);
    const r = rows.find((x) => x.bucket_start_date === "2026-01-25")!;
    expect(r).toBeDefined();
    expect(r.market_price_usd).toBe(66.63);
    expect(r.quantity_sold).toBe(0);
    expect(r.transaction_count).toBe(0);
    expect(r.low_sale_usd).toBeNull();
    expect(r.high_sale_usd).toBeNull();
    expect(r.low_sale_ship_usd).toBeNull();
    expect(r.high_sale_ship_usd).toBeNull();
  });

  test("returns the correct number of rows for a SKU", () => {
    const rows = rowsFromSku("me1-180", sku_nm_holo);
    expect(rows.length).toBe(3); // fixture has three buckets for this SKU
  });

  test("emits one row per (sku, bucket) across multiple conditions", () => {
    const rowsA = rowsFromSku("me1-180", sku_nm_holo);
    const rowsB = rowsFromSku("me1-180", sku_lp_holo);
    // Every row carries its own sku_id — the PK in the DB is
    // (card_id, sku_id, bucket_start_date) so two SKUs on the same date
    // coexist without collision.
    expect(rowsA.every((r) => r.sku_id === "8938020")).toBe(true);
    expect(rowsB.every((r) => r.sku_id === "8938021")).toBe(true);
  });

  test("maps Lightly Played condition through unchanged", () => {
    const rows = rowsFromSku("me1-180", sku_lp_holo);
    expect(rows[0].condition).toBe("Lightly Played");
    expect(rows[0].market_price_usd).toBe(54.5);
  });

  test("empty buckets[] emits zero rows, doesn't throw", () => {
    const rows = rowsFromSku("me1-180", sku_nm_reverse);
    expect(rows).toEqual([]);
  });

  test("card_id is passed through verbatim", () => {
    const rows = rowsFromSku("sv8pt5-161", sku_nm_holo);
    expect(rows.every((r) => r.card_id === "sv8pt5-161")).toBe(true);
  });

  test("skips buckets with unparseable marketPrice", () => {
    const corrupt = {
      ...sku_nm_holo,
      buckets: [
        ...sku_nm_holo.buckets,
        {
          marketPrice: "",
          quantitySold: "5",
          lowSalePrice: "10",
          lowSalePriceWithShipping: "11",
          highSalePrice: "12",
          highSalePriceWithShipping: "13",
          transactionCount: "5",
          bucketStartDate: "2026-04-17",
        },
      ],
    };
    const rows = rowsFromSku("me1-180", corrupt);
    // 3 from the fixture; the corrupt fourth bucket is dropped.
    expect(rows.length).toBe(3);
    expect(rows.find((r) => r.bucket_start_date === "2026-04-17")).toBeUndefined();
  });
});
