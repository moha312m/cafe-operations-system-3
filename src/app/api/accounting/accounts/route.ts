import { NextResponse, type NextRequest } from "next/server";
import { handleApiError } from "@/lib/api";
import { accountingScope } from "@/lib/accounting/api-scope";
import { accountList } from "@/lib/accounting/queries";
import { accountCreateInput, createAccount, setupWrite } from "@/lib/accounting/setup";

// GET /api/accounting/accounts — postable accounts, for filters.
export async function GET(request: NextRequest) {
  try {
    const { scope } = await accountingScope(request);
    return NextResponse.json({ accounts: await accountList(scope) });
  } catch (error) {
    return handleApiError(error);
  }
}

// POST /api/accounting/accounts — add an account under a header (accounting.setup,
// Idempotency-Key required). Changes the chart only; nothing is posted.
export async function POST(request: NextRequest) {
  try {
    const body = accountCreateInput.parse(await request.json());
    return await setupWrite(request, "POST /api/accounting/accounts", body, 201, (tx, actor, cafeId) => createAccount(tx, actor, cafeId, body));
  } catch (error) {
    return handleApiError(error);
  }
}
