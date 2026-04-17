-- Migration 0008: allow 'text' event type for sim_turn_events.
-- Captures the model's reasoning between tool calls so the live feed shows
-- what each bot is thinking, not just what it called.

alter table sim_turn_events
  drop constraint sim_turn_events_event_type_check;

alter table sim_turn_events
  add constraint sim_turn_events_event_type_check
  check (event_type in (
    'turn_start',
    'tool_call',
    'tool_result',
    'step_finish',
    'turn_done',
    'error',
    'text'
  ));
