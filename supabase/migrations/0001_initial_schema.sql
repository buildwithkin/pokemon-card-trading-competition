-- Chaos Arena — Initial Schema (v0)
-- Built per autoplan-approved design doc (main-design-20260415-150117.md)
--
-- Three-layer architecture:
--   Layer 1 (one-time): cards, prices seeded via scripts/seed-pool.ts
--   Layer 2 (daily cron): prices refreshed by /api/cron/refresh-prices
--   Layer 3 (bot work): trades written by Inngest bot-turn steps
--
-- Identifiers use underscores, never hyphens (Postgres compat).

-- ============================================================================
-- EXTENSIONS
-- ============================================================================
create extension if not exists "pgcrypto";  -- for gen_random_uuid()

-- ============================================================================
-- LAYER 1 + 2 TABLES (competition core)
-- ============================================================================

-- The universe of cards for the competition.
-- Populated ONCE by scripts/seed-pool.ts. Frozen for the 7-day run.
create table cards (
  card_id          text primary key,            -- pokemontcg.io id, e.g. "sv8-199"
  name             text not null,
  set_id           text not null,
  set_name         text not null,
  number           text not null,               -- card number within set
  rarity           text,
  artist           text,
  image_url        text not null,               -- large image from pokemontcg.io
  is_mega_evolution boolean not null default true,
  created_at       timestamptz not null default now()
);
create index cards_set_id_idx on cards(set_id);

-- Daily market price snapshots. One row per (card, day).
-- Carry-forward rule: if no fresh price for a day, last known price is copied with is_stale=true.
create table prices (
  card_id          text not null references cards(card_id) on delete cascade,
  captured_at      date not null,
  market_price_usd numeric(10,2) not null,
  low_price_usd    numeric(10,2),
  high_price_usd   numeric(10,2),
  source           text not null default 'tcgplayer',
  is_stale         boolean not null default false,
  created_at       timestamptz not null default now(),
  primary key (card_id, captured_at)
);
create index prices_captured_at_idx on prices(captured_at desc);

-- Pre-scraped tournament deck data for Claude bot's research tool.
-- Populated ONCE by scripts/seed-limitless.ts. Frozen.
create table limitless_decks (
  deck_id          serial primary key,
  deck_name        text not null,
  placement        int,                         -- 1st, 2nd, etc. (null for "top 32" buckets)
  event_name       text,
  event_date       date,
  card_ids         text[] not null,             -- card_ids from the decklist that overlap the pool
  created_at       timestamptz not null default now()
);
create index limitless_decks_card_ids_idx on limitless_decks using gin(card_ids);

-- ============================================================================
-- LAYER 3 TABLES (bot state + trades)
-- ============================================================================

create table bots (
  bot_id           text primary key,            -- 'claude' | 'chatgpt' | 'grok'
  display_name     text not null,
  persona          text not null,               -- short description shown on dashboard
  model_provider   text not null,               -- 'anthropic' | 'openai' | 'xai'
  model_id         text not null,               -- e.g. 'claude-sonnet-4-6'
  system_prompt    text not null,
  avatar_url       text,
  starting_cash_usd numeric(10,2) not null default 500.00,
  created_at       timestamptz not null default now()
);

-- Current holdings. One row per (bot, card) currently held.
-- Buy = INSERT here. Sell = DELETE here. Max 5 rows per bot enforced by trigger below.
-- NEVER stores sold cards — that history lives in `trades` (immutable ledger).
create table holdings (
  bot_id           text not null references bots(bot_id) on delete cascade,
  card_id          text not null references cards(card_id) on delete restrict,
  buy_price_usd    numeric(10,2) not null,
  bought_at_day    int not null,                -- competition day 1-7
  bought_at        timestamptz not null default now(),
  primary key (bot_id, card_id)
);
create index holdings_bot_id_idx on holdings(bot_id);

-- Enforce the 5-slot cap at the database level. No one can accidentally write a 6th row.
create or replace function enforce_holdings_cap()
returns trigger as $$
begin
  if (select count(*) from holdings where bot_id = NEW.bot_id) >= 5 then
    raise exception 'bot % already holds 5 cards (cap)', NEW.bot_id;
  end if;
  return NEW;
end;
$$ language plpgsql;

create trigger holdings_enforce_cap
before insert on holdings
for each row execute function enforce_holdings_cap();

