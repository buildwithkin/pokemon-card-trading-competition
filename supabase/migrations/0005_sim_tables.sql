-- Migration 0005: interactive backtest simulator tables.
-- Mirror of the live competition schema, scoped by run_id. Lets operators
-- pick a historical start bucket then step through one sim day at a time
-- via the /leaderboard?sim=... UI. Live tables stay untouched.
--
-- status state machine:
--   paused     idle between advances (initial after /create)
--   advancing  POST /advance in flight
--   completed  current_day reached duration_days
--   failed     terminal after crash or manual cleanup
--
-- day is a sim index (0..duration_days). day 0 is the $1000 seed row,
-- sim_bucket_date=null. day N (N>=1) maps to the Nth bucket after start.

create table sim_runs (
  run_id              uuid          primary key default gen_random_uuid(),
  start_bucket_date   date          not null,
  duration_days       int           not null check (duration_days between 1 and 14),
  current_day         int           not null default 0 check (current_day >= 0),
  status              text          not null default 'paused'
                      check (status in ('paused', 'advancing', 'completed', 'failed')),
  total_cost_usd      numeric(10,4) not null default 0,
  requested_at        timestamptz   not null default now(),
  last_heartbeat_at   timestamptz   not null default now(),
  completed_at        timestamptz,
  error_message       text,
  check (current_day <= duration_days)
);
create index sim_runs_requested_at_idx on sim_runs (requested_at desc);

create table sim_daily_snapshots (
  run_id             uuid          not null references sim_runs(run_id) on delete cascade,
  bot_id             text          not null references bots(bot_id) on delete cascade,
  day                int           not null check (day >= 0),
  sim_bucket_date    date,
  cash_usd           numeric(10,2) not null,
  holdings_value_usd numeric(10,2) not null,
  total_value_usd    numeric(10,2) not null,
  rank               int,
  created_at         timestamptz   not null default now(),
  primary key (run_id, bot_id, day)
);
create index sim_daily_snapshots_run_day_idx on sim_daily_snapshots (run_id, day);

create table sim_holdings (
  run_id        uuid          not null references sim_runs(run_id) on delete cascade,
  bot_id        text          not null references bots(bot_id) on delete cascade,
  card_id       text          not null references cards(card_id) on delete restrict,
  buy_price_usd numeric(10,2) not null,
  bought_at_day int           not null check (bought_at_day >= 1),
  bought_at     timestamptz   not null default now(),
  primary key (run_id, bot_id, card_id)
);
create index sim_holdings_run_bot_idx on sim_holdings (run_id, bot_id);

create or replace function enforce_sim_holdings_cap()
returns trigger as $$
begin
  if (
    select count(*)
    from sim_holdings
    where bot_id = NEW.bot_id
      and run_id = NEW.run_id
  ) >= 5 then
    raise exception 'sim bot % already holds 5 cards in run % (cap)', NEW.bot_id, NEW.run_id;
  end if;
  return NEW;
end;
$$ language plpgsql;

create trigger sim_holdings_enforce_cap
before insert on sim_holdings
for each row execute function enforce_sim_holdings_cap();

create table sim_trades (
  trade_id       uuid          primary key default gen_random_uuid(),
  run_id         uuid          not null references sim_runs(run_id) on delete cascade,
  bot_id         text          not null references bots(bot_id) on delete cascade,
  day            int           not null check (day >= 1),
  decision_index int           not null check (decision_index >= 0),
  action         text          not null check (action in ('buy', 'sell', 'pass')),
  card_id        text          references cards(card_id) on delete restrict,
  price_usd      numeric(10,2),
  reasoning_md   text          not null,
  sources_json   jsonb         not null default '[]'::jsonb,
  llm_tokens_in  int,
  llm_tokens_out int,
  llm_cost_usd   numeric(10,4),
  created_at     timestamptz   not null default now(),
  unique (run_id, bot_id, day, decision_index)
);
create index sim_trades_run_bot_day_idx on sim_trades (run_id, bot_id, day);

create table sim_bot_notes (
  run_id                uuid        not null references sim_runs(run_id) on delete cascade,
  bot_id                text        not null references bots(bot_id) on delete cascade,
  day                   int         not null check (day >= 1),
  notes_for_tomorrow_md text        not null,
  watchlist_json        jsonb       not null default '[]'::jsonb,
  overall_strategy_md   text        not null,
  created_at            timestamptz not null default now(),
  primary key (run_id, bot_id, day)
);
create index sim_bot_notes_run_bot_day_idx on sim_bot_notes (run_id, bot_id, day desc);

alter table sim_runs            enable row level security;
alter table sim_daily_snapshots enable row level security;
alter table sim_holdings        enable row level security;
alter table sim_trades          enable row level security;
alter table sim_bot_notes       enable row level security;

create policy "public read sim_runs"            on sim_runs            for select using (true);
create policy "public read sim_daily_snapshots" on sim_daily_snapshots for select using (true);
create policy "public read sim_holdings"        on sim_holdings        for select using (true);
create policy "public read sim_trades"          on sim_trades          for select using (true);
create policy "public read sim_bot_notes"       on sim_bot_notes       for select using (true);

comment on table sim_runs is 'One row per interactive simulator session.';
comment on column sim_runs.status is 'paused, advancing, completed, or failed';
comment on column sim_runs.current_day is '0=seed only; equals duration_days when complete';
