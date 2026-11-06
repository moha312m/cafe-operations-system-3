import { NextResponse, type NextRequest } from "next/server";
import { requireActiveSession, requireKey, handleApiError, ApiError } from "@/lib/api";
import { changeCafeCurrency, getCurrencyState } from "@/lib/branch-currency";
import { db } from "@/lib/db";

type Params = { params: Promise<{ id: string }> };

async function ownBranch(cafeId: string | null, id: string) {
  const branch = cafeId ? await db.branch.findFirst({ where: { id, cafeId }, select: { id: true } }) : null;
  if (!branch) throw new ApiError(404, "الفرع مش موجود");
}

// Reading the currency state needs the settings view key; a branch-pinned user only sees their own branch.
export async function GET(_request: NextRequest, { params }: Params) {
  try {
    const { id } = await params;
    const actor = await requireKey("settings.view");
    await ownBranch(actor.cafeId, id);
    if (actor.branchId && actor.branchId !== id) throw new ApiError(404, "الفرع مش موجود");
    return NextResponse.json(await getCurrencyState(actor));
  } catch (error) {
    return handleApiError(error);
  }
}

// Owner only (settings.edit + the CAFE_OWNER role, re-checked inside the transaction), audited, idempotent.
export async function PATCH(request: NextRequest, { params }: Params) {
  try {
    const { id } = await params;
    const actor = await requireKey("settings.edit");
    if (actor.role !== "CAFE_OWNER") throw new ApiError(403, "تغيير العملة للمالك فقط");
    await ownBranch(actor.cafeId, id);
    return await changeCafeCurrency(request, actor, id, await request.json());
  } catch (error) {
    return handleApiError(error);
  }
}
