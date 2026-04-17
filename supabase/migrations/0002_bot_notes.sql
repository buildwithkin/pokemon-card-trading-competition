-- Migration 0002: bot_notes
-- Persistent per-bot memory across days. Bots read yesterday's notes before
-- deciding today's plan, and write today's notes + watchlist for future-self
-- to read tomorrow.
--
-- One row per (bot_id, day). Created at the end of each turn.

create table bot_notes (
  bot_id                  text not null references bots(bot_id) on delete cascade,
  day                     int not null,
  -- Free-form markdown notes the bot wrote to its future self.
  -- "Themes I'm tracking", "what I learned today", "what I'm waiting for".
  notes_for_tomorrow_md   text not null,
  -- Structured watchlist: cards the bot is considering but not buying today.
  -- Shape: [{card_id, current_price_observed_usd, reason_watching_md, trigger_to_buy_md}, ...]
  watchlist_json          jsonb not null default '[]'::jsonb,
  -- Overall strategy from today's plan (duplicated here for easy next-day injection).
  overall_strategy_md     text not null,
  created_at              timestamptz not null default now(),
  primary key (bot_id, day)
);

create index bot_notes_bot_day_idx on bot_notes(bot_id, day desc);

-- RLS: public read (the dashboard displays notes), service role writes only.
alter table bot_notes enable row level security;
create policy "public read bot_notes" on bot_notes for select using (true);

-- All three bots are now seeded in migration 0001.
