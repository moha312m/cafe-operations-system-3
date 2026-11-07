import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requirePermission, resolveBranchId, handleApiError } from "@/lib/api";
import { getActiveShift, redactBlindCount } from "@/lib/shifts";
import { resolvePermissions } from "@/lib/perms/effective";
import { resolveBranchHandoverConfig } from "@/lib/handover-config";
import { decideMaterialsCount, readMaterialsSchedule } from "@/lib/materials-schedule";
import { fullCountDue } from "@/lib/stock-count-policy";
import { dispositionForShift, listEligibleRecipients } from "@/lib/cash-disposition";
import { planRequiredItems } from "@/lib/handover-required-items";

// GET /api/shifts/close-flow — where the requester's OWN close stands (HND-UX-004).
//
// The two outgoing screens are not one transaction: money commits at the
// close, materials later. So a refreshed or reopened screen must ask the
// server which step remains instead of trusting the tab:
//
//   MONEY      an operational OPEN shift: screen 1 «تسليم الفلوس»
//   MATERIALS  money committed, the handover still DRAFT/REJECTED: screen 2
//   DONE       the outgoing part is recorded (waiting for the receiver, or
//              closed because materials were not due)
//   NONE       nothing of theirs to finish here
//
// It never returns an expected figure to somebody without report access:
// the closer sees what THEY declared, and the shift's own blind-count
// redaction applies to everything else.
const RECENT_MS = 12 * 60 * 60 * 1000;

