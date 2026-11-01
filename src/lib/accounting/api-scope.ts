// Authenticated scope for the accounting API. The permission key is checked
// server-side, the café comes from the session (SUPER_ADMIN must name one),
// and a branch-assigned reader is always narrowed to their own branch —
// whatever the request asks for.
import type { NextRequest } from "next/server";
import { requireKey, resolveCafeId } from "@/lib/api";
import type { Scope } from "@/lib/accounting/queries";

export async function accountingScope(request: NextRequest, key = "accounting.view") {
  const session = await requireKey(key);
  const cafeId = resolveCafeId(session, request.nextUrl.searchParams.get("cafeId"));
  const scope: Scope = { cafeId, ...(session.branchId ? { branchId: session.branchId } : {}) };
  return { session, scope };
}
