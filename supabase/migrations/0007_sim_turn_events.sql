-- Migration 0007: live bot-activity event stream for the simulator.
--
-- One row per observable thing a bot does during a turn: a tool call, a
-- tool result, a step boundary, the turn start, the turn done, or an error.
-- The viewer polls /api/simulator/{run_id}/events?since={cursor} every
-- ~750ms while sim_runs.status = 'advancing' and renders the feed inline.
--
-- event_type values:
--   turn_start    one row per (bot, day) when a bot's turn begins
--   tool_call     fired when the model invokes a tool (search, tcgplayer, etc.)
--   tool_result   fired when the tool returns; payload has a short preview
--   step_finish   model finished one reasoning step (between tool roundtrips)
--   turn_done     terminal success row, payload has actions count + cost
--   error         terminal failure row, payload has the error message

create table sim_turn_events (
  event_id   bigserial   primary key,
  run_id     uuid        not null references sim_runs(run_id) on delete cascade,
  bot_id     text        not null references bots(bot_id) on delete cascade,
  day        int         not null check (day >= 1),
  step_index int         not null default 0,
  event_type text        not null check (event_type in
    ('turn_start', 'tool_call', 'tool_result', 'step_finish', 'turn_done', 'error')),
  tool_name  text,
  payload    jsonb       not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index sim_turn_events_run_id_idx       on sim_turn_events (run_id, event_id);
create index sim_turn_events_run_day_bot_idx  on sim_turn_events (run_id, day, bot_id, event_id);

alter table sim_turn_events enable row level security;
create policy "public read sim_turn_events" on sim_turn_events for select using (true);

comment on table sim_turn_events is
  'Live activity stream for the simulator. One row per bot tool call, tool result, or step boundary during a sim day advance.';
