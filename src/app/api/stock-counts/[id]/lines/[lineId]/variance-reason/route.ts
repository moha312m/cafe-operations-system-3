import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireKey, requireFeature, resolveCafeId, resolveReadScope, handleApiError } from "@/lib/api";
import { recordHandoverVarianceReason } from "@/lib/handover-variance-reason";

const schema = z.object({ reasonCodeId: z.string().trim().min(1), note: z.string().trim().min(1).max(500).optional() }).strict();
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string; lineId: string }> }) {
  try {
    const actor = await requireKey("stock_count.confirm");
    const scope = resolveReadScope(actor);
    await requireFeature(actor, "inventoryEnabled");
    const { id, lineId } = await params;
    const body = schema.parse(await request.json());
    return NextResponse.json(await recordHandoverVarianceReason({ ...body, sessionId: id, lineId, cafeId: resolveCafeId(actor, request.nextUrl.searchParams.get("cafeId")), viewerBranchId: scope.branchId ?? null, actorId: actor.id }));
  } catch (error) { return handleApiError(error); }
}
