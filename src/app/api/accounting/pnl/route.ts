import { NextResponse, type NextRequest } from "next/server";
import { handleApiError } from "@/lib/api";
import { accountingScope } from "@/lib/accounting/api-scope";
import { dateStrInTz } from "@/lib/date-range";
import { getExecutivePnl } from "@/lib/accounting/pnl";
import { ensureAccountingEntity } from "@/lib/accounting/chart";
import { setupScope } from "@/lib/accounting/setup";
import { db } from "@/lib/db";

export async function GET(request: NextRequest) {
  try {
    const { scope } = await accountingScope(request);
    const searchParams = request.nextUrl.searchParams;

    const today = dateStrInTz(new Date());
    const from = searchParams.get("from") || `${today.slice(0, 7)}-01`;
    const to = searchParams.get("to") || today;
    const compareFrom = searchParams.get("compareFrom") || undefined;
    const compareTo = searchParams.get("compareTo") || undefined;

    const pnl = await getExecutivePnl({
      cafeId: scope.cafeId,
      from,
      to,
      branchId: scope.branchId,
      compareFrom,
      compareTo,
    });

    return NextResponse.json(pnl);
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const { cafeId } = await setupScope(request);
    const entity = await db.$transaction((tx) => ensureAccountingEntity(tx, cafeId));
    return NextResponse.json({
      success: true,
      entityId: entity.id,
      name: entity.name,
      currency: entity.currency,
    });
  } catch (error) {
    return handleApiError(error);
  }
}
