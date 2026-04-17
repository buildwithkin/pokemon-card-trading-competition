import { cn } from "@/lib/utils";
import type { BotId } from "@/components/leaderboard-chart";

export type RankRow = {
  bot_id: BotId;
  display_name: string;
  cash: number;
  holdings: number;
  total: number;
  delta: number;
};

const BOT_COLOR_CLASS: Record<BotId, string> = {
  claude: "text-neon-cyan",
  chatgpt: "text-emerald-400",
  grok: "text-neon-magenta",
};

const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});

export function RankTable({ rows }: { rows: RankRow[] }) {
  return (
    <div className="overflow-hidden rounded-lg border border-border/40 bg-card/50">
      <table className="w-full text-sm">
        <thead className="border-b border-border/40 bg-background/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
          <tr>
            <th className="px-4 py-2 font-medium">Rank</th>
            <th className="px-4 py-2 font-medium">Bot</th>
            <th className="px-4 py-2 text-right font-medium">Cash</th>
            <th
              className="px-4 py-2 text-right font-medium"
              title="Marked at today's market prices, not buy prices"
            >
              Holdings (mkt)
            </th>
            <th className="px-4 py-2 text-right font-medium">Total</th>
            <th className="px-4 py-2 text-right font-medium">Δ vs start</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr
              key={r.bot_id}
              className="border-b border-border/20 last:border-b-0"
            >
              <td className="px-4 py-3 font-mono text-muted-foreground">
                #{i + 1}
              </td>
              <td
                className={cn(
                  "px-4 py-3 font-semibold",
                  BOT_COLOR_CLASS[r.bot_id],
                )}
              >
                {r.display_name}
              </td>
              <td className="px-4 py-3 text-right font-mono text-muted-foreground">
                {usd.format(r.cash)}
              </td>
              <td className="px-4 py-3 text-right font-mono text-muted-foreground">
                {usd.format(r.holdings)}
              </td>
              <td className="px-4 py-3 text-right font-mono font-semibold text-foreground">
                {usd.format(r.total)}
              </td>
              <td
                className={cn(
                  "px-4 py-3 text-right font-mono font-semibold",
                  r.delta > 0
                    ? "text-emerald-400"
                    : r.delta < 0
                      ? "text-rose-400"
                      : "text-muted-foreground",
                )}
              >
                {r.delta >= 0 ? "+" : ""}
                {usd.format(r.delta)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
