import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { resolvePermissions } from "@/lib/perms/effective";
import { requirePermission, resolveCafeId, resolveBranchId, handleApiError, ApiError, requireFeature, requireActiveSession, isUniqueConflict, retryOnUniqueConflict } from "@/lib/api";
import { audit } from "@/lib/audit";
import { redactBlindCount } from "@/lib/shifts";
import { ensureCustodyForShift } from "@/lib/custody";
import { resolveStaffBranchInTransaction } from "@/lib/staff-branch";
import { protectedTransaction, protectedContext } from "@/lib/protected-transaction";
import { lockShifts, lockBranchAllocator } from "@/lib/transaction-locks";

const shiftInclude = {
  openingCashReceipt: { select: { status: true } },
  placeReceipt: { select: { status: true, assignedUser: { select: { id: true, name: true } } } },
  cashier: { select: { id: true, name: true } },
  branch: { select: { id: true, name: true } },
} as const;

// GET /api/shifts — list shifts. Managers/owners (shifts:read) see the whole
// branch/cafe; cashiers see only their own.
export async function GET(request: NextRequest) {
  try {
    const session = await requireActiveSession();
    // R-SEC-01 — whose shifts you may read is an effective-permission
    // question, not a legacy-role one. `shifts.view_reports` is oversight of
    // other people's shifts; `shifts.view_current` is operating your own.
    const { keys } = await resolvePermissions(session);
    const canReadAll = keys.has("shifts.view_reports");
    const canOperate = keys.has("shifts.view_current");
    if (!canReadAll && !canOperate) throw new ApiError(403, "Not allowed");

    const params = request.nextUrl.searchParams;
    const cafeId = resolveCafeId(session, params.get("cafeId"));

    // Branch scope: pinned staff are locked to their branch.
    const branchId = session.branchId ?? params.get("branchId") ?? undefined;
    // Cashiers without read permission only ever see their own shifts.
    const cashierId = canReadAll ? params.get("cashierId") ?? undefined : session.id;
    const status = params.get("status");
    const date = params.get("date");

    let dateFilter: { gte: Date; lt: Date } | undefined;
    if (date) {
      const start = new Date(`${date}T00:00:00`);
      if (isNaN(start.getTime())) throw new ApiError(400, "Invalid date");
      const end = new Date(start);
      end.setDate(end.getDate() + 1);
      dateFilter = { gte: start, lt: end };
    }

    // When reporting on CLOSED shifts, key the day filter on closedAt so a
    // shift opened before midnight but closed today lands on the right day.
    // Otherwise (OPEN / all) key on openedAt.
    const dateWhere = dateFilter
      ? status === "CLOSED"
        ? { closedAt: dateFilter }
        : { openedAt: dateFilter }
      : {};

    const shifts = await db.shift.findMany({
      where: {
        cafeId,
        ...(branchId ? { branchId } : {}),
        ...(cashierId ? { cashierId } : {}),
        ...(status === "OPEN" || status === "CLOSED" ? { status } : {}),
        ...dateWhere,
      },
      include: shiftInclude,
      orderBy: { openedAt: "desc" },
      take: 200,
    });
    // Counters see their submitted amounts without reconciliation totals;
    // report access retains full shift visibility for oversight.
    return NextResponse.json({
      shifts: shifts.map((s) => redactBlindCount(s, canReadAll)),
    });
  } catch (error) {
    return handleApiError(error);
  }
}
const openShiftSchema = z.object({
  branchId: z.string().optional(),
  cafeId: z.string().optional(),
  openingCashAmount: z.number().min(0).default(0),
  resumeOnly: z.boolean().default(false),
});

