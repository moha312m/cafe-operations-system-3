import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import {
  requireKey,
  requireFeature,
  resolveCafeId,
  handleApiError,
} from "@/lib/api";
import {
  assertNoClientFigures,
  getCountSessionForViewer,
  recordCountLine,
} from "@/lib/stock-count";

type Params = { params: Promise<{ id: string; lineId: string }> };

const captureSchema = z.object({
  countedQuantity: z
    .number({ message: "الكمية المعدودة لازم تكون رقم" })
    .min(0, "الكمية المعدودة لازم تكون رقم مش سالب"),
});

// PATCH /api/stock-counts/:id/lines/:lineId — record what was on the shelf.
//
// The body carries the physical observation and nothing else. Everything the
// line ends up holding besides that number is computed here, under the
// item's row lock, and a request naming any of it is refused rather than
// obeyed — see `assertNoClientFigures`.
export async function PATCH(request: NextRequest, { params }: Params) {
  try {
    const session = await requireKey("stock_count.submit");
    await requireFeature(session, "inventoryEnabled");
    const { id, lineId } = await params;
    const cafeId = resolveCafeId(session, request.nextUrl.searchParams.get("cafeId"));

    const raw: unknown = await request.json();
    assertNoClientFigures(raw);
    const body = captureSchema.parse(raw);

    await recordCountLine({
      sessionId: id,
      lineId,
      countedQuantity: body.countedQuantity,
      counterId: session.id,
      cafeId,
      viewerBranchId: session.branchId,
    });

    // Read back through the same door every other reader uses, so the
    // capture response is redacted by the one rule rather than by a second
    // copy of it that could drift.
    const found = await getCountSessionForViewer({
      sessionId: id,
      cafeId,
      viewerId: session.id,
      viewerBranchId: session.branchId,
    });
    const line = found.lines.find((l) => l.id === lineId);

    return NextResponse.json({ session: found, line });
  } catch (error) {
    return handleApiError(error);
  }
}
