"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { cn } from "@/lib/utils";

export function DeleteSimButton({
  runId,
  variant = "inline",
  redirectTo,
  label = "Delete",
  confirmMessage = "Delete this simulation? This cannot be undone.",
}: {
  runId: string;
  variant?: "inline" | "prominent";
  redirectTo?: string;
  label?: string;
  confirmMessage?: string;
}) {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onClick(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (!window.confirm(confirmMessage)) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/simulator/${runId}`, { method: "DELETE" });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
          detail?: string;
        };
        setError(body.detail ?? body.error ?? `HTTP ${res.status}`);
        setSubmitting(false);
        return;
      }
      if (redirectTo) {
        router.push(redirectTo);
      } else {
        router.refresh();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  }

  const base =
    variant === "prominent"
      ? "rounded-md border px-3 py-1.5 text-xs font-semibold transition"
      : "rounded-sm border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider transition";
  const idle = "border-rose-400/40 bg-rose-400/10 text-rose-300 hover:bg-rose-400/20";
  const busy = "cursor-not-allowed border-border/40 bg-background/40 text-muted-foreground";

  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        onClick={onClick}
        disabled={submitting}
        className={cn(base, submitting ? busy : idle)}
      >
        {submitting ? "Deleting…" : label}
      </button>
      {error && (
        <span className="text-[10px] text-rose-300">{error}</span>
      )}
    </span>
  );
}
