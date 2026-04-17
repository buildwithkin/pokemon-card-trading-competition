#!/usr/bin/env bun
/**
 * Layer 1/2 backfill — pull 3 months of TCGPlayer detailed price history per
 * card from the public JSON endpoint and bulk-upsert into `price_buckets`.
 *
 * Endpoint (public, no auth required as of 2026-04-16):
 *   GET https://infinite-api.tcgplayer.com/price/history/{productId}/detailed?range=quarter
 *
 * The response is one object per SKU (variant + condition + language) and
 * each SKU owns a `buckets[]` array of 3-day-wide aggregate rows. One HTTP
 * call per card yields the full quarter — no browser, no DOM scraping.
 *
 * Flow:
 *   1. Backfill `cards.tcgplayer_url` for any card missing it (one-time
 *      pokemontcg.io → TCGPlayer redirect resolution).
 *   2. For each card, skip if it has any `price_buckets` row written within
 *      the last RECENT_BACKFILL_DAYS.
 *   3. Otherwise: extract productId from the canonical URL, fetch the JSON,
 *      parse buckets across all SKUs, upsert into `price_buckets`.
 *
 * Idempotent: rerun safely. PK (card_id, sku_id, bucket_start_date) blocks
 * duplicates. TCGPlayer carries forward marketPrice on zero-sale days — we
 * store those rows too so the chart has a continuous series.
 *
 * Usage:
 *   bun run seed:history
 *   bun run seed:history --concurrency 8
 *   bun run seed:history --card-id me1-1            # one card, for debugging
 *   bun run seed:history --limit 10                 # cap how many cards
 *   bun run seed:history --force                    # re-scrape even backfilled
 */
import { adminClient } from "../src/lib/supabase/admin";

// ---------- CLI ----------
const args = process.argv.slice(2);
function getArg(flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : undefined;
}
function hasFlag(flag: string): boolean {
  return args.includes(flag);
}
const CONCURRENCY = parseInt(getArg("--concurrency") ?? "2", 10);
const ONLY_CARD = getArg("--card-id");
const LIMIT = getArg("--limit") ? parseInt(getArg("--limit")!, 10) : undefined;
const FORCE = hasFlag("--force");
// TCGPlayer infinite-api accepts: month, quarter, semiannual, annual.
// Wider ranges return wider buckets (e.g. annual ≈ weekly buckets), so more
// calendar coverage but coarser granularity.
const RANGE = getArg("--range") ?? "quarter";

// Recency skip — don't re-scrape cards with buckets written in the last N days.
// Bucket-level rescrape just overwrites the same rows via PK upsert; this
// threshold exists to avoid hammering TCGPlayer on repeated runs during dev.
const RECENT_BACKFILL_DAYS = 1;

// ---------- pokemontcg.io URL backfill ----------
//
// We store the CANONICAL TCGPlayer product URL with query params that anchor
// the page (chart defaults) to Near Mint Holofoil. The JSON endpoint doesn't
// care about those params — it returns every variant/condition — but the URL
// stays human-shaped for ops clicks and for anyone who wants to sanity-check
// the data by hand.

type PokemonCard = {
  id: string;
  set: { id: string };
  number: string;
  tcgplayer?: { url?: string };
};

const CANONICAL_PARAMS = "?Condition=Near+Mint&Printing=Holofoil&Language=English";
const REDIRECT_HOST_PREFIX = "https://prices.pokemontcg.io/";

async function fetchPokemonTcgRedirectUrl(
  cardId: string,
): Promise<string | null> {
  const key = process.env.POKEMONTCG_API_KEY;
  const headers: HeadersInit = key ? { "X-Api-Key": key } : {};
  const res = await fetch(`https://api.pokemontcg.io/v2/cards/${cardId}`, {
    headers,
  });
  if (!res.ok) return null;
  const body = (await res.json()) as { data: PokemonCard };
  return body.data.tcgplayer?.url ?? null;
}

