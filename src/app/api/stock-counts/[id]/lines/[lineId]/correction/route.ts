import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import {
  requireKey,
  requireFeature,
  resolveCafeId,
  handleApiError,
} from "@/lib/api";
import { createCountCorrection } from "@/lib/stock-count";

type Params = { params: Promise<{ id: string; lineId: string }> };

const correctionSchema = z.object({
  newCountedQuantity: z
    .number({ message: "الكمية المصححة لازم تكون رقم" })
    .min(0, "الكمية المصححة لازم تكون رقم مش سالب"),
  reasonCodeId: z.string().min(1, "لازم تحدد سبب التصحيح"),
  note: z.string().max(500).optional(),
});

// POST /api/stock-counts/:id/lines/:lineId/correction — propose a different
// figure for a line somebody already counted.
//
// Writes nothing to the line. A proposal is not a decision, and a line that
// moved on proposal would let one person correct a count by asking to.
export async function POST(request: NextRequest, { params }: Params) {
  try {
    const session = await requireKey("stock_count.correct");
    await requireFeature(session, "inventoryEnabled");
    const { id, lineId } = await params;
    const cafeId = resolveCafeId(session, request.nextUrl.searchParams.get("cafeId"));

    const body = correctionSchema.parse(await request.json());

    const result = await createCountCorrection({
      lineId,
      sessionId: id,
      newCountedQuantity: body.newCountedQuantity,
      reasonCodeId: body.reasonCodeId,
      note: body.note,
      actorId: session.id,
      cafeId,
      viewerBranchId: session.branchId,
    });
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    return handleApiError(error);
  }
}