export async function GET(request: NextRequest) {
  try {
    const session = await requirePermission("shifts:operate");
    const { keys } = await resolvePermissions(session);
    const canViewReports = keys.has("shifts.view_reports");
    const branchId = resolveBranchId(session, request.nextUrl.searchParams.get("branchId"));
    const branch = await db.branch.findUnique({ where: { id: branchId }, select: { id: true, name: true, cafeId: true } });
    if (!branch || (session.cafeId && branch.cafeId !== session.cafeId)) {
      return NextResponse.json({ error: "الفرع مش موجود" }, { status: 404 });
    }

    const open = await getActiveShift(branchId, session.id);
    if (open) {
      const shift = await db.shift.findUniqueOrThrow({ where: { id: open.id } });
      const config = await resolveBranchHandoverConfig(branch.cafeId, branchId);
      const visible = redactBlindCount(shift, canViewReports) as Record<string, unknown>;
      // A preview only, to label the first screen's button. The close decides
      // again under the branch lock, and its answer is the one that counts.
      const schedule = await readMaterialsSchedule(db, branchId);
      const lastClaim = schedule.cadence === "EVERY_SHIFT" ? null : await db.shiftMaterialsDecision.findFirst({
        where: { branchId, cadence: schedule.cadence, periodTo: { not: null } }, orderBy: { periodTo: "desc" }, select: { periodTo: true },
      });
      let preview: { due: boolean; nextDueAt: Date | null } | null = null;
      try { preview = decideMaterialsCount({ at: new Date(), schedule, lastClaimedPeriod: lastClaim?.periodTo ?? null }); } catch { preview = null; }
      // Only someone who may end the night into branch custody needs to know
      // whether the separate periodic FULL count would be due if they did.
      const branchCustodyFullCountDue = keys.has("handover.exception")
        ? (await fullCountDue({ cafeId: branch.cafeId, branchId, at: new Date(), target: "BRANCH_CUSTODY" }).catch(() => null))?.due ?? false
        : false;
      const handoverEnabled = config.enabled && config.configError === null;
      // The items the materials step will ask for, so screen 1 can say so. The same planner the close uses; a
      // broken configuration previews nothing rather than failing the screen.
      const dueItemsPreview = handoverEnabled && (preview?.due ?? true)
        ? await db.$transaction((tx) => planRequiredItems(tx, { cafeId: branch.cafeId, branchId, at: new Date(), target: "SHIFT_TO_SHIFT" }))
            .then((plan) => plan.items.map((item) => ({ id: item.inventoryItemId, name: item.itemNameSnapshot, unit: item.unitSnapshot })))
            .catch(() => [])
        : [];
      return NextResponse.json({
        stage: "MONEY",
        branch: { id: branch.id, name: branch.name },
        shift: {
          id: shift.id,
          shiftNumber: shift.shiftNumber,
          openedAt: shift.openedAt,
          openingCashAmount: shift.openingCashAmount,
          cardSettlementRequired: Number(shift.totalCardSales) !== 0,
          walletSettlementRequired: Number(shift.totalWalletSales) !== 0,
          ...(canViewReports ? {
            expectedCashAmount: visible.expectedCashAmount, totalCashSales: visible.totalCashSales,
            totalCardSales: visible.totalCardSales, totalWalletSales: visible.totalWalletSales,
          } : {}),
        },
        handover: { enabled: handoverEnabled },
        materials: { cadence: config.materials.cadence, duePreview: preview?.due ?? true, nextDueAt: preview?.nextDueAt ?? null, branchCustodyFullCountDue },
        dueItemsPreview,
        branchCustodyItemsPreview: handoverEnabled && branchCustodyFullCountDue
          ? await db.$transaction((tx) => planRequiredItems(tx, { cafeId: branch.cafeId, branchId, at: new Date(), target: "BRANCH_CUSTODY" }))
              .then((plan) => plan.items.map((item) => ({ id: item.inventoryItemId, name: item.itemNameSnapshot, unit: item.unitSnapshot })))
              .catch(() => dueItemsPreview)
          : dueItemsPreview,
        recipients: await listEligibleRecipients(db, { cafeId: branch.cafeId, branchId, excludeUserId: session.id }),
      });
    }

    const last = await db.shift.findFirst({
      where: {
        branchId,
        cashierId: session.id,
        OR: [
          { status: "AWAITING_HANDOVER" },
          { status: "CLOSED", financiallyClosedAt: { gte: new Date(Date.now() - RECENT_MS) } },
        ],
      },
      orderBy: [{ financiallyClosedAt: "desc" }],
      select: {
        id: true, shiftNumber: true, status: true, openedAt: true, financiallyClosedAt: true,
        openingCashAmount: true, actualCashAmount: true, notes: true, cashReasonNote: true,
        tenderReconciliations: { select: { method: true, actualAmount: true, ...(canViewReports ? { expectedAmount: true, varianceAmount: true } : {}) }, orderBy: { method: "asc" } },
        ...(canViewReports ? { expectedCashAmount: true, cashDifference: true } : {}),
        materialsDecision: { select: { due: true, reason: true, cadence: true, periodFrom: true, periodTo: true, nextDueAt: true } },
        handoversOutgoing: {
          orderBy: { createdAt: "desc" },
          take: 1,
          select: { id: true, status: true, target: true, directHandover: true, stockCountSessionId: true, requiredItemCount: true, outgoingNote: true, submittedAt: true },
        },
      },
    });
    if (!last) return NextResponse.json({ stage: "NONE", branch: { id: branch.id, name: branch.name } });
    const handover = last.handoversOutgoing[0] ?? null;
    const stage = last.status === "AWAITING_HANDOVER" && handover && ["DRAFT", "REJECTED"].includes(handover.status)
      ? "MATERIALS"
      : "DONE";
    const { handoversOutgoing: _unused, ...shift } = last;
    void _unused;
    const [cashDisposition, recipients, nightStorage] = await Promise.all([
      dispositionForShift(db, last.id),
      listEligibleRecipients(db, { cafeId: branch.cafeId, branchId, excludeUserId: session.id }),
      db.cashStorage.findUnique({ where: { outgoingShiftId: last.id }, select: { id: true } }),
    ]);
    // A night-storage declaration is this close's cash partition; every other close owes a disposition.
    return NextResponse.json({ stage, branch: { id: branch.id, name: branch.name }, shift, handover, cashDisposition, recipients, nightCashStored: !!nightStorage });
  } catch (error) {
    return handleApiError(error);
  }
}
