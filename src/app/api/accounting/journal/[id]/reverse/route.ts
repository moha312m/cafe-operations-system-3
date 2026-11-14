import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { ApiError, handleApiError, requireKey, resolveReadScope } from "@/lib/api";
import { auditInTransaction } from "@/lib/audit";
import { dateStrInTz } from "@/lib/date-range";
import { requestScope, withIdempotency } from "@/lib/idempotency";
import { accountingScope } from "@/lib/accounting/api-scope";
import { reverseEntry } from "@/lib/accounting/ledger";
import { parseDate } from "@/lib/accounting/queries";

type Params = { params: Promise<{ id: string }> };

const reverseInput = z
  .object({
    entryDate: z.string().trim().optional(),
    reason: z.string().trim().min(3, "سبب عكس القيد مطلوب (٣ أحرف على الأقل)").max(300, "سبب العكس طويل"),
  })
  .strict();

// POST /api/accounting/journal/[id]/reverse — post a mirror reversal entry with idempotency and audit.
export async function POST(request: NextRequest, { params }: Params) {
  try {
    const { session, scope } = await accountingScope(request, "accounting.reverse");
    if (resolveReadScope(session).branchId) {
      throw new ApiError(403, "عكس القيود المحاسبية بيتم على مستوى الكافيه كله، مش لفرع");
    }

    const { id } = await params;
    const rawBody = await request.json().catch(() => null);
    if (!rawBody || typeof rawBody !== "object") {
      throw new ApiError(400, "بيانات عكس القيد مطلوبة");
    }
    const parsed = reverseInput.parse(rawBody);
    const today = dateStrInTz(new Date());
    const entryDate = parseDate(parsed.entryDate ?? null, today);
    const payload = { entryDate, reason: parsed.reason };

    return await withIdempotency(
      request,
      requestScope({ ...session, cafeId: scope.cafeId }, `accounting-journal-reverse:${id}`),
      payload,
      async (tx) => {
        const target = await tx.journalEntry.findFirst({
          where: { id, cafeId: scope.cafeId },
          select: { id: true, number: true, reversalOfId: true, reversedBy: { select: { id: true, number: true } } },
        });
        if (!target) throw new ApiError(404, "القيد مش موجود");
        if (target.reversalOfId) throw new ApiError(400, "القيد ده نفسه عكس لقيد تاني");
        if (target.reversedBy) throw new ApiError(409, `القيد ده اتعكس بالفعل بالقيد رقم ${target.reversedBy.number}`);

        const result = await reverseEntry(tx, {
          cafeId: scope.cafeId,
          entryId: target.id,
          entryDate,
          actorId: session.id,
          description: `عكس القيد رقم ${target.number}: ${parsed.reason}`,
        });

        // A different retry key can race the initial lookup. A same-key retry
        // returns the saved response in withIdempotency before reaching this block.
        if (result.replayed) throw new ApiError(409, `القيد ده اتعكس بالفعل بالقيد رقم ${result.entry.number}`);

        await auditInTransaction(tx, {
          cafeId: scope.cafeId,
          userId: session.id,
          action: "ACCOUNTING_JOURNAL_REVERSED",
          entity: "JournalEntry",
          entityId: result.entry.id,
          details: {
            originalEntryId: target.id,
            originalNumber: target.number,
            reversalEntryId: result.entry.id,
            reversalNumber: result.entry.number,
            entryDate,
            reason: parsed.reason,
          },
        });

        return NextResponse.json(
          {
            reversal: {
              id: result.entry.id,
              number: result.entry.number,
              entryDate,
              description: result.entry.description,
              reversalOfId: target.id,
            },
            replayed: result.replayed,
          },
          { status: 201 },
        );
      },
      {
        scope: { cafeId: scope.cafeId },
        authorize: async () => {
          await requireKey("accounting.reverse");
        },
      },
    );
  } catch (error) {
    return handleApiError(error);
  }
}
