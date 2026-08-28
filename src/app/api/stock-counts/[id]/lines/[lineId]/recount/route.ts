import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import {
  requireKey,
  requireFeature,
  resolveCafeId,
  handleApiError,
} from "@/lib/api";
import { assertNoClientFigures } from "@/lib/stock-count";
import { recordRecount } from "@/lib/recount";

type Params = { params: Promise<{ id: string; lineId: string }> };

const recountSchema = z.object({
  countedQuantity: z
    .number({ message: "الكمية المعدودة لازم تكون رقم" })
    .min(0, "الكمية المعدودة لازم تكون رقم مش سالب"),
});

// POST /api/stock-counts/:id/lines/:lineId/recount — count a contested shelf
// again, at its own count point.
//
// `stock_count.recount`, not `stock_count.submit`: recounting is a store
// keeper's judgement about somebody else's figure, and it is deliberately a
// different key from the one that records the first count.
export async function POST(request: NextRequest, { params }: Params) {
  try {
    const session = await requireKey("stock_count.recount");
    await requireFeature(session, "inventoryEnabled");
    const { id, lineId } = await params;
    const cafeId = resolveCafeId(session, request.nextUrl.searchParams.get("cafeId"));

    const raw: unknown = await request.json();
    assertNoClientFigures(raw);
    const body = recountSchema.parse(raw);

    const result = await recordRecount({
      lineId,
      sessionId: id,
      countedQuantity: body.countedQuantity,
      recounterId: session.id,
      cafeId,
      viewerBranchId: session.branchId,
    });

    return NextResponse.json(result);
  } catch (error) {
    return handleApiError(error);
  }
}
