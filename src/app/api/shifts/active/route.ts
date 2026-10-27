import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requirePermission, resolveBranchId, handleApiError } from "@/lib/api";
import { getActiveShift, redactBlindCount } from "@/lib/shifts";
import { resolvePermissions } from "@/lib/perms/effective";
import { pendingHandover as selectPendingHandover } from "@/components/handovers/workflow-state";

// GET /api/shifts/active — the current cashier's open shift (or null).
// Drives the POS shift gate & top bar.
export async function GET(request: NextRequest) {
  try {
    const session = await requirePermission("shifts:operate");
    const { keys } = await resolvePermissions(session);
    const canViewReports = keys.has("shifts.view_reports");
    const branchId = resolveBranchId(
      session,
      request.nextUrl.searchParams.get("branchId")
    );
    const operational = await getActiveShift(branchId, session.id);
    const shift = operational
      ? await db.shift.findUnique({
      where: { id: operational.id },
      include: {
        cashier: { select: { id: true, name: true } },
        branch: { select: { id: true, name: true } },
      },
        })
      : null;
    const pendingShift = shift ? null : await db.shift.findFirst({
      where: { branchId, cashierId: session.id, status: 'OPEN' }, orderBy: { openedAt: 'desc' },
      include: { cashier: { select: { id: true, name: true } }, branch: { select: { id: true, name: true } }, openingCashReceipt: { select: { status: true } }, placeReceipt: { select: { id: true, status: true, assignedUser: { select: { id: true, name: true } } } } },
    });
    // Safe navigation context, not custody authorization. Never guess between
    // multiple live records or expose handover details without its view key.
    const candidates = keys.has("handover.view") && pendingShift?.custodyGateReason === "AWAITING_CUSTODY_TRANSFER"
      ? await db.handoverSession.findMany({
          where: { cafeId: pendingShift.cafeId, branchId, status: { in: ["DRAFT", "REJECTED", "OUTGOING_SUBMITTED", "INCOMING_REVIEW"] }, outgoingStockCustodyId: { not: null } },
          select: { id: true, branchId: true, status: true, stockCountSessionId: true, outgoingUser: { select: { name: true } }, outgoingShift: { select: { shiftNumber: true } } },
          take: 2,
        }) : [];
    const pendingHandover = selectPendingHandover(candidates, branchId);
    // SHIFT-003: this is always the requester's own shift, so the
    // reconciliation target is withheld while it is open.
    return NextResponse.json({ shift: shift ? redactBlindCount(shift, canViewReports) : null, pendingShift: pendingShift ? { ...redactBlindCount(pendingShift, canViewReports), pendingHandover } : null });
  } catch (error) {
    return handleApiError(error);
  }
}
