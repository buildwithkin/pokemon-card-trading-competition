import { NextResponse } from "next/server";
import { z } from "zod";
import { adminClient } from "@/lib/supabase/admin";
import { listAvailableBucketDates } from "@/lib/simulator/loadHistoricalPool";

const CreateBody = z.object({
  start_bucket_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  duration_days: z.number().int().min(1).max(14),
});

const STARTING_CASH_USD = 1000;
const BOT_IDS = ["claude", "chatgpt", "grok"] as const;

/**
 * Create a new simulator run. After creation the run sits in 'paused' with
 * current_day=0 and three day-0 seed snapshots ($1000 each). The first
 * /advance click produces day 1.
 */
export async function POST(req: Request) {
  let body: z.infer<typeof CreateBody>;
  try {
    body = CreateBody.parse(await req.json());
  } catch (err) {
    return NextResponse.json(
      { error: "invalid_body", detail: err instanceof Error ? err.message : String(err) },
      { status: 400 },
    );
  }

  const available = await listAvailableBucketDates();
  if (available.length === 0) {
    return NextResponse.json(
      { error: "no_buckets", detail: "price_buckets_canonical is empty; run seed:history first" },
      { status: 409 },
    );
  }

  const startIdx = available.indexOf(body.start_bucket_date);
  if (startIdx < 0) {
    return NextResponse.json(
      {
        error: "start_bucket_not_available",
        detail: `available: ${available[0]} → ${available[available.length - 1]}`,
      },
      { status: 400 },
    );
  }
  const remaining = available.length - startIdx;
  if (body.duration_days > remaining) {
    return NextResponse.json(
      {
        error: "duration_exceeds_coverage",
        detail: `only ${remaining} buckets available from ${body.start_bucket_date}`,
      },
      { status: 400 },
    );
  }

  const client = adminClient();
  const { data: run, error: runErr } = await client
    .from("sim_runs")
    .insert({
      start_bucket_date: body.start_bucket_date,
      duration_days: body.duration_days,
    })
    .select("run_id")
    .single();
  if (runErr || !run) {
    return NextResponse.json(
      { error: "insert_failed", detail: runErr?.message ?? "no row returned" },
      { status: 500 },
    );
  }

  const seedSnaps = BOT_IDS.map((bot_id) => ({
    run_id: run.run_id,
    bot_id,
    day: 0,
    sim_bucket_date: null,
    cash_usd: STARTING_CASH_USD,
    holdings_value_usd: 0,
    total_value_usd: STARTING_CASH_USD,
    rank: null,
  }));
  const { error: snapErr } = await client
    .from("sim_daily_snapshots")
    .insert(seedSnaps);
  if (snapErr) {
    // Roll back the sim_runs row to avoid orphaned runs.
    await client.from("sim_runs").delete().eq("run_id", run.run_id);
    return NextResponse.json(
      { error: "seed_snapshot_failed", detail: snapErr.message },
      { status: 500 },
    );
  }

  return NextResponse.json({ run_id: run.run_id }, { status: 201 });
}
