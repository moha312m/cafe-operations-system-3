import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { handleApiError, requireFeature, requireKey, resolveCafeId } from "@/lib/api";
import { resolvePermissions } from "@/lib/perms/effective";
import { acceptDirectHandover, directHandoverSummary } from "@/lib/handover-direct";

type Params = { params: Promise<{ id: string }> };

// `.strict()` and no `incomingUserId`: who is acknowledging comes from the session, and the
// reviewed version is the only evidence the client supplies about what it saw.
const acceptSchema = z
  .object({
    reviewVersion: z.string().min(1, "لازم تبعت نسخة الملخص اللي راجعته").max(200),
    idempotencyKey: z.string({ error: "لازم تبعت مفتاح إعادة المحاولة" }).min(1).max(200),
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
    const result = await acceptDirectHandover({
      handoverId: id, actorId: session.id, cafeId, viewerBranchId: session.branchId,
      reviewVersion: body.reviewVersion, idempotencyKey: body.idempotencyKey,
    });
    return NextResponse.json(result);
  } catch (error) {
    return handleApiError(error);
  }
}
