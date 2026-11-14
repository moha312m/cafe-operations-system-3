import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { ApiError, handleApiError } from "@/lib/api";
import { db } from "@/lib/db";
import { accountingScope } from "@/lib/accounting/api-scope";
import { projectShadowLedger } from "@/lib/accounting/shadow-projection";
import { addDays, zonedDayStart } from "@/lib/date-range";

const range = z.object({ from: z.iso.date(), to: z.iso.date() }).strict();

export async function POST(request: NextRequest) {
  try {
    const { session, scope } = await accountingScope(request, "accounting.project");
    if (scope.branchId) throw new ApiError(403, "الترحيل التجريبي بيتم على مستوى الكافيه كله");

    const parsed = range.safeParse(await request.json().catch(() => null));
    if (!parsed.success || parsed.data.from > parsed.data.to) {
      throw new ApiError(400, "اختار تاريخ بداية ونهاية صحيحين للترحيل التجريبي");
    }
    const { from, to } = parsed.data;
    const entity = await db.accountingEntity.findUnique({ where: { cafeId: scope.cafeId }, select: { id: true } });
    if (!entity) throw new ApiError(409, "هيّئ دفاتر الكافيه قبل الترحيل التجريبي");

    const report = await projectShadowLedger({
      cafeId: scope.cafeId,
      actorId: session.id,
      from: zonedDayStart(from),
      to: zonedDayStart(addDays(to, 1)),
      openMissingPeriods: true,
    });
    return NextResponse.json(report);
  } catch (error) {
    return handleApiError(error);
  }
}
