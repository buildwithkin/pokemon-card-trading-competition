"use client";

import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

export type BotId = "claude" | "chatgpt" | "grok";

export type ChartRow = {
  day: number;
  claude?: number;
  chatgpt?: number;
  grok?: number;
};

type BotMeta = {
  id: BotId;
  label: string;
  color: string;
};

const BOTS: readonly BotMeta[] = [
  { id: "claude", label: "Claude", color: "hsl(186, 100%, 50%)" },
  { id: "chatgpt", label: "ChatGPT", color: "hsl(150, 80%, 55%)" },
  { id: "grok", label: "Grok", color: "hsl(320, 100%, 60%)" },
];

const STARTING_USD = 1000;

const usdFormat = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});

function yDomain(rows: ChartRow[], hasData: boolean): [number, number] {
  if (!hasData) return [STARTING_USD - 100, STARTING_USD + 100];
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const r of rows) {
    for (const b of BOTS) {
      const v = r[b.id];
      if (typeof v === "number") {
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return [STARTING_USD - 100, STARTING_USD + 100];
  }
  // Include the starting reference line in the visible range.
  min = Math.min(min, STARTING_USD);
  max = Math.max(max, STARTING_USD);
  const pad = Math.max((max - min) * 0.15, 50);
  return [Math.max(0, Math.floor(min - pad)), Math.ceil(max + pad)];
}

export function LeaderboardChart({
  rows,
  hasData,
}: {
  rows: ChartRow[];
  hasData: boolean;
}) {
  const domain = yDomain(rows, hasData);
  return (
    <div className="relative h-[28rem] w-full rounded-lg border border-border/40 bg-card/50 p-4">
      {hasData && <LiveIndicator />}
      <ResponsiveContainer width="100%" height="100%">
        <LineChart
          data={rows}
          margin={{ top: 16, right: 24, left: 8, bottom: 8 }}
        >
          <CartesianGrid
            stroke="hsl(220, 15%, 22%)"
            strokeDasharray="3 3"
            vertical={false}
          />
          <XAxis
            dataKey="day"
            type="number"
            domain={[1, 7]}
            ticks={[1, 2, 3, 4, 5, 6, 7]}
            tick={{ fill: "hsl(0, 0%, 60%)", fontSize: 11 }}
            tickLine={false}
            axisLine={false}
            tickFormatter={(d: number) => `Day ${d}`}
          />
          <YAxis
            domain={domain}
            tick={{ fill: "hsl(0, 0%, 60%)", fontSize: 11 }}
            tickLine={false}
            axisLine={false}
            width={64}
            tickFormatter={(v: number) => `$${v.toFixed(0)}`}
          />
          <Tooltip
            content={<ChartTooltip />}
            cursor={{
              stroke: "hsl(186, 100%, 50%)",
              strokeOpacity: 0.3,
            }}
          />
          <ReferenceLine
            y={STARTING_USD}
            stroke="hsl(186, 100%, 50%)"
            strokeDasharray="4 4"
            strokeOpacity={0.4}
            label={{
              value: `Starting $${STARTING_USD.toLocaleString()}`,
              fill: "hsl(0, 0%, 60%)",
              fontSize: 10,
              position: "insideTopLeft",
            }}
          />
          {hasData && <Legend wrapperStyle={{ fontSize: 12 }} />}
          {hasData &&
            BOTS.map((b) => (
              <Line
                key={b.id}
                name={b.label}
                type="monotone"
                dataKey={b.id}
                stroke={b.color}
                strokeWidth={2}
                dot={{ r: 3, fill: b.color, stroke: b.color }}
                activeDot={{
                  r: 5,
                  fill: b.color,
                  stroke: "hsl(220, 15%, 10%)",
                  strokeWidth: 2,
                }}
                connectNulls
                isAnimationActive={false}
              />
            ))}
        </LineChart>
      </ResponsiveContainer>
      {!hasData && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center px-8 text-center">
          <p className="max-w-xs text-sm text-muted-foreground">
            Day 1 hasn&apos;t been recorded yet — check back after the first
            end-of-day snapshot.
          </p>
        </div>
      )}
    </div>
  );
}

function LiveIndicator() {
  return (
    <div className="absolute right-4 top-4 z-10 flex items-center gap-1.5 rounded-full border border-emerald-400/40 bg-emerald-400/10 px-2.5 py-1 text-[10px] font-mono font-semibold uppercase tracking-wider text-emerald-300 shadow-[0_0_12px_rgba(52,211,153,0.25)]">
      <span className="relative flex h-2 w-2">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-400" />
      </span>
      Live
    </div>
  );
}

type TooltipPayloadItem = {
  dataKey: string;
  name?: string;
  value?: number;
  color?: string;
};

function ChartTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: TooltipPayloadItem[];
  label?: number;
}) {
  if (!active || !payload || payload.length === 0) return null;
  return (
    <div className="rounded-md border border-border/60 bg-background/95 px-3 py-2 shadow-lg">
      <div className="mb-1 text-[10px] font-mono uppercase tracking-wide text-muted-foreground">
        Day {label}
      </div>
      {payload.map((p) => (
        <div key={p.dataKey} className="flex items-center gap-2 text-xs">
          <span
            className="inline-block h-2 w-2 rounded-full"
            style={{ backgroundColor: p.color }}
          />
          <span className="text-foreground">{p.name ?? p.dataKey}</span>
          <span className="ml-auto font-mono font-semibold text-foreground">
            {typeof p.value === "number" ? usdFormat.format(p.value) : "—"}
          </span>
        </div>
      ))}
    </div>
  );
}
