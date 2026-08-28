import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import {
  requireKey,
  requireFeature,
  resolveCafeId,
  handleApiError,
} from "@/lib/api";
import { confirmCountSession } from "@/lib/stock-count";

type Params = { params: Promise<{ id: string }> };

const confirmSchema = z.object({
  // Supplied by the client so a retry after a dropped response is recognised
  // as the same act. Defaulted rather than required, because a caller with no
  // retry story should still be able to confirm — they simply get no
  // protection from their own double-click, which the conditional status
  // update covers anyway.
  idempotencyKey: z.string().min(1).optional(),
});

// POST /api/stock-counts/:id/confirm — the signature that closes the count.
//
// `stock_count.confirm`, which the counting roles do not hold: nobody
// confirms their own count. Refused while any line is unsettled, and the
// refusal names them.
export async function POST(request: NextRequest, { params }: Params) {
  try {
    const session = await requireKey("stock_count.confirm");
    await requireFeature(session, "inventoryEnabled");
    const { id } = await params;
    const cafeId = resolveCafeId(session, request.nextUrl.searchParams.get("cafeId"));

    const body = confirmSchema.parse(await request.json().catch(() => ({})));

    const result = await confirmCountSession({
      sessionId: id,
      confirmedById: session.id,
      idempotencyKey: body.idempotencyKey ?? `${id}:${session.id}:${Date.now()}`,
      cafeId,
      viewerBranchId: session.branchId,
    });
    return NextResponse.json(result);
  } catch (error) {
    return handleApiError(error);
  }
}
