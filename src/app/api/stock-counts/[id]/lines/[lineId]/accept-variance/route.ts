import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import {
  requireKey,
  requireFeature,
  resolveCafeId,
  handleApiError,
} from "@/lib/api";
import { acceptLineVariance } from "@/lib/recount";

type Params = { params: Promise<{ id: string; lineId: string }> };

const acceptSchema = z.object({
  reasonCodeId: z.string().min(1, "لازم تحدد سبب الفرق قبل ما تعتمده"),
  note: z.string().max(500).optional(),
});

// POST /api/stock-counts/:id/lines/:lineId/accept-variance — say the
// difference is real, and close the line.
//
// `stock_count.confirm`, which the counting roles do not hold: the person who
// counted the room must not be able to wave their own variance through. A
// reason code is required for the same reason a shift close requires one — a
// difference accepted for no stated reason is a difference nobody can review.
export async function POST(request: NextRequest, { params }: Params) {
  try {
    const session = await requireKey("stock_count.confirm");
    await requireFeature(session, "inventoryEnabled");
    const { id, lineId } = await params;
    const cafeId = resolveCafeId(session, request.nextUrl.searchParams.get("cafeId"));

    const body = acceptSchema.parse(await request.json());

    const result = await acceptLineVariance({
      lineId,
      sessionId: id,
      actorId: session.id,
      reasonCodeId: body.reasonCodeId,
      note: body.note,
      cafeId,
      viewerBranchId: session.branchId,
    });

    return NextResponse.json(result);
  } catch (error) {
    return handleApiError(error);
  }
}
