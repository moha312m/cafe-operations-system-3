import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { handleApiError, requireActiveSession } from "@/lib/api";
import { deliveriesAwaitingViewer } from "@/lib/cash-disposition";

// GET /api/cash-deliveries — declared deliveries awaiting this viewer: their own to confirm or dispute,
// and (café owner) every pending delivery and open dispute of the café.
export async function GET() {
  try {
    const session = await requireActiveSession();
    const deliveries = await deliveriesAwaitingViewer(db, { id: session.id, role: session.role, cafeId: session.cafeId });
    return NextResponse.json({ deliveries }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return handleApiError(error);
  }
}
