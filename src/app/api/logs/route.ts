import { NextResponse } from "next/server";
import { summarizeLogs } from "@/lib/cost";
import { clearLogs, listLogs } from "@/lib/store";

export const runtime = "nodejs";

/** Per-conversation usage and total cost (admin panel). */
export async function GET() {
  try {
    const logs = await listLogs();
    return NextResponse.json({ logs, summary: summarizeLogs(logs) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "failed to read logs" }, { status: 500 });
  }
}

export async function DELETE() {
  await clearLogs();
  return NextResponse.json({ ok: true });
}
