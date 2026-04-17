"use client";

import Image from "next/image";
import { useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { CardChartModal } from "./card-chart-modal";
import { HoloCard, holoEffectForRarity } from "./holo-card";

export type PoolCard = {
  card_id: string;
  name: string;
  set_id: string;
  set_name: string;
  number: string;
  rarity: string | null;
  artist: string | null;
  image_url: string;
  market_price_usd: number;
  low_price_usd: number | null;
  high_price_usd: number | null;
  source: string;
  is_stale: boolean;
};

type SortKey = "price_desc" | "price_asc" | "name_asc" | "set_asc";

export function PoolGrid({ cards }: { cards: PoolCard[] }) {
  const [query, setQuery] = useState("");
  const [selectedSets, setSelectedSets] = useState<Set<string> | "all">("all");
  const [sortKey, setSortKey] = useState<SortKey>("price_desc");
  const [selected, setSelected] = useState<PoolCard | null>(null);

  // Derive set list from actual data
  const sets = useMemo(() => {
    const map = new Map<string, { id: string; name: string; count: number; pricedCount: number }>();
    for (const c of cards) {
      const cur = map.get(c.set_id) ?? { id: c.set_id, name: c.set_name, count: 0, pricedCount: 0 };
      cur.count++;
      if (c.market_price_usd !== null) cur.pricedCount++;
      map.set(c.set_id, cur);
    }
    return [...map.values()].sort((a, b) => a.id.localeCompare(b.id));
  }, [cards]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const rows = cards.filter((c) => {
      if (selectedSets !== "all" && !selectedSets.has(c.set_id)) return false;
      if (q) {
        const hay = `${c.name} ${c.rarity ?? ""} ${c.artist ?? ""} ${c.set_name}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    switch (sortKey) {
      case "price_desc":
        rows.sort((a, b) => b.market_price_usd - a.market_price_usd);
        break;
      case "price_asc":
        rows.sort((a, b) => a.market_price_usd - b.market_price_usd);
        break;
      case "name_asc":
        rows.sort((a, b) => a.name.localeCompare(b.name));
        break;
      case "set_asc":
        rows.sort((a, b) => a.set_id.localeCompare(b.set_id) || a.name.localeCompare(b.name));
        break;
    }
    return rows;
  }, [cards, query, selectedSets, sortKey]);

  const toggleSet = (id: string) => {
    setSelectedSets((prev) => {
      if (prev === "all") {
        // First click: select ONLY this set
        return new Set([id]);
      }
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
        if (next.size === 0) return "all";
      } else {
        next.add(id);
      }
      return next;
    });
  };

  return (
    <div className="mx-auto max-w-7xl px-4 pb-16 pt-4 sm:px-6">
      {/* Filters */}
      <div className="mb-6 space-y-3 rounded-lg border border-border/40 bg-card/40 p-4">
        {/* Row 1: search + sort */}
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search name, rarity, artist, set..."
            className="min-w-[200px] flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-neon-cyan"
          />
          <select
            value={sortKey}
            onChange={(e) => setSortKey(e.target.value as SortKey)}
            className="rounded-md border border-border bg-background px-3 py-2 text-sm"
          >
            <option value="price_desc">Price: high to low</option>
            <option value="price_asc">Price: low to high</option>
            <option value="name_asc">Name A→Z</option>
            <option value="set_asc">Set → Name</option>
          </select>
        </div>

        {/* Row 2: set pills */}
        <div className="flex items-start gap-2">
          <span className="text-muted-foreground text-xs font-semibold uppercase tracking-wide pt-1 shrink-0">
            Sets:
          </span>
          <div className="flex flex-wrap gap-1.5">
            <button
              onClick={() => setSelectedSets("all")}
              className={cn(
                "rounded-full border px-2.5 py-0.5 text-[11px] transition",
                selectedSets === "all"
                  ? "border-accent bg-accent/20 text-accent"
                  : "border-border text-muted-foreground hover:border-accent/50",
              )}
            >
              All sets
            </button>
            {sets.map((s) => {
              const active =
                selectedSets === "all" || selectedSets.has(s.id);
              const isME = s.id.startsWith("me");
              return (
                <button
                  key={s.id}
                  onClick={() => toggleSet(s.id)}
                  title={`${s.name} — ${s.pricedCount}/${s.count} priced`}
                  className={cn(
                    "rounded-full border px-2.5 py-0.5 text-[11px] transition",
                    active
                      ? isME
                        ? "border-accent bg-accent/20 text-accent"
                        : "border-neon-cyan bg-neon-cyan/20 text-neon-cyan"
                      : "border-border text-muted-foreground hover:border-neon-cyan/50",
                  )}
                >
                  {s.id}
                </button>
              );
            })}
          </div>
        </div>

        {/* Stats bar */}
        <div className="text-muted-foreground text-xs">
          Showing{" "}
          <span className="text-foreground font-mono">{filtered.length}</span> /{" "}
          {cards.length} cards
          {selectedSets !== "all" && (
            <button
              onClick={() => setSelectedSets("all")}
              className="ml-2 text-neon-cyan underline"
            >
              clear set filter
            </button>
          )}
        </div>
      </div>

      {/* Grid */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
        {filtered.map((c) => (
          <CardTile key={c.card_id} card={c} onSelect={setSelected} />
        ))}
      </div>

      {filtered.length === 0 && (
        <div className="rounded-lg border border-border/40 bg-card/40 p-8 text-center text-muted-foreground">
          No cards match these filters.
        </div>
      )}

      <CardChartModal card={selected} onClose={() => setSelected(null)} />
    </div>
  );
}

function CardTile({
  card,
  onSelect,
}: {
  card: PoolCard;
  onSelect: (card: PoolCard) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(card)}
      className="group block overflow-hidden rounded-lg border border-border/40 bg-card/40 text-left transition hover:border-neon-cyan/60 hover:shadow-[0_0_20px_-5px_rgba(0,208,224,0.4)] focus:outline-none focus-visible:ring-2 focus-visible:ring-neon-cyan"
      title={`${card.name} — $${card.market_price_usd.toFixed(2)}`}
    >
      <HoloCard
        className="relative aspect-[733/1024] overflow-hidden bg-black"
        effect={holoEffectForRarity(card.rarity)}
      >
        <Image
          src={card.image_url}
          alt={card.name}
          fill
          sizes="(max-width: 640px) 50vw, (max-width: 768px) 33vw, (max-width: 1024px) 25vw, 16vw"
          className="object-contain"
          unoptimized
        />
        <div className="absolute top-1 right-1 z-10">
          <span className="rounded-sm bg-neon-cyan/90 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-black">
            ${card.market_price_usd.toFixed(2)}
          </span>
        </div>
        <div className="absolute inset-x-0 bottom-0 z-10 translate-y-full bg-gradient-to-t from-black/90 to-transparent p-2 text-center text-xs font-semibold text-neon-cyan opacity-0 transition group-hover:translate-y-0 group-hover:opacity-100">
          View 90d chart →
        </div>
      </HoloCard>
      <div className="space-y-0.5 p-2 text-xs">
        <div className="truncate font-medium text-foreground" title={card.name}>
          {card.name}
        </div>
        <div className="text-muted-foreground truncate" title={card.rarity ?? ""}>
          {card.rarity ?? "—"}
        </div>
        <div className="text-muted-foreground/70 flex items-center justify-between">
          <span className="font-mono text-[10px]">
            {card.set_id} · #{card.number}
          </span>
          {card.artist && (
            <span
              className="max-w-[60%] truncate text-right italic"
              title={card.artist}
            >
              {card.artist}
            </span>
          )}
        </div>
      </div>
    </button>
  );
}
