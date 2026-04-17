-- Migration 0003: persist TCGPlayer URL per card + record price-row variant.
--
-- Enables scripts/scrape-price-history.ts (Layer 1/2 backfill of 3-month
-- price history per card from TCGPlayer.com) without re-fetching pokemontcg.io
-- on every run, and disambiguates which printing each price row reflects.
--
-- Both columns are nullable so existing rows remain valid:
--   - cards.tcgplayer_url is backfilled by the scraper on first run.
--   - prices.variant is NULL for rows written by scripts/seed-pool.ts before
--     this migration; the canonical printing was used by construction
--     (see VARIANT_PRIORITY in seed-pool.ts).

alter table cards add column tcgplayer_url text;

alter table prices add column variant text;
