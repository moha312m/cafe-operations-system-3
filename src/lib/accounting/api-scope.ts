// Authenticated scope for the accounting API. The permission key is checked
// server-side, the café comes from the session (SUPER_ADMIN must name one),
// and a branch-assigned reader is always narrowed to their own branch —
// whatever the request asks for.
import type { NextRequest } from "next/server";
import { ApiError, requireKey, resolveCafeId, resolveReadScope } from "@/lib/api";
import { db } from "@/lib/db";
import type { Scope } from "@/lib/accounting/queries";

export async function accountingScope(request: NextRequest, key = "accounting.view") {
  const session = await requireKey(key);
  const readScope = resolveReadScope(session);
  const cafeId = resolveCafeId(session, request.nextUrl.searchParams.get("cafeId"));
  const requestedBranch = request.nextUrl.searchParams.get("branchId");
  let branchId = readScope.branchId;
  if (!branchId && requestedBranch) {
    if (!await db.branch.findFirst({ where: { id: requestedBranch, cafeId }, select: { id: true } })) throw new ApiError(403, "الفرع خارج نطاق الكافيه");
    branchId = requestedBranch;
  }
  const scope: Scope = { cafeId, ...(branchId ? { branchId } : {}) };
  return { session, scope };
}
