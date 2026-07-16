import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getSession } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import {
  requirePermission,
  resolveCafeId,
  resolveBranchId,
  handleApiError,
  ApiError,
  requireFeature,
} from "@/lib/api";
import { audit } from "@/lib/audit";

const shiftInclude = {
  cashier: { select: { id: true, name: true } },
  branch: { select: { id: true, name: true } },
} as const;

// GET /api/shifts — list shifts. Managers/owners (shifts:read) see the whole
// branch/cafe; cashiers see only their own.
export async function GET(request: NextRequest) {
  try {
    const session = await getSession();
    if (!session) throw new ApiError(401, "Not authenticated");
    const canReadAll = hasPermission(session.role, "shifts:read");
    const canOperate = hasPermission(session.role, "shifts:operate");
    if (!canReadAll && !canOperate) throw new ApiError(403, "Not allowed");

    const params = request.nextUrl.searchParams;
    const cafeId = resolveCafeId(session, params.get("cafeId"));

    // Branch scope: pinned staff are locked to their branch.
    const branchId = session.branchId ?? params.get("branchId") ?? undefined;
    // Cashiers without read permission only ever see their own shifts.
    const cashierId = canReadAll ? params.get("cashierId") ?? undefined : session.id;
    const status = params.get("status");
    const date = params.get("date");

    let openedFilter: { gte: Date; lt: Date } | undefined;
    if (date) {
      const start = new Date(`${date}T00:00:00`);
      if (isNaN(start.getTime())) throw new ApiError(400, "Invalid date");
      const end = new Date(start);
      end.setDate(end.getDate() + 1);
      openedFilter = { gte: start, lt: end };
    }

    const shifts = await db.shift.findMany({
      where: {
        cafeId,
        ...(branchId ? { branchId } : {}),
        ...(cashierId ? { cashierId } : {}),
        ...(status === "OPEN" || status === "CLOSED" ? { status } : {}),
        ...(openedFilter ? { openedAt: openedFilter } : {}),
      },
      include: shiftInclude,
      orderBy: { openedAt: "desc" },
      take: 200,
    });
    return NextResponse.json({ shifts });
  } catch (error) {
    return handleApiError(error);
  }
}

const openShiftSchema = z.object({
  branchId: z.string().optional(),
  cafeId: z.string().optional(),
  openingCashAmount: z.number().min(0).default(0),
});

// POST /api/shifts — open a shift. One open shift per cashier per branch;
// if one is already open it's returned instead of creating a duplicate.
export async function POST(request: NextRequest) {
  try {
    const session = await requirePermission("shifts:operate");
    await requireFeature(session, "shiftManagementEnabled");
    const data = openShiftSchema.parse(await request.json());
    const cafeId = resolveCafeId(session, data.cafeId);
    const branchId = resolveBranchId(session, data.branchId);

    const existing = await db.shift.findFirst({
      where: { branchId, cashierId: session.id, status: "OPEN" },
      include: shiftInclude,
    });
    if (existing) {
      return NextResponse.json({ shift: existing, alreadyOpen: true });
    }

    const branch = await db.branch.findFirst({
      where: { id: branchId, cafeId, isActive: true },
    });
    if (!branch) throw new ApiError(400, "Branch not found in this cafe");

    const shift = await db.$transaction(async (tx) => {
      const last = await tx.shift.aggregate({
        where: { branchId },
        _max: { shiftNumber: true },
      });
      return tx.shift.create({
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
    });

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
        openingCashAmount: data.openingCashAmount,
      },
    });

    return NextResponse.json({ shift }, { status: 201 });
  } catch (error) {
    return handleApiError(error);
  }
}
