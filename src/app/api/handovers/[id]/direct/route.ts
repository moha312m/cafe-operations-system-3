import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { handleApiError, requireFeature, requireKey, resolveCafeId } from "@/lib/api";
import { resolvePermissions } from "@/lib/perms/effective";
import { withIdempotency, requestScope } from "@/lib/idempotency";
import { attemptKey } from "@/lib/attempt-key";
import { acceptDirectHandoverInTransaction, directHandoverSummary } from "@/lib/handover-direct";

type Params = { params: Promise<{ id: string }> };

// `.strict()` and no `incomingUserId`: who is acknowledging comes from the session, and the
// reviewed version is the only evidence the client supplies about what it saw.
const acceptSchema = z
  .object({
    reviewVersion: z.string().min(1, "لازم تبعت نسخة الملخص اللي راجعته").max(200),
    idempotencyKey: z.string().min(1).max(200).optional(),
    cafeId: z.string().optional(),
  })
  .strict();

// GET /api/handovers/:id/direct — the single summary the incoming employee reviews.
export async function GET(request: NextRequest, { params }: Params) {
  try {
    const session = await requireKey("handover.view");
    await requireFeature(session, "inventoryEnabled");
    const { keys } = await resolvePermissions(session);
    const { id } = await params;
    const cafeId = resolveCafeId(session, request.nextUrl.searchParams.get("cafeId"));
    const summary = await directHandoverSummary({ handoverId: id, viewerId: session.id, cafeId, viewerBranchId: session.branchId, keys });
    return NextResponse.json(summary, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return handleApiError(error);
  }
}

// POST /api/handovers/:id/direct — «فتح ورديتي واستلام العهدة». One acknowledgement, one acceptance.
export async function POST(request: NextRequest, { params }: Params) {
  try {
    const session = await requireKey("handover.accept");
    await requireFeature(session, "inventoryEnabled");
    const { id } = await params;
    const body = acceptSchema.parse(await request.json());
    const cafeId = resolveCafeId(session, body.cafeId);
    const key = attemptKey(request, body.idempotencyKey);
    return await withIdempotency(request, requestScope(session, `POST /api/handovers/${id}/direct`), { reviewVersion: body.reviewVersion, cafeId }, async (tx) =>
      NextResponse.json(await acceptDirectHandoverInTransaction(tx, {
        handoverId: id, actorId: session.id, cafeId, viewerBranchId: session.branchId,
        reviewVersion: body.reviewVersion, idempotencyKey: key,
      })));
  } catch (error) {
    return handleApiError(error);
  }
}
