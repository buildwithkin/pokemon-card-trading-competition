#!/usr/bin/env bun
/**
 * One-off recon: open a TCGPlayer product page in a real browser, intercept
 * every network call, and log anything that looks like a sales-history or
 * price-history request. Goal is to discover the actual endpoint (URL, method,
 * body, auth headers) behind the "Sales History Snapshot" modal so the
 * plain-fetch scraper can call it directly.
 *
 * Usage:
 *   bun run scripts/probe-sales-endpoint.ts [productId]
 */
import { chromium } from "playwright";

const PRODUCT_ID = process.argv[2] ?? "685511";
const PAGE_URL = `https://www.tcgplayer.com/product/${PRODUCT_ID}`;

const INTERESTING = /sales|history|latestsales|transaction/i;

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    viewport: { width: 1440, height: 900 },
  });
  const page = await context.newPage();

  const seen: Array<{ url: string; method: string; body: string | null }> = [];

  page.on("request", (req) => {
    const url = req.url();
    if (!INTERESTING.test(url)) return;
    seen.push({
      url,
      method: req.method(),
      body: req.postData(),
    });
  });

  page.on("response", async (res) => {
    const url = res.url();
    if (!INTERESTING.test(url)) return;
    const headers = res.request().headers();
    const relevantHeaders = Object.fromEntries(
      Object.entries(headers).filter(([k]) =>
        /^(authorization|x-|cookie|referer|origin|content-type|accept)/i.test(k),
      ),
    );
    let bodyPreview = "";
    try {
      const txt = await res.text();
      bodyPreview = txt.slice(0, 400);
    } catch {}
    console.log("─".repeat(80));
    console.log(`${res.status()} ${res.request().method()} ${url}`);
    console.log("  request headers:", JSON.stringify(relevantHeaders, null, 2));
    if (res.request().postData()) {
      console.log("  request body:", res.request().postData());
    }
    console.log("  response preview:", bodyPreview);
  });

  console.log(`🌐 loading ${PAGE_URL}\n`);
  await page.goto(PAGE_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(3000);

  // Try to open the Sales History modal. Button text varies — try a few.
  console.log("\n🖱  attempting to open sales history modal...\n");
  const candidates = [
    /sales history/i,
    /view more data/i,
    /latest sales/i,
    /market price/i,
  ];
  for (const rx of candidates) {
    const loc = page.getByText(rx).first();
    try {
      if (await loc.isVisible({ timeout: 500 })) {
        await loc.click({ timeout: 2000 });
        console.log(`   clicked "${rx}"`);
        await page.waitForTimeout(2500);
        break;
      }
    } catch {}
  }

  // Scroll — some pages lazy-load sales data.
  await page.mouse.wheel(0, 2000);
  await page.waitForTimeout(1500);
  await page.mouse.wheel(0, 2000);
  await page.waitForTimeout(1500);

  console.log("\n═══════════════════════════════════════════════════════════");
  console.log(`captured ${seen.length} interesting request(s):`);
  console.log("═══════════════════════════════════════════════════════════");
  for (const r of seen) {
    console.log(`  ${r.method}  ${r.url}`);
    if (r.body) console.log(`    body: ${r.body}`);
  }

  await browser.close();
}

main().catch((e) => {
  console.error("fatal:", e);
  process.exit(1);
});
