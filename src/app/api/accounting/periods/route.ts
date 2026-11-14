import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { ApiError, handleApiError } from "@/lib/api";
import { db } from "@/lib/db";
import { auditInTransaction } from "@/lib/audit";
import { accountingScope } from "@/lib/accounting/api-scope";
import { openPeriod } from "@/lib/accounting/ledger";
import { parseDate } from "@/lib/accounting/queries";
import { setupWrite } from "@/lib/accounting/setup";

const createPeriodInput = z
  .object({
    startsOn: z.string().trim(),
    endsOn: z.string().trim(),
    reason: z.string().trim().min(3, "سبب فتح الفترة ٣ أحرف على الأقل").max(300).optional(),
  })
  .strict();

// GET /api/accounting/periods — list accounting periods with entry counts.
export async function GET(request: NextRequest) {
  try {
    const { scope } = await accountingScope(request, "accounting.view");
    const entity = await db.accountingEntity.findUnique({ where: { cafeId: scope.cafeId }, select: { id: true } });
    if (!entity) return NextResponse.json({ configured: false, periods: [] });

    const periods = await db.accountingPeriod.findMany({
      where: { entityId: entity.id },
      orderBy: { startsOn: "desc" },
      include: {
        closedBy: { select: { name: true } },
        _count: { select: { entries: true } },
      },
    });

    return NextResponse.json({
      configured: true,
      periods: periods.map((p) => ({
        id: p.id,
        startsOn: p.startsOn.toISOString().slice(0, 10),
        endsOn: p.endsOn.toISOString().slice(0, 10),
        status: p.status,
        closedAt: p.closedAt,
        closedBy: p.closedBy?.name ?? null,
        entriesCount: p._count.entries,
      })),
    });
  } catch (error) {
    return handleApiError(error);
  }
}

// POST /api/accounting/periods — open a new non-overlapping accounting period (accounting.setup).
export async function POST(request: NextRequest) {
  try {
    const parsed = createPeriodInput.parse(await request.json().catch(() => ({})));
    const startsOn = parseDate(parsed.startsOn, parsed.startsOn);
    const endsOn = parseDate(parsed.endsOn, parsed.endsOn);
    if (startsOn > endsOn) throw new ApiError(400, "تاريخ البداية لازم يكون قبل أو يساوي تاريخ النهاية");

    const normalized = { startsOn, endsOn, reason: parsed.reason ?? null };

    return await setupWrite(request, "POST /api/accounting/periods", normalized, 201, async (tx, actor, cafeId) => {
      const [entity] = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "AccountingEntity" WHERE "cafeId" = ${cafeId} FOR UPDATE`;
      if (!entity) throw new ApiError(409, "الدفاتر لسه ماتجهزتش للكافيه ده");

      const startDate = new Date(`${startsOn}T00:00:00Z`);
      const endDate = new Date(`${endsOn}T00:00:00Z`);
      const overlap = await tx.accountingPeriod.findFirst({
        where: { entityId: entity.id, startsOn: { lte: endDate }, endsOn: { gte: startDate } },
        select: { startsOn: true, endsOn: true },
      });
      if (overlap) {
        throw new ApiError(
          409,
          `الفترة متداخلة مع فترة موجودة بالفعل (${overlap.startsOn.toISOString().slice(0, 10)} إلى ${overlap.endsOn.toISOString().slice(0, 10)})`,
        );
      }

      const created = await openPeriod(tx, { cafeId, startsOn, endsOn });
      await auditInTransaction(tx, {
        cafeId,
        userId: actor.id,
        action: "ACCOUNTING_PERIOD_OPENED",
        entity: "AccountingPeriod",
        entityId: created.id,
        details: normalized,
      });

      return {
        period: {
          id: created.id,
          startsOn,
          endsOn,
          status: created.status,
          closedAt: null,
          closedBy: null,
          entriesCount: 0,
        },
      };
    });
  } catch (error) {
    return handleApiError(error);
  }
}
