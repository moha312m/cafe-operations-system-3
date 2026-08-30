import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getSession } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import { handleApiError, ApiError } from "@/lib/api";
import { closeShiftWithCashCount } from "@/lib/cash-close";

type Params = { params: Promise<{ id: string }> };

// `reason` is the cash-variance explanation and is required by the service
// when the variance is non-zero — the rule is stated once, in `cash-close`,
// rather than duplicated into a conditional schema here. `notes` stays what it
// always was: a free-text shift note that explains nothing in particular.
//
// The schema is deliberately narrow. Nothing accepts a tolerance, a bound or
// an acceptability verdict, so a client cannot smuggle one in and have it
// stored beside figures the server produced.
const closeSchema = z.object({
  actualCashAmount: z.number().min(0),
  reason: z.string().max(1000).optional(),
  notes: z.string().max(1000).optional(),
});

// POST /api/shifts/[id]/close — reconcile & close. A cashier may close only
// their own shift; a manager/owner (shifts:read) may close any branch shift.
//
// Authorization and tenancy are settled HERE, before the money is touched.
// `closeShiftWithCashCount` then performs the whole close — snapshot, variance
// case and audit — as one transaction, so a failure anywhere in it leaves the
// shift open rather than closed-without-evidence.
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
    // Re-checked under a row lock inside the transaction; refused here too so
    // an obviously-settled shift costs nothing to turn away.
    if (shift.status === "CLOSED") {
      throw new ApiError(400, "الشيفت مقفول بالفعل");
    }

    await closeShiftWithCashCount({
      shiftId: id,
      actualCash: data.actualCashAmount,
      reason: data.reason,
      notes: data.notes,
      actorId: session.id,
      closedByManager: !isOwnShift,
    });

    // Read back what was COMMITTED, rather than reporting what we intended to
    // write. The blind-count redaction does not apply: the shift is CLOSED now,
    // and revealing the target to the person who just counted it is the whole
    // point of doing so after the server has persisted the count (SHIFT-003).
    const closed = await db.shift.findUniqueOrThrow({
      where: { id },
      include: {
        cashier: { select: { id: true, name: true } },
        branch: { select: { id: true, name: true } },
        closedBy: { select: { id: true, name: true } },
      },
    });

    return NextResponse.json({ shift: closed });
  } catch (error) {
    return handleApiError(error);
  }
}
