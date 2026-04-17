import { tool } from "ai";
import { z } from "zod";
import { adminClient } from "@/lib/supabase/admin";

/**
 * Claude's research tool: query the pre-scraped `limitless_decks` table.
 * Given a card_id or a Pokemon name, return recent tournament deck archetypes
 * that include that card. This is how Claude evaluates "tournament demand."
 *
 * Frozen at seed time — no live scraping during the round.
 */
export const getTournamentDecksTool = tool({
  description:
    "Look up recent tournament deck archetypes that include a specific card or Pokemon. Returns deck names, placements, event names. Empty array means the card isn't in any recent tournament data (low competitive demand).",
  inputSchema: z.object({
    card_id: z
      .string()
      .optional()
      .describe(
        "The pokemontcg.io card_id (e.g. 'me2-125'). Matches exact card_ids in deck lists.",
      ),
    pokemon_name: z
      .string()
      .optional()
      .describe(
        "Pokemon name like 'Mega Charizard X'. Substring-matches deck names. Use this if you don't know the exact card_id.",
      ),
  }),
  execute: async ({ card_id, pokemon_name }) => {
    if (!card_id && !pokemon_name) {
      return {
        error: "Must provide either card_id or pokemon_name",
        decks: [],
      };
    }
    const client = adminClient();

    let query = client
      .from("limitless_decks")
      .select("deck_name, placement, event_name, event_date, card_ids");

    if (card_id) {
      query = query.contains("card_ids", [card_id]);
    }
    if (pokemon_name) {
      query = query.ilike("deck_name", `%${pokemon_name}%`);
    }

    const { data, error } = await query.order("event_date", {
      ascending: false,
    });

    if (error) {
      return { error: error.message, decks: [] };
    }

    return {
      decks: (data ?? []).map((d) => ({
        deck_name: d.deck_name,
        placement: d.placement ?? "top 32",
        event_name: d.event_name,
        event_date: d.event_date,
      })),
      count: (data ?? []).length,
    };
  },
});
