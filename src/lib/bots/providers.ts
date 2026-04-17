import { anthropic } from "@ai-sdk/anthropic";
import { openai } from "@ai-sdk/openai";
import { xai as xaiBase } from "@ai-sdk/xai";
import type { LanguageModel } from "ai";

// Type assertion: the @ai-sdk/xai package exposes `.tools.webSearch` /
// `.tools.xSearch` at runtime (confirmed by probe), but the types are
// not fully in sync. Cast to any-with-tools so we can use them cleanly.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const xai = xaiBase as any;

/**
 * Map a DB-stored (provider, model) pair to an AI SDK LanguageModel.
 * One place to add a new provider.
 */
export function getModel(provider: string, modelId: string): LanguageModel {
  switch (provider) {
    case "anthropic":
      return anthropic(modelId);
    case "openai":
      return openai(modelId);
    case "xai":
      // xAI Agent Tools (web_search, x_search) are only available on the Responses API.
      // The Chat Completions endpoint's Live Search is deprecated (returns 410).
      return xai.responses(modelId);
    default:
      throw new Error(`Unknown provider: ${provider}`);
  }
}

export { anthropic, openai };
