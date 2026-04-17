import { NextResponse } from "next/server";
import { serverClient } from "@/lib/supabase/server";

/**
 * Long-poll-ish endpoint for the live bot-activity feed. Clients call this
 * with ?since=<last_event_id> every ~750ms while the parent run's status is
 * 'advancing' and ?day=<sim_day> to scope to the current advancement.
 *
 * Returns events in ascending event_id order plus a nextCursor the client
 * uses for the next tick.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ run_id: string }> },
) {
  const { run_id } = await params;
  const url = new URL(req.url);
  const sinceRaw = url.searchParams.get("since");
  const dayRaw = url.searchParams.get("day");
  const since = sinceRaw ? Number(sinceRaw) : 0;
  const day = dayRaw ? Number(dayRaw) : null;

  if (!Number.isFinite(since) || since < 0) {
    return NextResponse.json(
      { error: "invalid_since" },
      { status: 400 },
    );
  }

  const client = serverClient();
  let q = client
    .from("sim_turn_events")
    .select("event_id, bot_id, day, step_index, event_type, tool_name, payload, created_at")
    .eq("run_id", run_id)
    .gt("event_id", since)
    .order("event_id", { ascending: true })
    .limit(200);

  if (day !== null && Number.isFinite(day)) {
    q = q.eq("day", day);
  }

  const { data, error } = await q;
  if (error) {
    return NextResponse.json(
      { error: "query_failed", detail: error.message },
      { status: 500 },
    );
  }

  const events = data ?? [];
  const nextCursor =
    events.length > 0 ? events[events.length - 1].event_id : since;

  return NextResponse.json({ events, nextCursor });
}
