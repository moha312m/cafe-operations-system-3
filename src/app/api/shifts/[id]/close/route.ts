import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getSession } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import { handleApiError, ApiError } from "@/lib/api";
import { audit } from "@/lib/audit";
import { recomputeShiftTotals } from "@/lib/shifts";

type Params = { params: Promise<{ id: string }> };

const closeSchema = z.object({
  actualCashAmount: z.number().min(0),
  notes: z.string().max(1000).optional(),
});

const round2 = (n: number) => Math.round(n * 100) / 100;

// POST /api/shifts/[id]/close — reconcile & close. A cashier may close only
// their own shift; a manager/owner (shifts:read) may close any branch shift.
export async function POST(request: NextRequest, { params }: Params) {
  try {
    const session = await getSession();
    if (!session) throw new ApiError(401, "Not authenticated");
    const { id } = await params;
    const data = closeSchema.parse(await request.json());

    const shift = await db.shift.findUnique({ where: { id } });
    if (!shift) throw new ApiError(404, "Shift not found");
    if (session.role !== "SUPER_ADMIN" && shift.cafeId !== session.cafeId) {
      throw new ApiError(403, "Not allowed");
    }
    if (session.branchId && shift.branchId !== session.branchId) {
      throw new ApiError(403, "Not allowed");
    }
    const isOwnShift = shift.cashierId === session.id;
    const canManage = hasPermission(session.role, "shifts:read");
    if (!isOwnShift && !canManage) {
      throw new ApiError(403, "مينفعش تقفل شيفت كاشير تاني");
    }
    if (shift.status === "CLOSED") {
      throw new ApiError(400, "الشيفت مقفول بالفعل");
    }

    // Freshen the aggregates before reconciling.
    const fresh = (await recomputeShiftTotals(id)) ?? shift;
    const expected = Number(fresh.expectedCashAmount);
    const actual = round2(data.actualCashAmount);
    const difference = round2(actual - expected);

    const closed = await db.shift.update({
      where: { id },
      data: {
        actualCashAmount: actual,
        cashDifference: difference,
        notes: data.notes,
        closedAt: new Date(),
        status: "CLOSED",
      },
      include: {
        cashier: { select: { id: true, name: true } },
        branch: { select: { id: true, name: true } },
      },
    });

    await audit({
      cafeId: shift.cafeId,
      userId: session.id,
      action: "SHIFT_CLOSED",
      entity: "Shift",
      entityId: shift.id,
      details: {
        branchId: shift.branchId,
        shiftId: shift.id,
        shiftNumber: shift.shiftNumber,
        expectedCash: expected,
        actualCash: actual,
        cashDifference: difference,
        closedByManager: !isOwnShift,
      },
    });

    if (difference !== 0) {
      await audit({
        cafeId: shift.cafeId,
        userId: session.id,
        action: "CASH_DIFFERENCE_DETECTED",
        entity: "Shift",
        entityId: shift.id,
        details: {
          branchId: shift.branchId,
          shiftId: shift.id,
          cashDifference: difference,
          kind: difference > 0 ? "SURPLUS" : "SHORTAGE",
        },
      });
    }

    return NextResponse.json({ shift: closed });
  } catch (error) {
    return handleApiError(error);
  }
}
