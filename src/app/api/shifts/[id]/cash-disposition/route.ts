import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { ApiError, handleApiError, requirePermission } from "@/lib/api";
import { resolvePermissions } from "@/lib/perms/effective";
import { withIdempotency, requestScope } from "@/lib/idempotency";
import { attemptKey } from "@/lib/attempt-key";
import { closingCashPosition, dispositionForShift, listEligibleRecipients, recordCashDispositionInTransaction, MAX_DELIVERIES } from "@/lib/cash-disposition";

type Params = { params: Promise<{ id: string }> };

// `.strict()`: the counted cash, the expected cash and the difference are the SERVER's
// figures, read from the persisted close. A body that carries them is refused by name
// rather than quietly ignored.
const bodySchema = z
  .object({
    deliveries: z
      .array(
        z.object({
          destination: z.enum(["OWNER", "MANAGER"]),
          recipientId: z.string().min(1),
          amount: z.union([z.number(), z.string()]),
          reference: z.string().max(160).nullish(),
        }).strict()
      )
      .max(MAX_DELIVERIES),
    retainedAmount: z.union([z.number(), z.string()]),
    note: z.string().max(1000).nullish(),
    idempotencyKey: z.string().min(1).max(200).optional(),
  })
  .strict();

// GET /api/shifts/:id/cash-disposition — the closing position, any recorded allocation and who can receive.
export async function GET(_request: NextRequest, { params }: Params) {
  try {
    const session = await requirePermission("shifts:operate");
    const { keys } = await resolvePermissions(session);
    const { id } = await params;
    const position = await closingCashPosition(db, id);
    if (!position || (session.cafeId && position.cafeId !== session.cafeId)) throw new ApiError(404, "الشيفت مش موجود");
    if (position.cashierId !== session.id && !keys.has("shifts.close_others")) throw new ApiError(403, "ليس لديك صلاحية على الشيفت ده");
    const [disposition, recipients, cafe] = await Promise.all([
      dispositionForShift(db, id),
      listEligibleRecipients(db, { cafeId: position.cafeId, branchId: position.branchId, excludeUserId: position.cashierId }),
      db.cafe.findUniqueOrThrow({ where: { id: position.cafeId }, select: { currency: true } }),
    ]);
    // What the closer declared is theirs to see; the expected figure and difference need report access.
    const canViewReports = keys.has("shifts.view_reports");
    return NextResponse.json({
      currency: cafe.currency,
      shift: {
        id: position.id, shiftNumber: position.shiftNumber, status: position.status, financiallyClosed: position.financiallyClosedAt !== null,
        countedCash: position.actualCashAmount === null ? null : Number(position.actualCashAmount),
        ...(canViewReports ? { expectedCash: Number(position.expectedCashAmount), cashDifference: position.cashDifference === null ? null : Number(position.cashDifference) } : {}),
        // Already reflected in the expected cash: shown so nobody re-declares them as deliveries.
        drawerPayouts: canViewReports ? { supplierPayouts: Number(position.totalCashPayouts), expensePayouts: Number(position.totalExpensePayouts), expenseReturns: Number(position.totalExpenseReturns) } : null,
        electronic: { card: Number(position.totalCardSales), wallet: Number(position.totalWalletSales) },
      },
      disposition,
      recipients,
    });
  } catch (error) {
    return handleApiError(error);
  }
}

// POST /api/shifts/:id/cash-disposition — record where the counted cash went (once).
export async function POST(request: NextRequest, { params }: Params) {
  try {
    const session = await requirePermission("shifts:operate");
    const { keys } = await resolvePermissions(session);
    const { id } = await params;
    const body = bodySchema.parse(await request.json());
    const key = attemptKey(request, body.idempotencyKey);
    return await withIdempotency(request, requestScope(session, `POST /api/shifts/${id}/cash-disposition`), { ...body, idempotencyKey: undefined }, async (tx) => {
      const result = await recordCashDispositionInTransaction(tx, {
        actor: { id: session.id, cafeId: session.cafeId, role: session.role },
        canActForOthers: keys.has("shifts.close_others"),
        input: { shiftId: id, deliveries: body.deliveries, retainedAmount: body.retainedAmount, note: body.note ?? null, idempotencyKey: key },
      });
      return NextResponse.json(result, { status: result.alreadyRecorded ? 200 : 201 });
    });
  } catch (error) {
    return handleApiError(error);
  }
}
