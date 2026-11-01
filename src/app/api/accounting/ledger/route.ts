import { NextResponse, type NextRequest } from "next/server";
import { ApiError, handleApiError } from "@/lib/api";
import { dateStrInTz } from "@/lib/date-range";
import { accountingScope } from "@/lib/accounting/api-scope";
import { generalLedger, parseDate, SHADOW_NOTICE } from "@/lib/accounting/queries";

// GET /api/accounting/ledger?accountId=&from=&to=&page= — one account's lines
// with opening and running balances; totals cover every page.
export async function GET(request: NextRequest) {
  try {
    const { scope } = await accountingScope(request);
    const params = request.nextUrl.searchParams;
    const accountId = params.get("accountId");
    if (!accountId) throw new ApiError(400, "اختار الحساب");
    const today = dateStrInTz(new Date());
    const page = Math.max(1, Number(params.get("page") ?? 1) || 1);
    return NextResponse.json({ ...(await generalLedger(scope, accountId, parseDate(params.get("from"), `${today.slice(0, 7)}-01`), parseDate(params.get("to"), today), page)), notice: SHADOW_NOTICE });
  } catch (error) {
    return handleApiError(error);
  }
}
