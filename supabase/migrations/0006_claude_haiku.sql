-- Migration 0006: swap claude from Sonnet 4.6 to Haiku 4.5.
-- Sonnet was costing ~$0.10/turn; Haiku brings it in line with gpt-5-mini
-- and grok-4-1-fast (~$0.01/turn). Quality tradeoff is explicit: Haiku
-- reasons less deeply, but for paper-trading decisions the circuit-breaker
-- + validatePlan guardrails are what actually prevent bad trades.
--
-- To revert: update bots set model_id = 'claude-sonnet-4-6' where bot_id = 'claude';

update bots
set model_id = 'claude-haiku-4-5-20251001'
where bot_id = 'claude';
