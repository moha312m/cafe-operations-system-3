import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requirePermission, resolveBranchId, handleApiError } from "@/lib/api";
import { redactBlindCount } from "@/lib/shifts";

// GET /api/shifts/active — the current cashier's open shift (or null).
// Drives the POS shift gate & top bar.
export async function GET(request: NextRequest) {
  try {
    const session = await requirePermission("shifts:operate");
    const branchId = resolveBranchId(
      session,
      request.nextUrl.searchParams.get("branchId")
    );
    const shift = await db.shift.findFirst({
      where: { branchId, cashierId: session.id, status: "OPEN" },
      orderBy: { openedAt: "desc" },
      include: {
        cashier: { select: { id: true, name: true } },
        branch: { select: { id: true, name: true } },
      },
    });
    // SHIFT-003: this is always the requester's own shift, so the
    // reconciliation target is withheld while it is open.
    return NextResponse.json({ shift: shift ? redactBlindCount(shift, session.id) : null });
  } catch (error) {
    return handleApiError(error);
  }
}