-- Immutable ledger of every trade decision. Append-only.
-- UNIQUE (bot_id, day, decision_index) is the idempotency key — Inngest step replay = no-op.
create table trades (
  trade_id         uuid primary key default gen_random_uuid(),
  bot_id           text not null references bots(bot_id) on delete cascade,
  day              int not null,
  decision_index   int not null,                -- 0, 1, 2... within a bot's turn for that day
  action           text not null check (action in ('buy', 'sell', 'pass')),
  card_id          text references cards(card_id) on delete restrict,  -- null for 'pass'
  price_usd        numeric(10,2),
  reasoning_md     text not null,
  sources_json     jsonb not null default '[]'::jsonb,   -- [{title, url, excerpt}]
  llm_tokens_in    int,
  llm_tokens_out   int,
  llm_cost_usd     numeric(10,4),
  created_at       timestamptz not null default now(),
  unique (bot_id, day, decision_index)
);
create index trades_bot_day_idx on trades(bot_id, day);
create index trades_day_idx on trades(day);

-- End-of-day snapshots for leaderboard + dashboard scrubber timeline.
create table daily_snapshots (
  bot_id           text not null references bots(bot_id) on delete cascade,
  day              int not null,
  cash_usd         numeric(10,2) not null,
  holdings_value_usd numeric(10,2) not null,
  total_value_usd  numeric(10,2) not null,
  rank             int,
  created_at       timestamptz not null default now(),
  primary key (bot_id, day)
);
create index daily_snapshots_day_idx on daily_snapshots(day);

-- Tracks every round run (cron OR operator-triggered). UNIQUE (day, round_no) prevents double-fire.
create table round_runs (
  run_id           uuid primary key default gen_random_uuid(),
  day              int not null,
  round_no         int not null,                -- 1 = scheduled cron; 2+ = operator-triggered
  actor            text not null check (actor in ('cron', 'operator')),
  started_at       timestamptz not null default now(),
  completed_at     timestamptz,
  status           text not null default 'running' check (status in ('running', 'completed', 'failed')),
  error_message    text,
  unique (day, round_no)
);

-- Materialized single-row leaderboard for public endpoint.
-- Refreshed by round-close step. Read by SWR 30s on public site — survives viral drop traffic.
create table leaderboard_current (
  id               int primary key check (id = 1),   -- single-row constraint
  updated_at       timestamptz not null default now(),
  leaderboard_json jsonb not null default '[]'::jsonb  -- [{bot_id, total_value_usd, rank}, ...]
);
insert into leaderboard_current (id, leaderboard_json) values (1, '[]'::jsonb);

-- Single-row competition state. Used for atomic vote-lock check.
create table competition_state (
  id               int primary key check (id = 1),
  voting_locked    boolean not null default false,
  locked_at        timestamptz,
  competition_start_day date,
  current_day      int not null default 0
);
insert into competition_state (id) values (1);

-- ============================================================================
-- PUBLIC VOTING TABLES
-- ============================================================================

-- Social-auth users of the public voting site.
create table users (
  user_id          uuid primary key default gen_random_uuid(),
  provider         text not null check (provider in ('google', 'discord')),
  provider_id      text not null,
  email            text not null,
  display_name     text,
  country_code     text,                        -- derived from IP at signup for GDPR routing
  created_at       timestamptz not null default now(),
  unique (provider, provider_id)
);

-- One vote per user, locked after Day 1 starts.
create table votes (
  user_id          uuid primary key references users(user_id) on delete cascade,
  bot_id           text not null references bots(bot_id) on delete restrict,
  voted_at         timestamptz not null default now(),
  locked_at        timestamptz                  -- set when competition_state.voting_locked flips true
);
create index votes_bot_id_idx on votes(bot_id);

-- Daily check-ins = bonus raffle votes. One per (user, day).
create table checkins (
  checkin_id       uuid primary key default gen_random_uuid(),
  user_id          uuid not null references users(user_id) on delete cascade,
  day              int not null,
  checked_in_at    timestamptz not null default now(),
  unique (user_id, day)
);
create index checkins_user_id_idx on checkins(user_id);
create index checkins_day_idx on checkins(day);

-- Snapshot of eligible raffle entries, frozen at draw time.
-- Seed is logged on camera. Makes draw reproducible + auditable.
create table raffle_snapshot (
  snapshot_id      uuid primary key default gen_random_uuid(),
  taken_at         timestamptz not null default now(),
  seed             bigint not null,             -- on-camera RNG seed
  winning_bot_id   text not null references bots(bot_id),
  entries_json     jsonb not null,              -- frozen [{user_id, weight}, ...]
  winner_user_id   uuid references users(user_id)
);

-- Winner address capture (worldwide shipping). PII, locked down.
-- Data retention: 90 days post-shipment then scrub to anonymized record.
create table raffle_winner (
  user_id          uuid primary key references users(user_id) on delete cascade,
  name             text not null,
  address_json     jsonb not null,              -- {country, line1, line2, city, region, postal_code}
  country_code     text not null,
  phone            text,
  captured_at      timestamptz not null default now(),
  shipped_at       timestamptz,
  scrubbed_at      timestamptz                  -- set when data anonymized after retention period
);

