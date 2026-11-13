import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { ApiError, handleApiError, requireActiveSession, requireFeature, resolveCafeId } from "@/lib/api";
import { resolvePermissions } from "@/lib/perms/effective";
import { withIdempotency, requestScope } from "@/lib/idempotency";
import { attemptKey } from "@/lib/attempt-key";
import { addReviewNote, CLASSIFICATIONS, mayReadStockHandoverReports, REVIEW_STATUSES, stockHandoverReportDetail } from "@/lib/stock-handover-review";

type Params = { params: Promise<{ handoverId: string }> };

const noteSchema = z.object({
  text: z.string().min(1, "اكتب ملاحظة المراجعة").max(2000),
  status: z.enum(REVIEW_STATUSES as [string, ...string[]]).nullish(),
  classification: z.enum(CLASSIFICATIONS as [string, ...string[]]).nullish(),
  cafeId: z.string().optional(),
}).strict();

// GET /api/stock-handover-reports/:handoverId — side by side, movements, history, review trail.
export async function GET(request: NextRequest, { params }: Params) {
  try {
    const session = await requireActiveSession();
    const { keys } = await resolvePermissions(session);
    if (!mayReadStockHandoverReports(keys)) throw new ApiError(403, "ليس لديك صلاحية");
    await requireFeature(session, "inventoryEnabled");
    const { handoverId } = await params;
    const cafeId = resolveCafeId(session, request.nextUrl.searchParams.get("cafeId"));
    const canAdjust = keys.has("handover.manage") && keys.has("inventory.transactions");
    const detail = await stockHandoverReportDetail(db, { cafeId, viewerBranchId: session.branchId, handoverId, canAdjust });
    return NextResponse.json({ ...detail, can: { review: keys.has("handover.manage"), adjust: canAdjust } });
  } catch (error) {
    return handleApiError(error);
  }
}

// POST /api/stock-handover-reports/:handoverId — append a review note (and move status / classification).
export async function POST(request: NextRequest, { params }: Params) {
  try {
    const session = await requireActiveSession();
    const { keys } = await resolvePermissions(session);
    if (!keys.has("handover.manage")) throw new ApiError(403, "المراجعة للمدير أو المالك");
    await requireFeature(session, "inventoryEnabled");
    const { handoverId } = await params;
    const body = noteSchema.parse(await request.json());
    const cafeId = resolveCafeId(session, body.cafeId);
    const key = attemptKey(request);
    return await withIdempotency(request, requestScope(session, `POST /api/stock-handover-reports/${handoverId}`), body, async (tx) => {
      const result = await addReviewNote(tx, {
        cafeId, viewerBranchId: session.branchId, handoverId, actorId: session.id, text: body.text,
        status: (body.status as never) ?? null, classification: (body.classification as never) ?? null, idempotencyKey: key,
      });
      return NextResponse.json({
        status: result.review.status, classification: result.review.classification, noteId: result.note.id, replayed: result.replayed,
      }, { status: result.replayed ? 200 : 201 });
    });
  } catch (error) {
    return handleApiError(error);
  }
}
