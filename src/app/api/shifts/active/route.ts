import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { ApiError, requirePermission, resolveBranchId, handleApiError } from "@/lib/api";
import { getActiveShift, redactBlindCount } from "@/lib/shifts";
import { resolvePermissions } from "@/lib/perms/effective";
import { openingCarryforward } from "@/lib/opening-carryforward";
import { incompleteOpeningCustody, LIVE_HANDOVER_STATUSES, reconcileStrandedShifts } from "@/lib/custody";
import { shiftOpeners, shiftOpeningRequirements } from "@/lib/shift-opening-view";

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
    const branch = await db.branch.findFirst({
      where: { id: branchId, ...(session.cafeId ? { cafeId: session.cafeId } : {}) },
      select: {
        cafeId: true,
        cafe: { select: { settings: { select: { inventoryEnabled: true } } } },
        openingSettings: { select: { placeAcceptanceRequired: true, updatedAt: true } },
      },
    });
    if (!branch) throw new ApiError(404, "الفرع مش موجود");
    await reconcileStrandedShifts(db, branchId);
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
    const [candidates, periods, openers, carryforward] = await Promise.all([
      !shift && (!pendingShift || pendingShift.custodyGateReason === "AWAITING_CUSTODY_TRANSFER")
      ? db.handoverSession.findMany({
          where: { cafeId: branch.cafeId, branchId, status: { in: [...LIVE_HANDOVER_STATUSES] }, outgoingStockCustodyId: { not: null } },
          select: { id: true, status: true, outgoingUserId: true, stockCountSessionId: true, stockCountSession: { select: { status: true } }, outgoingUser: { select: { name: true } }, outgoingShift: { select: { shiftNumber: true } } },
          take: 2,
        }) : [],
      !shift && !pendingShift ? db.custodyPeriod.findMany({
        where: { cafeId: branch.cafeId, branchId, status: "OPEN" },
        select: { scope: true, holderType: true },
      }) : [],
      shiftOpeners(branch.cafeId, [shift?.id ?? pendingShift?.id].filter((id): id is string => !!id)),
      !shift && !pendingShift
        ? openingCarryforward(db, { cafeId: branch.cafeId, branchId, canSeeBlindAmounts: canViewReports })
        : null,
    ]);
    // Match the detail route's read rules and check uniqueness before considering visibility.
    const match = candidates.length === 1 ? candidates[0] : null;
    const canViewHandover = keys.has("handover.view") &&
      (session.role === "SUPER_ADMIN" || branch.cafe.settings?.inventoryEnabled !== false);
    const pendingHandover = match && canViewHandover && (
      match.status === "OUTGOING_SUBMITTED" || match.status === "INCOMING_REVIEW" || match.outgoingUserId === session.id
    ) ? match : null;
    const blocker = candidates.length === 0 ? incompleteOpeningCustody(
      periods.find((period) => period.scope === "CASH")?.holderType,
      periods.find((period) => period.scope === "STOCK")?.holderType,
    ) : null;
    // SHIFT-003: this is always the requester's own shift, so the
    // reconciliation target is withheld while it is open.
    return NextResponse.json({
      shift: shift ? { ...redactBlindCount(shift, canViewReports), openedBy: openers.get(shift.id) ?? null } : null,
      pendingShift: pendingShift ? {
        ...redactBlindCount(pendingShift, canViewReports),
        openedBy: openers.get(pendingShift.id) ?? null,
        waitingFor: shiftOpeningRequirements(pendingShift, branch.openingSettings),
        pendingHandover,
      } : null,
      openingBlocker: blocker ? { code: blocker } : null,
      carryforward: carryforward ? {
        ...carryforward,
        pendingDirectHandoverId: pendingHandover?.id === carryforward.pendingDirectHandoverId
          ? carryforward.pendingDirectHandoverId : null,
      } : null,
    });
  } catch (error) {
    return handleApiError(error);
  }
}
