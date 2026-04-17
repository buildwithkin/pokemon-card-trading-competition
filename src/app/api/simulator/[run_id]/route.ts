import { NextResponse } from "next/server";
import { adminClient } from "@/lib/supabase/admin";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Delete a simulation. Child tables (sim_daily_snapshots, sim_holdings,
 * sim_trades, sim_bot_notes, sim_turn_events) cascade on sim_runs delete.
 */
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ run_id: string }> },
) {
  const { run_id } = await params;
  if (!UUID_RE.test(run_id)) {
    return NextResponse.json({ error: "invalid_run_id" }, { status: 400 });
  }

  const client = adminClient();
  const { error, count } = await client
    .from("sim_runs")
    .delete({ count: "exact" })
    .eq("run_id", run_id);

  if (error) {
    return NextResponse.json(
      { error: "delete_failed", detail: error.message },
      { status: 500 },
    );
  }
  if (count === 0) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  return NextResponse.json({ deleted: run_id });
}