-- ============================================================================
-- GDPR / OPERATOR TABLES
-- ============================================================================

create table privacy_consents (
  user_id          uuid not null references users(user_id) on delete cascade,
  consent_type     text not null check (consent_type in ('analytics', 'marketing', 'functional')),
  granted_at       timestamptz not null default now(),
  revoked_at       timestamptz,
  country_code     text,
  primary key (user_id, consent_type)
);

create table deletion_requests (
  request_id       uuid primary key default gen_random_uuid(),
  user_id          uuid not null references users(user_id) on delete cascade,
  requested_at     timestamptz not null default now(),
  processed_at     timestamptz,
  status           text not null default 'pending' check (status in ('pending', 'processing', 'completed', 'failed'))
);

-- Audit log for operator manual-trigger actions.
create table operator_actions (
  action_id        uuid primary key default gen_random_uuid(),
  actor            text not null,               -- email of operator
  action           text not null check (action in ('refresh_prices', 'run_round', 'advance_day', 'raffle_draw')),
  invoked_at       timestamptz not null default now(),
  result_summary   text,
  rate_limit_key   text not null                -- used for per-action cooldown enforcement
);
create index operator_actions_action_idx on operator_actions(action, invoked_at desc);

-- ============================================================================
-- ROW LEVEL SECURITY
-- ============================================================================
-- RLS enabled on user-data tables. Competition-data stays open (public read via REST for dashboard).

-- User-data: locked to the owning user or service role.
alter table users enable row level security;
alter table votes enable row level security;
alter table checkins enable row level security;
alter table privacy_consents enable row level security;
alter table deletion_requests enable row level security;
alter table raffle_winner enable row level security;

-- Policies: users can read/write their own rows (via auth.uid()).
-- Service role bypasses RLS by default, so seed scripts and cron still work.

create policy "users can read own row"
  on users for select
  using (auth.uid() = user_id);

create policy "users can read own votes"
  on votes for select
  using (auth.uid() = user_id);

create policy "users can insert own vote"
  on votes for insert
  with check (auth.uid() = user_id);

create policy "users can read own checkins"
  on checkins for select
  using (auth.uid() = user_id);

create policy "users can insert own checkin"
  on checkins for insert
  with check (auth.uid() = user_id);

create policy "users can manage own consents"
  on privacy_consents for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "users can request own deletion"
  on deletion_requests for insert
  with check (auth.uid() = user_id);

create policy "users can read own deletion status"
  on deletion_requests for select
  using (auth.uid() = user_id);

-- raffle_winner: NO policies = service role only. Users never read this directly.
-- /winner/claim uses server action with service role to insert.

-- Competition-data tables: public read (for operator dashboard + public leaderboard).
-- Writes restricted to service role (which bypasses RLS) — clients can't write.
alter table cards enable row level security;
alter table prices enable row level security;
alter table bots enable row level security;
alter table holdings enable row level security;
alter table trades enable row level security;
alter table daily_snapshots enable row level security;
alter table leaderboard_current enable row level security;

create policy "public read cards" on cards for select using (true);
create policy "public read prices" on prices for select using (true);
create policy "public read bots" on bots for select using (true);
create policy "public read holdings" on holdings for select using (true);
create policy "public read trades" on trades for select using (true);
create policy "public read daily_snapshots" on daily_snapshots for select using (true);
create policy "public read leaderboard_current" on leaderboard_current for select using (true);

-- Internal tables: service role only, no policies needed (RLS enabled = locked down).
alter table round_runs enable row level security;
alter table competition_state enable row level security;
alter table operator_actions enable row level security;
alter table limitless_decks enable row level security;
alter table raffle_snapshot enable row level security;

-- ============================================================================
-- SEED DATA — 3 bots named after their models
-- ============================================================================

insert into bots (bot_id, display_name, persona, model_provider, model_id, system_prompt, starting_cash_usd) values
  ('claude',  'Claude',  'Thoughtful, risk-weighted. Reads tournament data before buying.',            'anthropic', 'claude-sonnet-4-6',     'PLACEHOLDER — filled in by M2', 1000.00),
  ('chatgpt', 'ChatGPT', 'Confident, trend-chasing. Reads TCGPlayer price analytics.',                 'openai',    'gpt-5-mini',            'PLACEHOLDER — filled in by M2', 1000.00),
  ('grok',    'Grok',    'YOLO, vibes-first. Reads the X timeline. Trades on hype and social momentum.', 'xai',     'grok-4-1-fast',         'PLACEHOLDER — filled in by M2', 1000.00);
