import { z } from "zod";

/**
 * A single source citation backing a trade action or watchlist entry.
 */
export const SourceSchema = z.object({
  title: z.string().describe("Short human-readable title of the source"),
  url: z.string().optional().describe("Link to the source if applicable"),
  excerpt: z
    .string()
    .describe("1-3 sentence quote or summary of what the source says"),
});
export type Source = z.infer<typeof SourceSchema>;

/**
 * One trade action within a daily plan.
 */
export const TradeActionSchema = z.object({
  action: z.enum(["buy", "sell"]),
  card_id: z.string().describe("Target card_id (required for buy/sell)"),
  reasoning_md: z.string().min(20).describe("Why this specific action"),
  sources: z
    .array(SourceSchema)
    .min(1)
    .describe("At least one tool-call or contextual source"),
});
export type TradeAction = z.infer<typeof TradeActionSchema>;

/**
 * A card on the bot's watchlist — considering but not buying today.
 */
export const WatchlistEntrySchema = z.object({
  card_id: z.string(),
  current_price_observed_usd: z
    .number()
    .optional()
    .describe("Price at time of observation. Helps you notice drift on review."),
  reason_watching_md: z
    .string()
    .min(20)
    .describe("Why this card is worth watching — volume/trend/thesis/set hype"),
  trigger_to_buy_md: z
    .string()
    .min(10)
    .describe(
      "What has to happen for you to buy it. Specific. e.g. 'price dips below $800', 'volume 7d > 10', 'tournament result in next week'",
    ),
});
export type WatchlistEntry = z.infer<typeof WatchlistEntrySchema>;

/**
 * The full daily plan — actions + strategy + memory for future-self.
 */
export const TradePlanSchema = z.object({
  actions: z
    .array(TradeActionSchema)
    .max(5)
    .describe("Ordered list of trades for today. Empty = strategic hold."),
  overall_strategy_md: z
    .string()
    .min(30)
    .describe(
      "The big-picture reasoning for today's plan: why these actions, why in this order, or why no action.",
    ),
  watchlist: z
    .array(WatchlistEntrySchema)
    .max(10)
    .default([])
    .describe(
      "Cards you're watching but not buying today. Include trigger conditions.",
    ),
  notes_for_tomorrow_md: z
    .string()
    .min(30)
    .describe(
      "Free-form notes to your future self. What you learned today, themes to revisit, risks you're monitoring, hypotheses to test. You will read these tomorrow before deciding.",
    ),
});
export type TradePlan = z.infer<typeof TradePlanSchema>;

/**
 * Yesterday's notes snapshot, injected into today's prompt.
 */
export type PreviousNotes = {
  day: number;
  overall_strategy_md: string;
  notes_for_tomorrow_md: string;
  watchlist: WatchlistEntry[];
};

export type DroppedAction = {
  index: number;
  action: TradeAction;
  reason: string;
};

export type ValidationResult = {
  cleanedPlan: TradePlan;
  dropped: DroppedAction[];
};

/**
 * Validates each action against running state and DROPS the invalid ones,
 * returning a cleaned plan plus a list of what was dropped and why.
 *
 * Rationale: previously the first invalid action rejected the whole plan and
 * the bot lost the entire turn. Small models occasionally miscount cash or
 * pool membership; an unaffordable buy at action[1] shouldn't kill a
 * legitimate sell at action[0]. Dropping the bad actions individually keeps
 * the good ones, and the orchestrator surfaces the drop reasons so next
 * turn's prompt can include them — the bot then self-corrects (typically by
 * watchlisting the unaffordable card with a price trigger).
 *
 * Iteration order matters: we project cash + holdings forward action by
 * action so an earlier sell that funds a later buy is honored, and a later
 * buy that depends on an earlier (dropped) buy gets re-evaluated against
 * the actual post-drop state.
 */
export function validatePlan(
  plan: TradePlan,
  state: { cash_usd: number; holdings: Array<{ card_id: string }> },
  pool: Array<{ card_id: string; market_price_usd: number }>,
): ValidationResult {
  let projectedCash = state.cash_usd;
  const projectedHoldings = new Set(state.holdings.map((h) => h.card_id));
  const kept: TradeAction[] = [];
  const dropped: DroppedAction[] = [];

  for (let i = 0; i < plan.actions.length; i++) {
    const a = plan.actions[i];
    let reason: string | null = null;

    if (a.action === "buy") {
      const card = pool.find((p) => p.card_id === a.card_id);
      if (projectedHoldings.has(a.card_id)) {
        reason = `can't buy ${a.card_id} — already in portfolio`;
      } else if (projectedHoldings.size >= 5) {
        reason = `can't buy ${a.card_id} — portfolio already at 5-card cap`;
      } else if (!card) {
        reason = `card ${a.card_id} not in pool`;
      } else if (projectedCash < card.market_price_usd) {
        reason = `can't afford ${a.card_id} at $${card.market_price_usd.toFixed(
          2,
        )} (had $${projectedCash.toFixed(2)})`;
      } else {
        projectedCash -= card.market_price_usd;
        projectedHoldings.add(a.card_id);
      }
    } else {
      const card = pool.find((p) => p.card_id === a.card_id);
      if (!projectedHoldings.has(a.card_id)) {
        reason = `can't sell ${a.card_id} — not in portfolio`;
      } else if (!card) {
        reason = `card ${a.card_id} not in pool (can't price a sell)`;
      } else {
        projectedCash += card.market_price_usd;
        projectedHoldings.delete(a.card_id);
      }
    }

    if (reason) {
      dropped.push({ index: i, action: a, reason });
    } else {
      kept.push(a);
    }
  }

  return {
    cleanedPlan: { ...plan, actions: kept },
    dropped,
  };
}
