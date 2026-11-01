import { NextResponse, type NextRequest } from "next/server";
import { handleApiError } from "@/lib/api";
import { dateStrInTz } from "@/lib/date-range";
import { accountingScope } from "@/lib/accounting/api-scope";
import { journalList, parseDate, SHADOW_NOTICE } from "@/lib/accounting/queries";

// GET /api/accounting/journal?from=&to=&sourceType=&page= — journal entries.
export async function GET(request: NextRequest) {
  try {
    const { scope } = await accountingScope(request);
    const params = request.nextUrl.searchParams;
    const today = dateStrInTz(new Date());
    const page = Math.max(1, Number(params.get("page") ?? 1) || 1);
    return NextResponse.json({ ...(await journalList(scope, { from: parseDate(params.get("from"), `${today.slice(0, 7)}-01`), to: parseDate(params.get("to"), today), sourceType: params.get("sourceType"), page })), notice: SHADOW_NOTICE });
  } catch (error) {
    return handleApiError(error);
  }
}
