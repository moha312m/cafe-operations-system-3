import { NextResponse, type NextRequest } from "next/server";
import { handleApiError } from "@/lib/api";
import { accountingScope } from "@/lib/accounting/api-scope";
import { accountList } from "@/lib/accounting/queries";

// GET /api/accounting/accounts — postable accounts, for filters.
export async function GET(request: NextRequest) {
  try {
    const { scope } = await accountingScope(request);
    return NextResponse.json({ accounts: await accountList(scope) });
  } catch (error) {
    return handleApiError(error);
  }
}