async function resolveCanonicalProductUrl(
  cardId: string,
): Promise<string | null> {
  const redirectUrl = await fetchPokemonTcgRedirectUrl(cardId);
  if (!redirectUrl) return null;
  try {
    const res = await fetch(redirectUrl, { method: "HEAD", redirect: "follow" });
    const finalUrl = new URL(res.url);
    if (!/tcgplayer\.com$/.test(finalUrl.hostname)) return null;
    if (!/^\/product\/\d+/.test(finalUrl.pathname)) return null;
    return `${finalUrl.origin}${finalUrl.pathname}${CANONICAL_PARAMS}`;
  } catch {
    return null;
  }
}

async function backfillCardUrls(): Promise<void> {
  const client = adminClient();
  const { data: needing, error } = await client
    .from("cards")
    .select("card_id, tcgplayer_url")
    .or(`tcgplayer_url.is.null,tcgplayer_url.like.${REDIRECT_HOST_PREFIX}%`);
  if (error) throw new Error(`load cards needing url resolve: ${error.message}`);
  if (!needing || needing.length === 0) {
    console.log("✓ All cards already have a canonical tcgplayer_url");
    return;
  }
  const total = needing.length;
  console.log(
    `🔗 Resolving canonical TCGPlayer URLs for ${total} cards (legacy or null)...`,
  );

  let filled = 0;
  let stillMissing = 0;
  const t0 = Date.now();
  for (let i = 0; i < needing.length; i++) {
    const row = needing[i];
    const url = await resolveCanonicalProductUrl(row.card_id);
    if (url) {
      const { error: upErr } = await client
        .from("cards")
        .update({ tcgplayer_url: url })
        .eq("card_id", row.card_id);
      if (upErr) {
        console.warn(`  ⚠️  ${row.card_id}: update failed — ${upErr.message}`);
      } else {
        filled++;
      }
    } else {
      stillMissing++;
    }
    if ((i + 1) % 10 === 0 || i === total - 1) {
      const pct = Math.floor(((i + 1) / total) * 100);
      const elapsed = (Date.now() - t0) / 1000;
      const eta = (elapsed / (i + 1)) * (total - i - 1);
      process.stdout.write(
        `\r   [${i + 1}/${total}] ${pct}%  resolved=${filled} unresolved=${stillMissing}  eta ${fmtDuration(eta)}       `,
      );
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  process.stdout.write("\n");
  console.log(`   ✓ done — resolved ${filled}, unresolved ${stillMissing}\n`);
}

function fmtDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "?";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  if (m === 0) return `${s}s`;
  return `${m}m${s.toString().padStart(2, "0")}s`;
}

// ---------- JSON endpoint types ----------

type DetailedBucket = {
  marketPrice: string;
  quantitySold: string;
  lowSalePrice: string;
  lowSalePriceWithShipping: string;
  highSalePrice: string;
  highSalePriceWithShipping: string;
  transactionCount: string;
  bucketStartDate: string;
};

type DetailedSku = {
  skuId: string;
  variant: string;
  language: string;
  condition: string;
  buckets: DetailedBucket[];
};

type DetailedHistoryResponse = {
  count: number;
  result: DetailedSku[];
};

type PriceBucketRow = {
  card_id: string;
  sku_id: string;
  bucket_start_date: string;
  condition: string;
  variant: string;
  language: string;
  market_price_usd: number;
  low_sale_usd: number | null;
  high_sale_usd: number | null;
  low_sale_ship_usd: number | null;
  high_sale_ship_usd: number | null;
  quantity_sold: number;
  transaction_count: number;
  source: "tcgplayer_detailed_history";
};

type FetchOutcome =
  | { kind: "rows"; rows: PriceBucketRow[]; skuCount: number }
  | { kind: "skip"; reason: string }
  | { kind: "error"; reason: string };

/**
 * Parse one TCGPlayer product ID out of the stored canonical URL.
 *   https://www.tcgplayer.com/product/654519?... → "654519"
 * Returns null if the URL doesn't look like a TCGPlayer product page — the
 * caller skips that card rather than hitting the JSON endpoint with garbage.
 */
export function productIdFromUrl(url: string): string | null {
  try {
    const u = new URL(url);
    if (!/tcgplayer\.com$/.test(u.hostname)) return null;
    const m = u.pathname.match(/^\/product\/(\d+)/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/** Parse a numeric string from the JSON payload. "62.83" → 62.83. "" → null. */
export function parseNumeric(raw: string): number | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * Map one SKU's buckets[] into PriceBucketRow[]. Zero-sale buckets still have
 * a marketPrice (TCGPlayer carries it forward); we keep those rows so the
 * chart series is continuous. low/high/transaction fields are null on zero
 * days because their TCGPlayer representation ("0") is semantically "no data",
 * not "$0 trades."
 */
export function rowsFromSku(cardId: string, sku: DetailedSku): PriceBucketRow[] {
  const out: PriceBucketRow[] = [];
  for (const b of sku.buckets) {
    const market = parseNumeric(b.marketPrice);
    if (market === null) continue; // garbage bucket — skip

    const qty = parseNumeric(b.quantitySold) ?? 0;
    const txCount = parseNumeric(b.transactionCount) ?? 0;
    const hasSales = qty > 0 || txCount > 0;

    out.push({
      card_id: cardId,
      sku_id: String(sku.skuId),
      bucket_start_date: b.bucketStartDate,
      condition: sku.condition,
      variant: sku.variant,
      language: sku.language || "English",
      market_price_usd: market,
      low_sale_usd: hasSales ? parseNumeric(b.lowSalePrice) : null,
      high_sale_usd: hasSales ? parseNumeric(b.highSalePrice) : null,
      low_sale_ship_usd: hasSales
        ? parseNumeric(b.lowSalePriceWithShipping)
        : null,
      high_sale_ship_usd: hasSales
        ? parseNumeric(b.highSalePriceWithShipping)
        : null,
      quantity_sold: Math.round(qty),
      transaction_count: Math.round(txCount),
      source: "tcgplayer_detailed_history",
    });
  }
  return out;
}

const HISTORY_HEADERS: HeadersInit = {
  "content-type": "application/json",
  accept: "application/json",
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  origin: "https://www.tcgplayer.com",
};

// Retry schedule for 429 / 5xx / transport errors. Progression is 2s → 8s →
// 30s so a brief throttle doesn't kill the run but we also don't wait forever.
const RETRY_DELAYS_MS = [2_000, 8_000, 30_000];

function parseRetryAfterMs(header: string | null): number | null {
  if (!header) return null;
  const asSeconds = Number(header);
  if (Number.isFinite(asSeconds)) return Math.max(0, asSeconds * 1000);
  const asDate = Date.parse(header);
  if (Number.isFinite(asDate)) return Math.max(0, asDate - Date.now());
  return null;
}

async function fetchCardHistory(
  cardId: string,
  productId: string,
): Promise<FetchOutcome> {
  const url = `https://infinite-api.tcgplayer.com/price/history/${productId}/detailed?range=${RANGE}`;
  let lastReason = "unknown";

  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      const res = await fetch(url, {
        method: "GET",
        headers: {
          ...HISTORY_HEADERS,
          referer: `https://www.tcgplayer.com/product/${productId}`,
        },
      });

      if (res.ok) {
        const body = (await res.json()) as DetailedHistoryResponse;
        if (!Array.isArray(body.result) || body.result.length === 0) {
          return { kind: "skip", reason: "empty result" };
        }
        const allRows: PriceBucketRow[] = [];
        for (const sku of body.result) {
          allRows.push(...rowsFromSku(cardId, sku));
        }
        if (allRows.length === 0) {
          return { kind: "skip", reason: "no usable buckets" };
        }
        return { kind: "rows", rows: allRows, skuCount: body.result.length };
      }

      lastReason = `HTTP ${res.status} ${res.statusText}`;
      const isRetryable = res.status === 429 || res.status >= 500;
      if (!isRetryable || attempt === RETRY_DELAYS_MS.length) {
        return { kind: "error", reason: lastReason };
      }
      const retryAfter = parseRetryAfterMs(res.headers.get("retry-after"));
      const waitMs = Math.max(retryAfter ?? 0, RETRY_DELAYS_MS[attempt]);
      console.log(
        `     ↻ ${cardId} ${lastReason} — retry ${attempt + 1}/${RETRY_DELAYS_MS.length} in ${Math.round(waitMs / 1000)}s`,
      );
      await new Promise((r) => setTimeout(r, waitMs));
    } catch (e) {
      lastReason = e instanceof Error ? e.message : String(e);
      if (attempt === RETRY_DELAYS_MS.length) {
        return { kind: "error", reason: lastReason };
      }
      const waitMs = RETRY_DELAYS_MS[attempt];
      console.log(
        `     ↻ ${cardId} transport error (${lastReason}) — retry ${attempt + 1}/${RETRY_DELAYS_MS.length} in ${Math.round(waitMs / 1000)}s`,
      );
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }

  return { kind: "error", reason: lastReason };
}

// ---------- DB helpers ----------
async function loadCardsToProcess(): Promise<
  Array<{ card_id: string; tcgplayer_url: string }>
> {
  const client = adminClient();
  let q = client
    .from("cards")
    .select("card_id, tcgplayer_url")
    .not("tcgplayer_url", "is", null);
  if (ONLY_CARD) q = q.eq("card_id", ONLY_CARD);
  const { data, error } = await q;
  if (error) throw new Error(`load cards: ${error.message}`);
  return (data ?? []) as Array<{ card_id: string; tcgplayer_url: string }>;
}

async function alreadyBackfilledIds(): Promise<Set<string>> {
  if (FORCE) return new Set();
  const client = adminClient();
  const cutoff = new Date(Date.now() - RECENT_BACKFILL_DAYS * 86_400_000)
    .toISOString();
  const done = new Set<string>();
  let from = 0;
  const step = 1000;
  while (true) {
    const { data, error } = await client
      .from("price_buckets")
      .select("card_id")
      .gte("scraped_at", cutoff)
      .range(from, from + step - 1);
    if (error) throw new Error(`load recent buckets: ${error.message}`);
    if (!data || data.length === 0) break;
    for (const r of data) done.add(r.card_id);
    if (data.length < step) break;
    from += step;
  }
  return done;
}

async function persistRows(rows: PriceBucketRow[]): Promise<void> {
  if (rows.length === 0) return;
  const client = adminClient();
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const { error } = await client
      .from("price_buckets")
      .upsert(chunk, { onConflict: "card_id,sku_id,bucket_start_date" });
    if (error) throw new Error(`upsert price_buckets: ${error.message}`);
  }
}

// ---------- Worker pool ----------
type Job = { card_id: string; tcgplayer_url: string };
type WorkResult = { card_id: string; outcome: FetchOutcome };

async function runWorkers(queue: Job[]): Promise<WorkResult[]> {
  const results: WorkResult[] = [];
  let next = 0;
  let completed = 0;
  let okCount = 0;
  let skipCount = 0;
  let errCount = 0;
  let totalRows = 0;
  const total = queue.length;
  const tRunStart = Date.now();

  async function worker(workerId: number) {
    while (true) {
      const idx = next++;
      if (idx >= queue.length) break;
      const job = queue[idx];
      const t0 = Date.now();

      const productId = productIdFromUrl(job.tcgplayer_url);
      let outcome: FetchOutcome;
      if (!productId) {
        outcome = {
          kind: "skip",
          reason: `bad tcgplayer_url: ${job.tcgplayer_url}`,
        };
      } else {
        outcome = await fetchCardHistory(job.card_id, productId);
        if (outcome.kind === "rows") {
          try {
            await persistRows(outcome.rows);
            totalRows += outcome.rows.length;
          } catch (e) {
            outcome = {
              kind: "error",
              reason: e instanceof Error ? e.message : String(e),
            };
          }
        }
      }

      let summary: string;
      if (outcome.kind === "rows") {
        summary = `✓ ${outcome.rows.length} rows (${outcome.skuCount} sku)`;
        okCount++;
      } else if (outcome.kind === "skip") {
        summary = `⊝ skip: ${outcome.reason}`;
        skipCount++;
      } else {
        summary = `✗ ${outcome.reason}`;
        errCount++;
      }

      completed++;
      const ms = Date.now() - t0;
      const pct = Math.floor((completed / total) * 100);
      const elapsed = (Date.now() - tRunStart) / 1000;
      const avg = elapsed / completed;
      const eta = avg * (total - completed);
      console.log(
        `  [${completed.toString().padStart(3)}/${total}] ${pct.toString().padStart(3)}% w${workerId}  ${job.card_id.padEnd(14)}  ${summary}  (${ms}ms)  ok=${okCount} skip=${skipCount} err=${errCount} rows=${totalRows}  eta ${fmtDuration(eta)}`,
      );
      results.push({ card_id: job.card_id, outcome });

      // Politeness — TCGPlayer IP-rate-limits aggressive scraping (observed
      // cutoff ~300 cards at 6 workers × 250ms). At concurrency=2 with this
      // delay, effective rate is ~2 req/sec — slower but survives a full run.
      await new Promise((r) => setTimeout(r, 800 + Math.floor(Math.random() * 400)));
    }
  }

  await Promise.all(
    Array.from({ length: CONCURRENCY }, (_, i) => worker(i + 1)),
  );
  return results;
}

// ---------- Main ----------
async function main() {
  console.log(
    `📊 scrape-price-history  |  range=${RANGE}  concurrency=${CONCURRENCY}  recent-skip=${RECENT_BACKFILL_DAYS}d  ${FORCE ? "(FORCE)" : ""}\n`,
  );

  await backfillCardUrls();

  const allCards = await loadCardsToProcess();
  if (allCards.length === 0) {
    console.log(
      "❌ No cards with tcgplayer_url to scrape (run seed:pool first?).",
    );
    process.exit(1);
  }

  const done = await alreadyBackfilledIds();
  const remaining = allCards.filter((c) => !done.has(c.card_id));
  const queue = LIMIT ? remaining.slice(0, LIMIT) : remaining;

  if (queue.length === 0) {
    console.log(
      `🃏 ${allCards.length} cards total  |  ${allCards.length - queue.length} already backfilled  |  0 to scrape`,
    );
    console.log("✨ Nothing to do.");
    return;
  }

  const skippedRecent = allCards.length - remaining.length;
  console.log(
    `🃏 ${queue.length} to scrape  |  ${skippedRecent} already done (within ${RECENT_BACKFILL_DAYS}d)`,
  );
  const estSec = Math.round((queue.length * 1.3) / CONCURRENCY);
  console.log(
    `   ⏱  rough eta: ${fmtDuration(estSec)} at concurrency=${CONCURRENCY}\n`,
  );

  const results = await runWorkers(queue);

  const ok = results.filter((r) => r.outcome.kind === "rows").length;
  const skip = results.filter((r) => r.outcome.kind === "skip").length;
  const err = results.filter((r) => r.outcome.kind === "error").length;

  console.log("\n═══════════════════════════════════════════════════════════");
  console.log(
    `SCRAPE COMPLETE  —  ${ok} ok  |  ${skip} skipped  |  ${err} errored`,
  );
  console.log("═══════════════════════════════════════════════════════════");

  if (err > 0) {
    console.log("\nFirst 10 errors:");
    const errors = results.filter((r) => r.outcome.kind === "error").slice(0, 10);
    for (const r of errors) {
      if (r.outcome.kind === "error") {
        console.log(`  ${r.card_id}  —  ${r.outcome.reason}`);
      }
    }
  }
}

process.on("SIGINT", () => {
  console.log("\n\n⏸  interrupted — any completed buckets are persisted.");
  process.exit(130);
});

// Only run main when invoked directly. Letting tests import the file doesn't
// kick off a real scrape.
if (import.meta.main) {
  main().catch((err) => {
    console.error("\n❌ Fatal:", err);
    process.exit(1);
  });
}
