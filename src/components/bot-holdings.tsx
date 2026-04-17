import Image from "next/image";
import { cn } from "@/lib/utils";
import type { BotId } from "@/components/leaderboard-chart";
import { HoloCard } from "@/app/pool/holo-card";
import { holoEffectForRarity } from "@/lib/holo";

export type HoldingCard = {
  card_id: string;
  name: string;
  set_id: string;
  number: string;
  rarity: string | null;
  image_url: string;
  buy_price_usd: number;
  bought_at_day: number;
  market_price_usd: number | null;
};

export type BotHoldingsRow = {
  bot_id: BotId;
  display_name: string;
  cards: HoldingCard[];
};

const BOT_COLOR_CLASS: Record<BotId, string> = {
  claude: "text-neon-cyan",
  chatgpt: "text-emerald-400",
  grok: "text-neon-magenta",
};

const BOT_BORDER_CLASS: Record<BotId, string> = {
  claude: "border-neon-cyan/30",
  chatgpt: "border-emerald-400/30",
  grok: "border-neon-magenta/30",
};

const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});

const MAX_SLOTS = 5;

export function BotHoldings({ rows }: { rows: BotHoldingsRow[] }) {
  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold text-foreground">Holdings</h2>
      <div className="space-y-3">
        {rows.map((row) => (
          <BotHoldingsBlock key={row.bot_id} row={row} />
        ))}
      </div>
    </section>
  );
}

function BotHoldingsBlock({ row }: { row: BotHoldingsRow }) {
  const slots: (HoldingCard | null)[] = Array.from({ length: MAX_SLOTS }, (_, i) =>
    row.cards[i] ?? null,
  );

  return (
    <div
      className={cn(
        "rounded-lg border bg-card/40 p-3",
        BOT_BORDER_CLASS[row.bot_id],
      )}
    >
      <div className="mb-2 flex items-baseline justify-between">
        <div
          className={cn(
            "text-sm font-semibold uppercase tracking-wider",
            BOT_COLOR_CLASS[row.bot_id],
          )}
        >
          {row.display_name}
        </div>
        <div className="text-[11px] font-mono text-muted-foreground">
          {row.cards.length}/{MAX_SLOTS} slots
        </div>
      </div>
      <div className="grid grid-cols-5 gap-2">
        {slots.map((card, i) => (
          <HoldingSlot key={i} card={card} />
        ))}
      </div>
    </div>
  );
}

function HoldingSlot({ card }: { card: HoldingCard | null }) {
  if (!card) {
    return (
      <div className="flex aspect-[733/1024] items-center justify-center rounded-md border border-dashed border-border/40 bg-background/20 text-[10px] uppercase tracking-wider text-muted-foreground/60">
        empty
      </div>
    );
  }

  const pnl =
    card.market_price_usd !== null
      ? card.market_price_usd - card.buy_price_usd
      : null;
  const pnlPct =
    card.market_price_usd !== null && card.buy_price_usd > 0
      ? (pnl! / card.buy_price_usd) * 100
      : null;

  return (
    <div
      className="overflow-hidden rounded-md border border-border/40 bg-card/60"
      title={`${card.name} — bought day ${card.bought_at_day} @ ${usd.format(card.buy_price_usd)}`}
    >
      <HoloCard
        className="relative aspect-[733/1024] overflow-hidden bg-black"
        effect={holoEffectForRarity(card.rarity)}
      >
        <Image
          src={card.image_url}
          alt={card.name}
          fill
          sizes="(max-width: 640px) 20vw, 120px"
          className="object-contain"
          unoptimized
        />
        {card.market_price_usd !== null && (
          <span className="absolute top-1 right-1 z-10 rounded-sm bg-black/70 px-1 py-0.5 font-mono text-[9px] font-semibold text-neon-cyan">
            {usd.format(card.market_price_usd)}
          </span>
        )}
      </HoloCard>
      <div className="space-y-0.5 px-1.5 py-1 text-[10px]">
        <div className="truncate font-medium text-foreground" title={card.name}>
          {card.name}
        </div>
        <div className="flex items-center justify-between font-mono text-muted-foreground">
          <span>d{card.bought_at_day}</span>
          <span>{usd.format(card.buy_price_usd)}</span>
        </div>
        {pnl !== null && (
          <div
            className={cn(
              "text-right font-mono",
              pnl > 0
                ? "text-emerald-400"
                : pnl < 0
                  ? "text-rose-400"
                  : "text-muted-foreground",
            )}
          >
            {pnl >= 0 ? "+" : ""}
            {usd.format(pnl)}
            {pnlPct !== null && (
              <span className="ml-1 opacity-70">
                ({pnlPct >= 0 ? "+" : ""}
                {pnlPct.toFixed(1)}%)
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
