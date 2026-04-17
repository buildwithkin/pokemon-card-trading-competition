/**
 * MULTI-PROVIDER SHAPE CONTRACT TEST
 *
 * Each LLM (Anthropic / OpenAI / xAI) returns tool calls in slightly
 * different shapes. Vercel AI SDK normalizes most of it, but a provider
 * upgrade can silently change the JSON shape and break the bot loop on
 * Day 3 of the real competition.
 *
 * Strategy: real API call per provider per CI run (~$0.05 total), golden
 * JSON snapshot of the trade-decision shape. Snapshot is the schema, not
 * the prose — reasoning can vary.
 *
 * Full implementation lands in Milestone 3 when all 3 bots are wired.
 */
import { describe, test } from "bun:test";

describe("Trade-decision schema — provider contract", () => {
  test.todo("Claude Sonnet returns valid TradeDecision JSON against canonical fixture");

  test.todo("GPT-5-mini returns valid TradeDecision JSON against canonical fixture");

  test.todo("Grok-4 returns valid TradeDecision JSON against canonical fixture");

  test.todo("all three providers quote at least one source from tool-call results");

  test.todo("Zod schema rejects decisions with action='buy' + null card_id");
});
