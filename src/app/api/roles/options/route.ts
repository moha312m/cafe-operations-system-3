import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireKey, resolveCafeId, handleApiError } from "@/lib/api";
import { ensureCafeRoles } from "@/lib/perms/roles";

// GET /api/roles/options — active roles for the staff assignment dropdown.
// Gated by users.view (anyone managing staff can pick a role name).
export async function GET(request: NextRequest) {
  try {
    const session = await requireKey("users.view");
    const cafeId = resolveCafeId(session, request.nextUrl.searchParams.get("cafeId"));
    await ensureCafeRoles(cafeId);
    const roles = await db.cafeRole.findMany({
      where: { cafeId, isActive: true },
      orderBy: [{ isSystemDefault: "desc" }, { name: "asc" }],
      select: { id: true, name: true, isSystemDefault: true },
    });
    return NextResponse.json({ roles });
  } catch (error) {
    return handleApiError(error);
  }
}
