import { NextResponse, type NextRequest } from "next/server";
import { handleApiError } from "@/lib/api";
import { accountingScope } from "@/lib/accounting/api-scope";
import { accountingOverview } from "@/lib/accounting/queries";

// GET /api/accounting/overview — books, periods, projection health and the
// current period's checklist. Never creates books.
export async function GET(request: NextRequest) {
  try {
    const { scope } = await accountingScope(request);
    return NextResponse.json(await accountingOverview(scope));
  } catch (error) {
    return handleApiError(error);
  }
}
