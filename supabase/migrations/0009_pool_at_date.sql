-- Migration 0009: daily-interpolated pool pricing.
--
-- Problem
-- -------
-- TCGPlayer's detailed-history endpoint returns 3-day-wide buckets, but the
-- window phase is set by when we first scraped each card. Two cards scraped
-- a day apart live on two interleaved 3-day schedules. `price_buckets`
-- therefore has ~90 distinct `bucket_start_date` values over a quarter
-- (roughly three interleaved cadences), not the ~30 you'd expect from a
-- shared 3-day calendar.
--
-- `listAvailableBucketDates()` in the simulator walks all 90 dates in order.
-- On any given date only the cards on that date's cadence have a bucket, so
-- `loadHistoricalPool(D)` returned a ragged subset (often 4-112 of ~935
-- cards). A bot that researched card X on day N would then try to buy X on
-- day N+1 and the validator rejected with "card X not in pool" because X
-- lived on a different cadence.
--
-- Fix
-- ---
-- This function gives every card with any bucket a price on every date,
-- linearly interpolated between its nearest on-or-before and on-or-after
-- buckets. At the edges of the history window it carries forward (or back)
-- from the single available neighbor.
--
-- Use
-- ---
--   select * from pool_at_date('2026-04-15');
--
-- Returns one row per card that has at least one bucket, with:
--   - market_price_usd: the interpolated price
--   - price_source: 'exact' | 'interpolated' | 'carry_forward' | 'carry_back'
--     ('exact' when target_date hits a real bucket; the others tell you how
--     far you are from a real sale datapoint.)

create or replace function pool_at_date(target_date date)
returns table (
  card_id text,
  market_price_usd numeric(10,2),
  price_source text
)
language sql stable as $$
  with prev as (
    select distinct on (card_id)
      card_id,
      bucket_start_date as d,
      market_price_usd as p
    from price_buckets_canonical
    where bucket_start_date <= target_date
    order by card_id, bucket_start_date desc
  ),
  nxt as (
    select distinct on (card_id)
      card_id,
      bucket_start_date as d,
      market_price_usd as p
    from price_buckets_canonical
    where bucket_start_date > target_date
    order by card_id, bucket_start_date asc
  )
  select
    coalesce(prev.card_id, nxt.card_id) as card_id,
    case
      when prev.d = target_date then prev.p
      when prev.d is not null and nxt.d is not null then
        round(
          (
            prev.p
            + (nxt.p - prev.p)
              * ((target_date - prev.d)::numeric / (nxt.d - prev.d)::numeric)
          )::numeric,
          2
        )
      when prev.d is not null then prev.p
      else nxt.p
    end as market_price_usd,
    case
      when prev.d = target_date then 'exact'
      when prev.d is not null and nxt.d is not null then 'interpolated'
      when prev.d is not null then 'carry_forward'
      else 'carry_back'
    end as price_source
  from prev
  full outer join nxt using (card_id);
$$;

comment on function pool_at_date(date) is
  'Returns every card with a price at target_date, linearly interpolated '
  'between its nearest enclosing price_buckets_canonical rows. Carries '
  'forward / back at the edges. Replaces the per-day bucket lookup that '
  'returned a ragged card subset due to per-card bucket phase offsets.';
