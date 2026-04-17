export type HoloEffect = "shine" | "shiny" | "gold" | "rainbow";

export function holoEffectForRarity(rarity: string | null): HoloEffect {
  if (!rarity) return "shine";
  const r = rarity.toLowerCase();
  if (r.includes("hyper rare")) return "gold";
  if (r.includes("special illustration rare")) return "rainbow";
  if (r.includes("ultra rare")) return "rainbow";
  if (r.includes("shiny rare")) return "shiny";
  return "shine";
}
