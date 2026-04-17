"use client";

import Image from "next/image";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { cn } from "@/lib/utils";
import type { PoolCard } from "./pool-grid";
import { HoloCard, holoEffectForRarity } from "./holo-card";

type HistoryPoint = {
  date: string;
  price: number;
  source: string;
  low: number | null;
  high: number | null;
  quantity: number;
  trades: number;
  condition: string | null;
  variant: string | null;
};

const SOURCE_LABEL: Record<string, string> = {
  tcgplayer: "live snapshot",
  bucket_exact: "TCGPlayer bucket",
  bucket_interpolated: "interpolated",
  bucket_carry_forward: "carried forward",
  bucket_carry_back: "carried back",
};

type DailySnapshot = {
  date: string;
  price: number;
  low: number | null;
  high: number | null;
  stale: boolean;
};

type ChartResponse = {
  daily_snapshot: DailySnapshot | null;
  history: HistoryPoint[];
};

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

function formatUsd(n: number): string {
  return `$${n.toFixed(2)}`;
}

function formatShortDate(iso: string): string {
  // iso = "2026-04-12" — parse without TZ shifting
  const [, m, d] = iso.split("-").map((p) => parseInt(p, 10));
  return `${MONTHS[m - 1]} ${d}`;
}

export function CardChartModal({
  card,
  onClose,
}: {
  card: PoolCard | null;
  onClose: () => void;
}) {
  // Per-card cache that survives the modal unmounting between opens.
  const cacheRef = useRef<Map<string, ChartResponse>>(new Map());
  const [chartData, setChartData] = useState<ChartResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const cardId = card?.card_id ?? null;

  // Lazy-fetch on open, with cache.
  useEffect(() => {
    if (!cardId) return;
    const cached = cacheRef.current.get(cardId);
    if (cached) {
      setChartData(cached);
      setLoadError(null);
      return;
    }
    setChartData(null);
    setLoadError(null);
    let cancelled = false;
    fetch(`/api/cards/${encodeURIComponent(cardId)}/prices`)
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return (await r.json()) as ChartResponse;
      })
      .then((body) => {
        if (cancelled) return;
        cacheRef.current.set(cardId, body);
        setChartData(body);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setLoadError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [cardId]);

  const history = chartData?.history ?? null;

  // Esc to close + body scroll lock.
  useEffect(() => {
    if (!card) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [card, onClose]);

  // Summary footer stats. Trade-range (min/max) uses bucket low/high — those
  // are real sale extremes inside each 3-day window — so the footer answers
  // "what did this card actually trade at over the period." Falls back to
  // marketPrice on days that have no bucket (interpolated points).
  const summary = useMemo(() => {
    if (!history || history.length === 0) return null;
    const first = history[0].price;
    const last = history[history.length - 1].price;
    const changePct = first > 0 ? ((last - first) / first) * 100 : 0;
    const low = history.reduce(
      (m, p) => Math.min(m, p.low ?? p.price),
      Number.POSITIVE_INFINITY,
    );
    const high = history.reduce(
      (m, p) => Math.max(m, p.high ?? p.price),
      Number.NEGATIVE_INFINITY,
    );
    const totalQty = history.reduce((s, p) => s + p.quantity, 0);
    return { first, last, changePct, min: low, max: high, totalQty };
  }, [history]);

  // Y-axis domain tracks the plotted line (daily marketPrice) — NOT the
  // bucket trade range. A single outlier sale in one bucket can stretch
  // low/high by 2-3× the actual price band; pinning the axis to the line
  // keeps the curve readable. ±8% padding gives breathing room without
  // hiding small day-to-day moves.
  const yDomain = useMemo<[number, number] | undefined>(() => {
    if (!history || history.length === 0) return undefined;
    let lineMin = Number.POSITIVE_INFINITY;
    let lineMax = Number.NEGATIVE_INFINITY;
    for (const p of history) {
      if (p.price < lineMin) lineMin = p.price;
      if (p.price > lineMax) lineMax = p.price;
    }
    const span = Math.max(lineMax - lineMin, lineMax * 0.02);
    const pad = span * 0.08;
    return [Math.max(0, lineMin - pad), lineMax + pad];
  }, [history]);

  if (!card) return null;

  const tcgplayerUrl = `https://prices.pokemontcg.io/tcgplayer/${card.card_id}`;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4 sm:p-6"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={`${card.name} price history`}
    >
      <div
        className="relative w-full max-w-3xl overflow-hidden rounded-2xl border border-border/40 bg-card/95 shadow-[0_20px_70px_-10px_rgba(0,0,0,0.7)]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Close */}
        <button
          onClick={onClose}
          className="absolute right-3 top-3 z-10 rounded-full bg-background/60 p-1.5 text-muted-foreground transition hover:bg-background hover:text-foreground"
          aria-label="Close"
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M18 6 6 18" />
            <path d="m6 6 12 12" />
          </svg>
        </button>

        {/* Body: image + summary side-by-side on desktop, stacked on mobile */}
        <div className="grid gap-5 p-5 sm:grid-cols-[180px_1fr] sm:p-6">
          <HoloCard
            className="relative mx-auto aspect-[733/1024] w-40 overflow-hidden rounded-lg bg-black sm:mx-0 sm:w-full"
            intensity={1.3}
            effect={holoEffectForRarity(card.rarity)}
          >
            <Image
              src={card.image_url}
              alt={card.name}
              fill
              sizes="180px"
              className="object-contain"
              unoptimized
            />
          </HoloCard>

          <div className="flex flex-col">
            <div className="mb-1 text-xs font-mono uppercase tracking-wide text-muted-foreground">
              {card.set_name} · #{card.number}
              {card.rarity ? ` · ${card.rarity}` : ""}
            </div>
            <h2 className="text-2xl font-bold tracking-tight text-foreground">
              {card.name}
            </h2>

            <div className="mt-4 flex items-baseline gap-3">
              <span className="text-4xl font-semibold tracking-tight text-neon-cyan">
                {formatUsd(card.market_price_usd)}
              </span>
              {summary && Number.isFinite(summary.changePct) && (
                <span
                  className={cn(
                    "text-sm font-semibold",
                    summary.changePct >= 0 ? "text-emerald-400" : "text-rose-400",
                  )}
                >
                  {summary.changePct >= 0 ? "▲" : "▼"}{" "}
                  {Math.abs(summary.changePct).toFixed(1)}%
                  <span className="ml-1 font-normal text-muted-foreground">
                    / 90d
                  </span>
                </span>
              )}
            </div>
            {summary && (
              <div className="mt-1 text-xs text-muted-foreground">
                90d range {formatUsd(summary.min)} – {formatUsd(summary.max)}
                {summary.totalQty > 0 && (
                  <span className="ml-2">
                    · {summary.totalQty.toLocaleString()} sold
                  </span>
                )}
              </div>
            )}

            {/* Chart */}
            <div className="mt-5 h-56 w-full">
              {loadError && (
                <div className="flex h-full items-center justify-center text-sm text-rose-400">
                  Failed to load: {loadError}
                </div>
              )}
              {!loadError && history === null && (
                <div className="h-full w-full animate-pulse rounded-md bg-background/40" />
              )}
              {!loadError && history && history.length < 2 && (
                <div className="flex h-full items-center justify-center px-4 text-center text-sm text-muted-foreground">
                  No price history yet — waiting for the next scrape.
                </div>
              )}
              {!loadError && history && history.length >= 2 && (
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart
                    data={history}
                    margin={{ top: 8, right: 8, left: 0, bottom: 0 }}
                  >
                    <CartesianGrid
                      stroke="hsl(220, 15%, 22%)"
                      strokeDasharray="3 3"
                      vertical={false}
                    />
                    <XAxis
                      dataKey="date"
                      tick={{ fill: "hsl(0, 0%, 60%)", fontSize: 11 }}
                      tickLine={false}
                      axisLine={false}
                      minTickGap={48}
                      tickFormatter={formatShortDate}
                    />
                    <YAxis
                      domain={yDomain}
                      tick={{ fill: "hsl(0, 0%, 60%)", fontSize: 11 }}
                      tickLine={false}
                      axisLine={false}
                      width={56}
                      tickFormatter={(v) => {
                        const n = Number(v);
                        // Sub-$10 cards: 2 decimals so $3.10 vs $3.40 is
                        // distinguishable on the axis.
                        return `$${n.toFixed(n < 10 ? 2 : 0)}`;
                      }}
                    />
                    <Tooltip content={<ChartTooltip />} cursor={{ stroke: "hsl(186, 100%, 50%)", strokeOpacity: 0.3 }} />
                    <Line
                      type="monotone"
                      dataKey="price"
                      stroke="hsl(186, 100%, 50%)"
                      strokeWidth={2}
                      dot={false}
                      activeDot={{ r: 4, fill: "hsl(186, 100%, 50%)", stroke: "hsl(220, 15%, 10%)", strokeWidth: 2 }}
                      isAnimationActive={false}
                    />
                  </LineChart>
                </ResponsiveContainer>
              )}
            </div>

            <div className="mt-4 flex items-center justify-between text-xs">
              <span className="text-muted-foreground">
                Source: TCGPlayer market price
              </span>
              <a
                href={tcgplayerUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="font-medium text-neon-cyan hover:underline"
              >
                View on TCGPlayer →
              </a>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function ChartTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{ payload: HistoryPoint }>;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const p = payload[0].payload;
  const hasRange = p.low !== null && p.high !== null && p.low !== p.high;
  const sourceLabel = SOURCE_LABEL[p.source] ?? p.source;
  return (
    <div className="rounded-md border border-border/60 bg-background/95 px-2.5 py-1.5 shadow-lg">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {formatShortDate(p.date)}
      </div>
      <div className="font-mono text-sm font-semibold text-neon-cyan">
        {formatUsd(p.price)}
      </div>
      {hasRange && (
        <div className="mt-0.5 text-[10px] text-muted-foreground">
          {formatUsd(p.low!)} – {formatUsd(p.high!)}
        </div>
      )}
      {p.quantity > 0 && (
        <div className="text-[10px] text-muted-foreground">
          {p.quantity} sold
          {p.trades > 0 && p.trades !== p.quantity ? ` · ${p.trades} trades` : ""}
        </div>
      )}
      <div className="mt-0.5 text-[10px] italic text-muted-foreground/80">
        {sourceLabel}
      </div>
    </div>
  );
}
