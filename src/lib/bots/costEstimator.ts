/**
 * LLM cost tracking. Pre-flight estimate + post-hoc reconciliation.
 *
 * Rates are in USD per MILLION tokens (current Anthropic pricing).
 * Update when rates change or we add providers in M3.
 */
export type ModelRate = { input_per_mtok: number; output_per_mtok: number };

export const MODEL_RATES: Record<string, ModelRate> = {
  // Anthropic
  "claude-opus-4-6": { input_per_mtok: 15.0, output_per_mtok: 75.0 },
  "claude-sonnet-4-6": { input_per_mtok: 3.0, output_per_mtok: 15.0 },
  "claude-haiku-4-5": { input_per_mtok: 1.0, output_per_mtok: 5.0 },
  // OpenAI (per April 2026 pricing)
  "gpt-5": { input_per_mtok: 2.5, output_per_mtok: 15.0 },
  "gpt-5-mini": { input_per_mtok: 0.75, output_per_mtok: 4.5 },
  "gpt-5-nano": { input_per_mtok: 0.2, output_per_mtok: 1.5 },
  // xAI (per April 2026 pricing)
  "grok-4": { input_per_mtok: 3.0, output_per_mtok: 15.0 },
  "grok-4-fast-reasoning": { input_per_mtok: 0.2, output_per_mtok: 0.5 },
  "grok-4-fast": { input_per_mtok: 0.2, output_per_mtok: 0.5 },
  "grok-4-1-fast": { input_per_mtok: 0.2, output_per_mtok: 0.5 },
};

/**
 * Resolve a possibly-snapshot-pinned model id to its base entry in MODEL_RATES.
 * Anthropic and xAI ship date-suffixed snapshot ids (e.g. "claude-haiku-4-5-20251001",
 * "grok-4-fast-2026-04-09") that price the same as the base model. Strict lookup
 * misses those, so try the exact key first, then strip a trailing `-YYYYMMDD`
 * (or `-YYYY-MM-DD`) suffix and retry.
 */
function resolveRate(model: string): ModelRate | null {
  if (MODEL_RATES[model]) return MODEL_RATES[model];
  const stripped = model.replace(/-\d{4}-?\d{2}-?\d{2}$/, "");
  if (stripped !== model && MODEL_RATES[stripped]) return MODEL_RATES[stripped];
  return null;
}

/**
 * Compute dollar cost from token counts.
 * Returns USD as a number, rounded to 4 decimals for logging.
 */
export function computeCost(
  model: string,
  tokensIn: number,
  tokensOut: number,
): number {
  const rate = resolveRate(model);
  if (!rate) {
    // Unknown model — return 0 so we don't block, but log a warning upstream
    return 0;
  }
  const cost =
    (tokensIn * rate.input_per_mtok) / 1_000_000 +
    (tokensOut * rate.output_per_mtok) / 1_000_000;
  return Number(cost.toFixed(4));
}

/**
 * Pre-flight estimate BEFORE a call. Overestimates on purpose:
 *   - assumes output will hit max_output_tokens (worst case)
 *   - prompt_tokens estimated at chars / 3.5 (Claude's ratio)
 */
export function preflightEstimate(
  model: string,
  promptChars: number,
  maxOutputTokens: number,
): number {
  const estimatedInputTokens = Math.ceil(promptChars / 3.5);
  return computeCost(model, estimatedInputTokens, maxOutputTokens);
}

export { resolveRate };
