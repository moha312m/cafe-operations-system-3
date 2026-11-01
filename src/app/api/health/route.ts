import { NextResponse } from "next/server";
import { db } from "@/lib/db";

// Liveness + database reachability for the host's health check. Unauthenticated,
// so it returns no business data: only whether a trivial query succeeded and which
// commit is running (Railway sets RAILWAY_GIT_COMMIT_SHA; absent locally).
export const dynamic = "force-dynamic";

export async function GET() {
  const commit = process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 12) ?? null;
  try {
    await db.$queryRaw`SELECT 1`;
    return NextResponse.json({ ok: true, database: "up", commit }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ ok: false, database: "down", commit }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
