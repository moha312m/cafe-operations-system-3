import { NextRequest, NextResponse } from "next/server";
import { requireActiveSession, requireKey, handleApiError, ApiError } from "@/lib/api";
import { savePlacePhoto } from "@/lib/place-media";
import { db } from "@/lib/db";

export async function POST(request: NextRequest) {
  try {
    const actor = await requireActiveSession();
    await requireKey("handover.view");
    if (!actor.cafeId) throw new ApiError(403, "Cafe required");
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) throw new ApiError(400, "Photo file is required");
    if (file.size > 5 * 1024 * 1024) throw new ApiError(400, "Photo must be 5 MiB or smaller");
    const assetId = form.get("assetId"), observationId = form.get("observationId");
    if ((assetId !== null && typeof assetId !== "string") || (observationId !== null && typeof observationId !== "string")) throw new ApiError(400, "Invalid photo target");
    const targetId = typeof assetId === "string" ? assetId : typeof observationId === "string" ? observationId : null;
    if (!targetId) throw new ApiError(400, "Choose a photo target");
    const target = typeof assetId === "string"
      ? await db.placeAsset.findFirst({ where: { id: assetId, cafeId: actor.cafeId, ...(actor.branchId ? { branchId: actor.branchId } : {}), isActive: true }, select: { branchId: true } })
      : await db.placeObservation.findFirst({ where: { id: observationId as string, receipt: { cafeId: actor.cafeId, ...(actor.branchId ? { branchId: actor.branchId } : {}) } }, select: { receipt: { select: { branchId: true } } } }).then((x) => x ? { branchId: x.receipt.branchId } : null);
    if (!target) throw new ApiError(400, "Photo target is outside your authorized branch");
    const result = await savePlacePhoto({ cafeId: actor.cafeId, branchId: target.branchId, actorId: actor.id, assetId: typeof assetId === "string" ? assetId : undefined, observationId: typeof observationId === "string" ? observationId : undefined, input: Buffer.from(await file.arrayBuffer()) });
    return NextResponse.json(result, { status: 201 });
  } catch (error) { return handleApiError(error); }
}

