"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
import type { BotId } from "@/components/leaderboard-chart";

const BOT_COLOR_CLASS: Record<BotId, string> = {
  claude: "text-neon-cyan",
  chatgpt: "text-emerald-400",
  grok: "text-neon-magenta",
};

const BOT_LABEL: Record<BotId, string> = {
  claude: "Claude",
  chatgpt: "ChatGPT",
  grok: "Grok",
};

type EventRow = {
  event_id: number;
  bot_id: BotId;
  day: number;
  step_index: number;
  event_type:
    | "turn_start"
    | "tool_call"
    | "tool_result"
    | "step_finish"
    | "turn_done"
    | "error"
    | "text";
  tool_name: string | null;
  payload: Record<string, unknown>;
  created_at: string;
};

/**
 * Polls /api/simulator/{runId}/events while the parent run is live, renders
 * a chronological feed of tool calls / results / step boundaries per bot.
 * When status flips to 'paused' or 'completed', it calls router.refresh()
 * so the page re-renders with the new day's persisted state.
 */
export function LiveTurnFeed({
  runId,
  day,
  status,
  initialEvents = [],
}: {
  runId: string;
  day: number;
  status: "paused" | "advancing" | "completed" | "failed";
  initialEvents?: EventRow[];
}) {
  const router = useRouter();
  const [events, setEvents] = useState<EventRow[]>(initialEvents);
  const cursorRef = useRef<number>(
    initialEvents.length > 0
      ? initialEvents[initialEvents.length - 1].event_id
      : 0,
  );
  const prevStatusRef = useRef(status);

  useEffect(() => {
    // Only poll while the server says a turn is in flight. When status is
    // paused/completed/failed we're looking at history — no need to poll.
    if (status !== "advancing") return;

    let cancelled = false;

    async function tick() {
      try {
        const res = await fetch(
          `/api/simulator/${runId}/events?since=${cursorRef.current}&day=${day}`,
          { cache: "no-store" },
        );
        if (!res.ok) return;
        const body = (await res.json()) as {
          events: EventRow[];
          nextCursor: number;
        };
        if (cancelled) return;
        if (body.events.length > 0) {
          setEvents((prev) => [...prev, ...body.events]);
          cursorRef.current = body.nextCursor;
        }
      } catch {
        // swallow — next tick retries
      }
    }

    tick();
    const id = setInterval(tick, 750);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [runId, day, status]);

  // When the turn finishes (status advancing -> paused/completed), refresh
  // the server component so the chart, rank table, and trade log all update.
  useEffect(() => {
    if (prevStatusRef.current === "advancing" && status !== "advancing") {
      router.refresh();
    }
    prevStatusRef.current = status;
  }, [status, router]);

  if (status === "paused" && events.length === 0) return null;
  if (status === "completed" && events.length === 0) return null;

  // Group events by bot for side-by-side display.
  const byBot = new Map<BotId, EventRow[]>();
  for (const e of events) {
    const arr = byBot.get(e.bot_id) ?? [];
    arr.push(e);
    byBot.set(e.bot_id, arr);
  }

  const botIds: BotId[] = ["claude", "chatgpt", "grok"];

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-foreground">
          Bot activity
          <span className="ml-2 font-mono text-xs font-normal text-muted-foreground">
            Day {day}
          </span>
        </h2>
        {status === "advancing" && (
          <span className="flex items-center gap-1.5 text-[10px] font-mono uppercase tracking-wider text-amber-300">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-400 opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-amber-400" />
            </span>
            Live
          </span>
        )}
      </div>

      <div className="grid gap-3 lg:grid-cols-3">
        {botIds.map((botId) => {
          const botEvents = byBot.get(botId) ?? [];
          const done = botEvents.some(
            (e) => e.event_type === "turn_done" || e.event_type === "error",
          );
          return (
            <div
              key={botId}
              className={cn(
                "flex flex-col rounded-lg border bg-card/40 p-3",
                done
                  ? "border-emerald-400/20"
                  : "border-border/40",
              )}
            >
              <div className="mb-2 flex items-center justify-between text-xs">
                <span
                  className={cn(
                    "font-mono font-semibold uppercase tracking-wider",
                    BOT_COLOR_CLASS[botId],
                  )}
                >
                  {BOT_LABEL[botId]}
                </span>
                <span className="font-mono text-[10px] text-muted-foreground">
                  {done
                    ? "done"
                    : botEvents.length === 0
                      ? "waiting…"
                      : "thinking…"}
                </span>
              </div>

              {botEvents.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  Not started yet.
                </p>
              ) : (
                <ul className="space-y-1.5 text-xs">
                  {botEvents.map((e) => (
                    <EventLine key={e.event_id} event={e} />
                  ))}
                </ul>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function EventLine({ event }: { event: EventRow }) {
  if (event.event_type === "turn_start") {
    const model =
      typeof event.payload.model === "string" ? event.payload.model : null;
    return (
      <li className="text-muted-foreground">
        <span className="font-mono text-[10px] uppercase tracking-wider">
          start
        </span>
        {model && (
          <span className="ml-2 font-mono text-[10px]">{model}</span>
        )}
      </li>
    );
  }

  if (event.event_type === "tool_call") {
    const inputPreview =
      typeof event.payload.input_preview === "string"
        ? event.payload.input_preview
        : "";
    return (
      <li>
        <div className="flex items-baseline gap-1.5">
          <span className="font-mono text-[10px] uppercase tracking-wider text-amber-300">
            →
          </span>
          <span className="font-mono text-[11px] font-semibold text-foreground">
            {event.tool_name ?? "tool"}
          </span>
        </div>
        {inputPreview && (
          <div className="ml-3 mt-0.5 truncate font-mono text-[10px] text-muted-foreground">
            {inputPreview}
          </div>
        )}
      </li>
    );
  }

  if (event.event_type === "tool_result") {
    const outputPreview =
      typeof event.payload.output_preview === "string"
        ? event.payload.output_preview
        : "";
    return (
      <li>
        <div className="flex items-baseline gap-1.5">
          <span className="font-mono text-[10px] uppercase tracking-wider text-emerald-300">
            ←
          </span>
          <span className="font-mono text-[11px] text-muted-foreground">
            {event.tool_name ?? "tool"}
          </span>
        </div>
        {outputPreview && (
          <details className="ml-3 mt-0.5">
            <summary className="cursor-pointer font-mono text-[10px] text-muted-foreground/80 line-clamp-2">
              {outputPreview.slice(0, 160)}
              {outputPreview.length > 160 ? "…" : ""}
            </summary>
            <pre className="mt-1 max-h-48 overflow-y-auto whitespace-pre-wrap rounded bg-background/60 p-2 font-mono text-[10px] text-muted-foreground/80">
              {outputPreview}
            </pre>
          </details>
        )}
      </li>
    );
  }

  if (event.event_type === "text") {
    const text =
      typeof event.payload.text === "string" ? event.payload.text : "";
    if (text.trim().length === 0) return null;
    return (
      <li>
        <div className="ml-1 border-l-2 border-border/40 pl-2">
          <div className="mb-0.5 font-mono text-[9px] uppercase tracking-wider text-muted-foreground/70">
            thinking
          </div>
          <p className="whitespace-pre-wrap text-[11px] leading-snug text-foreground/85">
            {text}
          </p>
        </div>
      </li>
    );
  }

  if (event.event_type === "step_finish") {
    return (
      <li className="border-l-2 border-border/30 pl-2 text-[10px] text-muted-foreground/70">
        step {event.step_index} done
      </li>
    );
  }

  if (event.event_type === "turn_done") {
    const actions =
      typeof event.payload.actions === "number" ? event.payload.actions : 0;
    const cost =
      typeof event.payload.cost_usd === "number"
        ? event.payload.cost_usd
        : 0;
    return (
      <li className="mt-1 border-t border-border/30 pt-1.5 text-emerald-300">
        <span className="font-mono text-[10px] uppercase tracking-wider">
          done · {actions} action{actions === 1 ? "" : "s"} · $
          {cost.toFixed(4)}
        </span>
      </li>
    );
  }

  if (event.event_type === "error") {
    const message =
      typeof event.payload.message === "string"
        ? event.payload.message
        : "unknown error";
    const rawTail =
      typeof event.payload.raw_tail === "string"
        ? event.payload.raw_tail
        : "";
    const stepCount =
      typeof event.payload.step_count === "number"
        ? event.payload.step_count
        : null;
    const tokensOut =
      typeof event.payload.tokens_out === "number"
        ? event.payload.tokens_out
        : null;
    const toolsCalled = Array.isArray(event.payload.tools_called)
      ? (event.payload.tools_called as string[])
      : [];
    return (
      <li className="mt-1 border-t border-rose-400/30 pt-1.5 text-rose-300">
        <span className="font-mono text-[10px] uppercase tracking-wider">
          error
        </span>
        <div className="mt-0.5 font-mono text-[10px]">{message}</div>
        {(stepCount !== null || tokensOut !== null) && (
          <div className="mt-0.5 font-mono text-[10px] text-muted-foreground">
            {stepCount !== null ? `steps ${stepCount}` : ""}
            {stepCount !== null && tokensOut !== null ? " · " : ""}
            {tokensOut !== null ? `tokens_out ${tokensOut}` : ""}
          </div>
        )}
        {toolsCalled.length > 0 && (
          <div className="mt-0.5 font-mono text-[10px] text-muted-foreground">
            tools called: [{toolsCalled.join(", ")}]
            {!toolsCalled.includes("submit_plan") && (
              <span className="ml-1 text-amber-300">
                ← never called submit_plan
              </span>
            )}
          </div>
        )}
        {rawTail && (
          <div className="mt-1">
            <div className="mb-0.5 font-mono text-[10px] text-muted-foreground">
              raw output tail ({rawTail.length} chars):
            </div>
            <pre className="max-h-48 overflow-y-auto whitespace-pre-wrap rounded bg-background/60 p-2 font-mono text-[10px] text-muted-foreground">
              {rawTail || "(empty)"}
            </pre>
          </div>
        )}
      </li>
    );
  }

  return null;
}
