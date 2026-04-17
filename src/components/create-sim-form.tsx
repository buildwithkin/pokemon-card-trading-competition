"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { cn } from "@/lib/utils";

/**
 * Start-a-sim form. Client component because we need router.push() and live
 * state for the duration slider + submit button state.
 */
export function CreateSimForm({
  availableBuckets,
}: {
  availableBuckets: string[];
}) {
  const router = useRouter();
  const earliest = availableBuckets[0];
  const latest = availableBuckets[availableBuckets.length - 1];

  const [startBucket, setStartBucket] = useState<string>(
    availableBuckets[Math.max(0, availableBuckets.length - 8)] ?? earliest,
  );
  const [durationDays, setDurationDays] = useState<number>(7);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const startIdx = availableBuckets.indexOf(startBucket);
  const remainingBuckets =
    startIdx >= 0 ? availableBuckets.length - startIdx : 0;
  const maxDuration = Math.min(14, Math.max(1, remainingBuckets));
  const effectiveDuration = Math.min(durationDays, maxDuration);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/simulator/create", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          start_bucket_date: startBucket,
          duration_days: effectiveDuration,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
          detail?: string;
        };
        setError(body.detail ?? body.error ?? `HTTP ${res.status}`);
        setSubmitting(false);
        return;
      }
      const { run_id } = (await res.json()) as { run_id: string };
      router.push(`/leaderboard?sim=${run_id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-5">
      <div className="grid gap-5 sm:grid-cols-2">
        <label className="flex flex-col gap-1.5 text-sm">
          <span className="font-medium text-foreground">Start bucket</span>
          <select
            value={startBucket}
            onChange={(e) => setStartBucket(e.target.value)}
            className="rounded-md border border-border/60 bg-background/60 px-3 py-2 font-mono text-sm text-foreground focus:border-neon-cyan focus:outline-none"
          >
            {availableBuckets.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
          <span className="text-xs text-muted-foreground">
            Coverage: {earliest} → {latest}
          </span>
        </label>

        <label className="flex flex-col gap-1.5 text-sm">
          <span className="font-medium text-foreground">
            Duration (buckets): {effectiveDuration}
          </span>
          <input
            type="range"
            min={1}
            max={14}
            value={effectiveDuration}
            onChange={(e) => setDurationDays(Number(e.target.value))}
            className="w-full accent-neon-cyan"
          />
          <span className="text-xs text-muted-foreground">
            {remainingBuckets} bucket{remainingBuckets === 1 ? "" : "s"}{" "}
            remaining from this start. Cap: 14.
          </span>
        </label>
      </div>

      <div className="flex items-center justify-between gap-4 rounded-md border border-border/30 bg-background/40 px-4 py-3 text-xs">
        <span className="text-muted-foreground">
          Max LLM cost per click: ~$6 (3 bots × $2 circuit-breaker cap).
          Estimated max total: ~{effectiveDuration * 6} USD.
        </span>
      </div>

      {error && (
        <p className="rounded-md border border-rose-400/40 bg-rose-400/10 px-3 py-2 text-xs text-rose-300">
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={submitting || effectiveDuration < 1}
        className={cn(
          "inline-flex items-center gap-2 rounded-md border px-5 py-2.5 text-sm font-medium transition",
          submitting
            ? "border-border/40 bg-background/40 text-muted-foreground"
            : "border-neon-cyan bg-neon-cyan/10 text-neon-cyan hover:bg-neon-cyan/20",
        )}
      >
        {submitting ? "Creating…" : "Start simulation →"}
      </button>
    </form>
  );
}
