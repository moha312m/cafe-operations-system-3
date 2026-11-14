import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { ApiError, handleApiError, requireKey, resolveReadScope } from "@/lib/api";
import { auditInTransaction } from "@/lib/audit";
import { requestScope, withIdempotency } from "@/lib/idempotency";
import { accountingScope } from "@/lib/accounting/api-scope";
import { closeCheckedPeriodTx } from "@/lib/accounting/close-checklist";

type Params = { params: Promise<{ id: string }> };

const closeInput = z
  .object({
    note: z.string().trim().max(300, "الملاحظة طويلة").optional(),
  })
  .strict();

// POST /api/accounting/periods/[id]/close — enforce checklist + locks and close an open period.
export async function POST(request: NextRequest, { params }: Params) {
  try {
    const { session, scope } = await accountingScope(request, "accounting.close");
    if (resolveReadScope(session).branchId) {
      throw new ApiError(403, "إقفال الفترة المحاسبية لصاحب الكافيه على مستوى الكافيه كله، مش لفرع");
    }

    const { id } = await params;
    const rawBody = await request.json().catch(() => ({}));
    const body = closeInput.parse(rawBody ?? {});

    return await withIdempotency(
      request,
      requestScope({ ...session, cafeId: scope.cafeId }, `accounting-period-close:${id}`),
      body,
      async (tx) => {
        const checklist = await closeCheckedPeriodTx(tx, {
          cafeId: scope.cafeId,
          periodId: id,
          actorId: session.id,
          beforeCommit: async () => {
            await auditInTransaction(tx, {
              cafeId: scope.cafeId,
              userId: session.id,
              action: "ACCOUNTING_PERIOD_CLOSED",
              entity: "AccountingPeriod",
              entityId: id,
              details: { note: body.note ?? null },
            });
          },
        });
        return NextResponse.json({ closed: true, periodId: id, checklist });
      },
      {
        scope: { cafeId: scope.cafeId },
        authorize: async () => {
          await requireKey("accounting.close");
        },
      },
    );
  } catch (error) {
    return handleApiError(error);
  }
}
