import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import {
  requireKey,
  requireFeature,
  resolveCafeId,
  handleApiError,
} from "@/lib/api";
import { rejectCountCorrection } from "@/lib/stock-count";

type Params = { params: Promise<{ id: string }> };

const rejectSchema = z.object({
  reason: z.string().trim().max(500).optional(),
});

export async function POST(request: NextRequest, { params }: Params) {
  try {
    const session = await requireKey("stock_count.approve_correction");
    await requireFeature(session, "inventoryEnabled");
    const { id } = await params;
    const cafeId = resolveCafeId(session, request.nextUrl.searchParams.get("cafeId"));

    let reason: string | undefined;
    try {
      const body = await request.json();
      const parsed = rejectSchema.safeParse(body);
      if (parsed.success) reason = parsed.data.reason;
    } catch {
      // body optional
    }

    const result = await rejectCountCorrection({
      correctionId: id,
      rejectedById: session.id,
      rejectedReason: reason,
      cafeId,
      viewerBranchId: session.branchId,
    });
    return NextResponse.json(result);
  } catch (error) {
    return handleApiError(error);
  }
}
