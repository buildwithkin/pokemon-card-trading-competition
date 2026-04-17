-- Migration 0004: TCGPlayer detailed price-history bucket table.
--
-- Rationale
-- ---------
-- TCGPlayer's product page renders its 3-month price chart from the public
-- JSON endpoint:
--
--   GET https://infinite-api.tcgplayer.com/price/history/{id}/detailed?range=quarter
--
-- The response is a list of SKUs (one per variant+condition+language combo)
-- and each SKU owns a `buckets[]` array of 3-day-wide aggregate rows:
--
--   { bucketStartDate, marketPrice, lowSalePrice, highSalePrice,
--     lowSalePriceWithShipping, highSalePriceWithShipping,
--     quantitySold, transactionCount }
--
-- That's the same data the tooltip surfaces — pre-aggregated, per SKU, per
-- 3-day window, covering ~90 days. Individual transactions aren't exposed to
-- anonymous users (latestsales endpoint is gated to ~5-25 rows by the
-- `be_limit_sales_data_for_anon_users` feature flag), so the bucket level is
-- the finest grain TCGPlayer actually gives us for a full quarter.
--
-- Two tables, two jobs:
--   - `prices`        — daily pokemontcg.io snapshot. Keeps today's working
--                       market price in case scraper runs lag.  UNCHANGED.
--   - `price_buckets` — 3-day TCGPlayer aggregates across the last quarter.
--                       "What has actually sold, in what condition, what
--                       variant, at what price, in what volume."
--
-- The old scraper (scripts/scrape-price-history.ts pre-0004) wrote collapsed
-- bucket end-date rows into `prices` with source='tcgplayer_scrape'. Those
-- are semantically stale — delete them; the new scraper re-populates from
-- the JSON endpoint into `price_buckets`.

create table price_buckets (
  card_id              text        not null references cards(card_id) on delete cascade,
  sku_id               text        not null,
  bucket_start_date    date        not null,
  condition            text        not null,
  variant              text        not null,
  language             text        not null default 'English',
  market_price_usd     numeric(10,2) not null check (market_price_usd >= 0),
  low_sale_usd         numeric(10,2),
  high_sale_usd        numeric(10,2),
  low_sale_ship_usd    numeric(10,2),
  high_sale_ship_usd   numeric(10,2),
  quantity_sold        int         not null default 0 check (quantity_sold >= 0),
  transaction_count    int         not null default 0 check (transaction_count >= 0),
  source               text        not null default 'tcgplayer_detailed_history',
  scraped_at           timestamptz not null default now(),
  primary key (card_id, sku_id, bucket_start_date)
);

-- Hot paths:
--   1) chart endpoint: "give me all buckets for this card, newest first"
--   2) bot tool:       "give me the last 14 days per (condition, variant)"
--   3) ops:            "which cards have no recent buckets?"
create index price_buckets_card_date_idx      on price_buckets (card_id, bucket_start_date desc);
create index price_buckets_date_idx           on price_buckets (bucket_start_date desc);
create index price_buckets_card_variant_idx   on price_buckets (card_id, condition, variant, bucket_start_date desc);

alter table price_buckets enable row level security;
create policy "public read price_buckets" on price_buckets for select using (true);

-- Convenience view: canonical printing (Near Mint + best-available variant per
-- card), one row per bucket. Matches the VARIANT_PRIORITY the scraper uses for
-- pokemontcg.io daily snapshots so chart reads see a single coherent series.
create or replace view price_buckets_canonical as
  select distinct on (card_id, bucket_start_date)
    card_id,
    bucket_start_date,
    condition,
    variant,
    market_price_usd,
    low_sale_usd,
    high_sale_usd,
    quantity_sold,
    transaction_count
  from price_buckets
  where condition = 'Near Mint'
  order by
    card_id,
    bucket_start_date,
    case variant
      when 'Holofoil'              then 1
      when 'Normal'                then 2
      when 'Reverse Holofoil'      then 3
      when '1st Edition Holofoil'  then 4
      when '1st Edition'           then 5
      when 'Unlimited Holofoil'    then 6
      when 'Unlimited'             then 7
      else 99
    end;

-- Clean up stale rows from the old bucket-collapsing scraper. The equality
-- predicate is exact — `source = 'tcgplayer_scrape'` will never match
-- `'tcgplayer'`. Regression test in tests/integration/migration-0004.test.ts
-- locks this in.
delete from prices where source = 'tcgplayer_scrape';

comment on table price_buckets is
  'TCGPlayer detailed-history 3-day aggregate buckets. One row per '
  '(card, sku, bucket_start_date). Backs the 3-month price chart and '
  'liquidity-aware bot decisions.';
comment on column price_buckets.sku_id is
  'TCGPlayer SKU identifier (variant + condition + language). Stable.';
comment on column price_buckets.market_price_usd is
  'Market-price the TCGPlayer chart displays for this bucket. Carried '
  'forward by TCGPlayer when no sales occurred — quantity_sold=0 in that case.';
comment on column price_buckets.low_sale_usd is
  'Lowest recorded trade inside the bucket. NULL when quantity_sold=0.';
