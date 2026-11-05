import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { handleApiError, requireKey, resolveCafeId } from "@/lib/api";
import { withIdempotency, requestScope } from "@/lib/idempotency";
import { attemptKey } from "@/lib/attempt-key";
import { resolveHandoverIssueInTransaction } from "@/lib/handover-direct";

type Params = { params: Promise<{ id: string }> };
const schema = z.object({ note: z.string().min(1, "اكتب نتيجة المراجعة").max(1000), cafeId: z.string().optional() }).strict();

// POST /api/handover-issues/:id/resolve — a manager closes a reported issue with a recorded outcome.
export async function POST(request: NextRequest, { params }: Params) {
  try {
    const session = await requireKey("handover.manage");
    const { id } = await params;
    const body = schema.parse(await request.json());
    const cafeId = resolveCafeId(session, body.cafeId);
    attemptKey(request);
    return await withIdempotency(request, requestScope(session, `POST /api/handover-issues/${id}/resolve`), body, async (tx) =>
      NextResponse.json(await resolveHandoverIssueInTransaction(tx, { issueId: id, actorId: session.id, cafeId, note: body.note })));
  } catch (error) {
    return handleApiError(error);
  }
}
