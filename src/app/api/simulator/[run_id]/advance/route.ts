import { NextResponse } from "next/server";
import {
  advanceSimDay,
  SimAdvanceError,
} from "@/lib/simulator/simOrchestrator";

export const maxDuration = 300; // Vercel serverless cap; each advance is one LLM round per bot.

/**
 * Advance a sim by one bucket. One LLM round for each of the three bots.
 * Expect ~20-30s wall time. Client disables the button while this is in flight.
 */
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ run_id: string }> },
) {
  const { run_id } = await params;
  try {
    const result = await advanceSimDay(run_id);
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof SimAdvanceError) {
      return NextResponse.json(
        { error: err.code, detail: err.message },
        { status: err.httpStatus },
      );
    }
    return NextResponse.json(
      {
        error: "internal",
        detail: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}
