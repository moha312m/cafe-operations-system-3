import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { handleApiError, requireActiveSession } from "@/lib/api";
import { withIdempotency, requestScope } from "@/lib/idempotency";
import { attemptKey } from "@/lib/attempt-key";
import { confirmCashDeliveryInTransaction } from "@/lib/cash-disposition";

type Params = { params: Promise<{ id: string }> };
// The confirming actor is the session. Only the named recipient confirms as themselves; the café owner
// may confirm «نيابةً عن المستلم» with a written `onBehalfReason`, recorded as that distinct exception.
const schema = z.object({ idempotencyKey: z.string().min(1).max(200).optional(), onBehalfReason: z.string().max(1000).nullish() }).strict();

export async function POST(request: NextRequest, { params }: Params) {
  try {
    const session = await requireActiveSession();
    const { id } = await params;
    const body = schema.parse(await request.json());
    const key = attemptKey(request, body.idempotencyKey);
    return await withIdempotency(request, requestScope(session, `POST /api/cash-deliveries/${id}/confirm`), { onBehalfReason: body.onBehalfReason ?? null }, async (tx) =>
      NextResponse.json(await confirmCashDeliveryInTransaction(tx, { declarationId: id, actor: { id: session.id, role: session.role, cafeId: session.cafeId }, idempotencyKey: key, onBehalfReason: body.onBehalfReason ?? null })));
  } catch (error) {
    return handleApiError(error);
  }
}
