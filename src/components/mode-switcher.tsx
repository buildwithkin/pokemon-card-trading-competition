"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { cn } from "@/lib/utils";

/**
 * Two-way toggle between live competition and simulation mode. Lives at the
 * top of /leaderboard. URL-state-driven so reloads and shares keep the view.
 *
 * - Live  → /leaderboard (no params)
 * - Sim   → /leaderboard?sim=new (if no run selected) or preserves ?sim=<id>
 */
export function ModeSwitcher({
  currentMode,
}: {
  currentMode: "live" | "sim";
}) {
  const router = useRouter();
  const params = useSearchParams();

  function selectLive() {
    router.push("/leaderboard");
  }
  function selectSim() {
    const existing = params.get("sim");
    const target = existing ?? "new";
    router.push(`/leaderboard?sim=${target}`);
  }

  return (
    <div className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-background/60 p-1 text-xs font-mono uppercase tracking-wider">
      <button
        type="button"
        onClick={selectLive}
        className={cn(
          "rounded-full px-3 py-1.5 transition",
          currentMode === "live"
            ? "bg-neon-cyan/20 text-neon-cyan"
            : "text-muted-foreground hover:text-foreground",
        )}
        aria-pressed={currentMode === "live"}
      >
        Live
      </button>
      <button
        type="button"
        onClick={selectSim}
        className={cn(
          "rounded-full px-3 py-1.5 transition",
          currentMode === "sim"
            ? "bg-amber-400/20 text-amber-300"
            : "text-muted-foreground hover:text-foreground",
        )}
        aria-pressed={currentMode === "sim"}
      >
        Simulation
      </button>
    </div>
  );
}
