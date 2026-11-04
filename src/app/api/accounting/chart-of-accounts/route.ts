import { NextResponse, type NextRequest } from "next/server";
import { handleApiError, resolveReadScope } from "@/lib/api";
import { resolvePermissions } from "@/lib/perms/effective";
import { accountingScope } from "@/lib/accounting/api-scope";
import { chartQuery } from "@/lib/accounting/chart-view";
import { chartOfAccountsView } from "@/lib/accounting/chart-view-queries";

// GET /api/accounting/chart-of-accounts?q= — the whole account hierarchy
// (headers included), searchable by code or name, with the draft expense
// category mapping for readers who may also view expenses. Read-only.
// /api/accounting/accounts keeps serving postable accounts for filters.
export async function GET(request: NextRequest) {
  try {
    const { session, scope } = await accountingScope(request);
    const { q } = chartQuery.parse({ q: request.nextUrl.searchParams.get("q") ?? undefined });
    const { keys } = await resolvePermissions(session);
    return NextResponse.json(await chartOfAccountsView(scope, { q, includeMapping: keys.has("expenses.view"), canSetup: keys.has("accounting.setup") && !resolveReadScope(session).branchId }));
  } catch (error) {
    return handleApiError(error);
  }
}
