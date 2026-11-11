import { NextResponse, type NextRequest } from "next/server";
import { requireActiveSession, handleApiError, ApiError } from "@/lib/api";
import { db } from "@/lib/db";
import { round3 } from "@/lib/costing";
import { auditInTransaction } from "@/lib/audit";
import { isTerminal } from "@/lib/count-disposition";

type Params = { params: Promise<{ id: string }> };

const STOCK_COUNT_RESYNCED_AUDIT_ACTION = "STOCK_COUNT_RESYNCED";

/** Statuses whose lines may still be re-measured: nothing has been confirmed yet. */
const RESYNCABLE = ["DRAFT", "IN_PROGRESS", "SUBMITTED", "RECOUNT_REQUIRED"] as const;

// POST /api/stock-counts/:id/re-sync — re-read the expected figure of an
// ORDINARY count from today's balance.
//
// What this is for: an ordinary count taken while the shelf kept moving (a
// purchase booked in after the counter walked past). What it is NOT for:
// a handover count or an opening verification, whose expected figures are
// pinned to the count point under a freeze or a branch custody — rewriting
// those would turn a custodian's difference into "no difference" with nothing
// on the record. Those contexts are refused by name.
//
// It is the OWNER's act. It changes evidence, so every touched line's old and
// new figures are written to the audit row, judged lines (terminal
// dispositions) are left exactly as they were, and a submitted count goes
// back to IN_PROGRESS so the tolerance verdicts are re-derived on the next
// submit rather than hand-written here.
export async function POST(request: NextRequest, { params }: Params) {
  try {
    const session = await requireActiveSession();
    const { id } = await params;
    if (session.role !== "CAFE_OWNER" && session.role !== "SUPER_ADMIN") {
      throw new ApiError(403, "مزامنة المتوقع مع المخزن مخصصة لصاحب الكافيه فقط");
    }

    const countSession = await db.stockCountSession.findUnique({
      where: { id },
      select: { id: true, cafeId: true, branchId: true, status: true, accountabilityContext: true, handoverId: true, openingBranchCustodyPeriodId: true },
    });
    if (!countSession || (session.cafeId && countSession.cafeId !== session.cafeId)) {
      throw new ApiError(404, "جلسة الجرد غير موجودة");
    }
    if (session.branchId && countSession.branchId !== session.branchId) {
      throw new ApiError(403, "ليس لديك صلاحية على فرع تاني");
    }
    if (countSession.accountabilityContext !== "NONE" || countSession.handoverId || countSession.openingBranchCustodyPeriodId) {
      throw new ApiError(409, "مزامنة المتوقع مش متاحة لجرد التسليم أو الجرد الافتتاحي — دول بيتقاسوا على نقطة الجرد الأصلية. الفروق تتراجع من صفحة التسليم");
    }

    const outcome = await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "StockCountSession" WHERE "id" = ${id} FOR UPDATE`;
      const current = await tx.stockCountSession.findUniqueOrThrow({
        where: { id },
        select: {
          status: true,
          lines: {
            select: {
              id: true, disposition: true, countedQuantity: true, effectiveCountedQuantity: true, expectedQuantity: true, varianceQuantity: true,
              inventoryItem: { select: { id: true, name: true, currentStock: true } },
            },
          },
        },
      });
      if (!(RESYNCABLE as readonly string[]).includes(current.status)) {
        throw new ApiError(409, "لا يمكن إعادة مزامنة جلسة جرد مغلقة أو معتمدة نهائياً");
      }

      const changes: { lineId: string; itemId: string; name: string; before: { expected: string | null; variance: string | null; disposition: string }; after: { expected: number; variance: number; disposition: string } }[] = [];
      let skippedJudged = 0;
      for (const line of current.lines) {
        const activeCounted = line.effectiveCountedQuantity ?? line.countedQuantity;
        if (activeCounted === null) continue;
        if (isTerminal(line.disposition)) { skippedJudged += 1; continue; }
        const newExpected = round3(Number(line.inventoryItem.currentStock));
        const newVariance = round3(Number(activeCounted) - newExpected);
        await tx.stockCountLine.update({
          where: { id: line.id },
          // Back to the un-judged state: the next submit derives the verdict
          // against the tolerance, as every other count does.
          data: { expectedQuantity: newExpected, varianceQuantity: newVariance, disposition: "COUNTED" },
        });
        changes.push({
          lineId: line.id, itemId: line.inventoryItem.id, name: line.inventoryItem.name,
          before: { expected: line.expectedQuantity?.toString() ?? null, variance: line.varianceQuantity?.toString() ?? null, disposition: line.disposition },
          after: { expected: newExpected, variance: newVariance, disposition: "COUNTED" },
        });
      }

      const reopened = current.status === "SUBMITTED" || current.status === "RECOUNT_REQUIRED";
      if (reopened && changes.length > 0) {
        await tx.stockCountSession.update({ where: { id }, data: { status: "IN_PROGRESS", submittedAt: null } });
      }

      await auditInTransaction(tx, {
        cafeId: countSession.cafeId,
        userId: session.id,
        action: STOCK_COUNT_RESYNCED_AUDIT_ACTION,
        entity: "StockCountSession",
        entityId: countSession.id,
        details: {
          branchId: countSession.branchId,
          previousStatus: current.status,
          reopened: reopened && changes.length > 0,
          updatedLinesCount: changes.length,
          skippedJudgedLines: skippedJudged,
          changes: changes.slice(0, 500),
        },
      });
      return { changes: changes.length, skippedJudged, reopened: reopened && changes.length > 0 };
    });

    return NextResponse.json({
      success: true,
      updatedLinesCount: outcome.changes,
      skippedJudgedLines: outcome.skippedJudged,
      reopened: outcome.reopened,
      message: outcome.changes === 0
        ? "مفيش سطور اتغيرت — الأصناف المعدودة كلها اتحكم فيها خلاص أو لسه ما اتعدتش"
        : `اتحدّث المتوقع لـ ${outcome.changes} صنف${outcome.skippedJudged ? ` (${outcome.skippedJudged} سطر محكوم فيه اتساب زي ما هو)` : ""}${outcome.reopened ? " — ابعت الجرد تاني عشان الفروقات تتقيّم من جديد" : ""}`,
    });
  } catch (error) {
    return handleApiError(error);
  }
}
