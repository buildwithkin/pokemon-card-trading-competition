"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { cn } from "@/lib/utils";

/**
 * The heart of the interactive sim. One click = one bucket advance = one
 * LLM round per bot (~20-30s). While the POST is in flight, the button is
 * disabled and shows "Running bots…"; the server flips sim_runs.status to
 * 'advancing' so concurrent clicks from another tab also get blocked.
 *
 * On success, router.refresh() re-renders the server component so the
 * chart, rank table, and trade log all pick up the new row.
 */
export function NextDayButton({
  runId,
  disabled,
  disabledReason,
}: {
  runId: string;
  disabled: boolean;
  disabledReason: string | null;
}) {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onClick() {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/simulator/${runId}/advance`, {
        method: "POST",
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
      router.refresh();
      // Give the server component a moment to re-fetch before re-enabling.
      setTimeout(() => setSubmitting(false), 400);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  }

  const isDisabled = disabled || submitting;

  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        onClick={onClick}
        disabled={isDisabled}
        className={cn(
          "inline-flex items-center justify-center gap-2 rounded-md border px-6 py-3 text-base font-semibold transition",
          isDisabled
            ? "cursor-not-allowed border-border/40 bg-background/40 text-muted-foreground"
            : "border-neon-cyan bg-neon-cyan/10 text-neon-cyan hover:bg-neon-cyan/20",
        )}
      >
        {submitting ? (
          <>
            <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
            Running bots…
          </>
        ) : (
          <>Next Day →</>
        )}
      </button>
      {disabled && disabledReason && !submitting && (
        <p className="text-xs text-muted-foreground">{disabledReason}</p>
      )}
      {error && (
        <p className="rounded-md border border-rose-400/40 bg-rose-400/10 px-3 py-2 text-xs text-rose-300">
          {error}
        </p>
      )}
    </div>
  );
}
