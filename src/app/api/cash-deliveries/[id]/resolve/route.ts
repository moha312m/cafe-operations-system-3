import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { handleApiError, requireActiveSession } from "@/lib/api";
import { withIdempotency, requestScope } from "@/lib/idempotency";
import { attemptKey } from "@/lib/attempt-key";
import { resolveCashDeliveryDisputeInTransaction } from "@/lib/cash-disposition";

type Params = { params: Promise<{ id: string }> };
const schema = z.object({ resolutionNote: z.string().min(1, "اكتب نتيجة المراجعة").max(1000), resolvedAmount: z.union([z.number(), z.string()]) }).strict();

// Café owner only (enforced in the service against the live account, not the cookie).
export async function POST(request: NextRequest, { params }: Params) {
  try {
    const session = await requireActiveSession();
    const { id } = await params;
    const body = schema.parse(await request.json());
    attemptKey(request);
    return await withIdempotency(request, requestScope(session, `POST /api/cash-deliveries/${id}/resolve`), body, async (tx) =>
      NextResponse.json(await resolveCashDeliveryDisputeInTransaction(tx, { declarationId: id, actor: { id: session.id, role: session.role, cafeId: session.cafeId }, resolutionNote: body.resolutionNote, resolvedAmount: body.resolvedAmount })));
  } catch (error) {
    return handleApiError(error);
  }
}