// POST /api/shifts — open a shift. One open shift per cashier per branch;
// if one is already open it's returned instead of creating a duplicate.
export async function POST(request: NextRequest) {
  try {
    const session = await requirePermission("shifts:operate");
    const { keys } = await resolvePermissions(session);
    const canViewReports = keys.has("shifts.view_reports");
    await requireFeature(session, "shiftManagementEnabled");
    const data = openShiftSchema.parse(await request.json());
    const cafeId = resolveCafeId(session, data.cafeId);
    const branchId = resolveBranchId(session, data.branchId);

    const branch = await db.branch.findFirst({ where: { id: branchId, cafeId, isActive: true } });
    if (!branch) throw new ApiError(400, "الفرع غير موجود أو غير مفعّل في الكافيه");

    // Assignment changes and opening share the User lock; drawer numbers
    // then serialise on Branch. NO KEY UPDATE permits the Branch FK KEY SHARE
    // needed by an acceptance while bootstrap waits on its Handover row.
    // The unique constraints and retry remain backstops for other writers.
    let shift;
    let alreadyOpen = false;
    try {
      shift = await retryOnUniqueConflict(() => protectedTransaction(async (tx) => {
        const scope = await resolveStaffBranchInTransaction(tx, session.id);
        if (!scope || (session.role !== "CAFE_OWNER" && session.role !== "SUPER_ADMIN" && scope.branchId !== branchId)) {
          throw new ApiError(409, "تم تغيير فرعك — حدّث الصفحة وافتح الشيفت في فرعك الحالي");
        }
        protectedContext(tx).scope = { cafeId, branchId };
        const candidate = await tx.shift.findFirst({ where: { cafeId, branchId, cashierId: session.id, status: "OPEN" }, select: { id: true } });
        if (candidate) await lockShifts(tx, [candidate.id]);
        await lockBranchAllocator(tx, branchId);
        const existing = await tx.shift.findFirst({
          where: { cafeId, branchId, cashierId: session.id, status: "OPEN" }, include: shiftInclude,
        });
        if (existing) {
          if (existing.id !== candidate?.id) throw new ApiError(409, "الشيفت اتغير أثناء الفتح — جرّب تاني");
          await ensureCustodyForShift(tx, {
            cafeId, branchId, shiftId: existing.id, userId: session.id,
            openingCashAmount: Number(existing.openingCashAmount),
          });
          alreadyOpen = true;
          return tx.shift.findUniqueOrThrow({ where: { id: existing.id }, include: shiftInclude });
        }
        if (data.resumeOnly) throw new ApiError(409, "افتح شيفتك وأدخل رصيد الافتتاح من نقطة البيع أولًا");
        const last = await tx.shift.aggregate({
          where: { branchId },
          _max: { shiftNumber: true },
        });
        const created = await tx.shift.create({
          data: {
            cafeId,
            branchId,
            cashierId: session.id,
            shiftNumber: (last._max.shiftNumber ?? 0) + 1,
            openingCashAmount: data.openingCashAmount,
            expectedCashAmount: data.openingCashAmount,
          },
          include: shiftInclude,
        });
        await ensureCustodyForShift(tx, {
          cafeId,
          branchId,
          shiftId: created.id,
          userId: session.id,
          openingCashAmount: data.openingCashAmount,
        });
        const placeSettings = await tx.branchOpeningSettings.findUnique({ where: { branchId }, select: { placeAcceptanceRequired: true, placeInspectorId: true } });
        if (placeSettings?.placeAcceptanceRequired) {
          if (!placeSettings.placeInspectorId) throw new ApiError(409, "The branch place inspector is not configured");
          const assets = await tx.placeAsset.findMany({ where: { cafeId, branchId, isActive: true }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { id: true, name: true, area: true, checkpoints: { orderBy: [{ sortOrder: "asc" }, { id: "asc" }], select: { id: true, label: true, required: true, critical: true } } } });
          if (assets.length === 0) throw new ApiError(409, "The required place checklist is empty");
          await tx.shiftPlaceReceipt.create({ data: { cafeId, branchId, incomingShiftId: created.id, assignedUserId: placeSettings.placeInspectorId, createdById: session.id, snapshot: assets as unknown as import("@prisma/client").Prisma.InputJsonValue } });
        }
        return tx.shift.findUniqueOrThrow({ where: { id: created.id }, include: shiftInclude });
      }), {
        field: "shiftNumber",
        message: "في شيفت تاني اتفتح في نفس اللحظة — جرّب تاني",
      });
    } catch (e) {
      if (!isUniqueConflict(e, "cashierId")) throw e;
      const winner = await db.shift.findFirst({
        where: { branchId, cashierId: session.id, status: "OPEN" },
        include: shiftInclude,
      });
      // Only the cashier index could have refused this, so the winning drawer
      // must exist. If it somehow does not, the conflict was something else
      // and is not ours to translate.
      if (!winner) throw e;
      return NextResponse.json({
        shift: redactBlindCount(winner, canViewReports),
        alreadyOpen: true,
      });
    }

    if (alreadyOpen) return NextResponse.json({ shift: redactBlindCount(shift, canViewReports), alreadyOpen: true });

    await audit({
      cafeId,
      userId: session.id,
      action: "SHIFT_OPENED",
      entity: "Shift",
      entityId: shift.id,
      details: {
        branchId,
        shiftId: shift.id,
        shiftNumber: shift.shiftNumber,
        openingCashAmount: Number(shift.openingCashAmount),
      },
    });

    // Use the same visibility rule on opening as on subsequent reads.
    return NextResponse.json(
      { shift: redactBlindCount(shift, canViewReports) },
      { status: 201 }
    );
  } catch (error) {
    return handleApiError(error);
  }
}
