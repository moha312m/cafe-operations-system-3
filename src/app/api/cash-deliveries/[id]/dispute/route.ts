import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { handleApiError, requireActiveSession } from "@/lib/api";
import { withIdempotency, requestScope } from "@/lib/idempotency";
import { attemptKey } from "@/lib/attempt-key";
import { disputeCashDeliveryInTransaction } from "@/lib/cash-disposition";

type Params = { params: Promise<{ id: string }> };
const schema = z.object({ note: z.string().min(1, "اكتب وصف الاختلاف").max(1000), claimedReceivedAmount: z.union([z.number(), z.string()]).nullish() }).strict();

export async function POST(request: NextRequest, { params }: Params) {
  try {
    const session = await requireActiveSession();
    const { id } = await params;
    const body = schema.parse(await request.json());
    attemptKey(request);
    return await withIdempotency(request, requestScope(session, `POST /api/cash-deliveries/${id}/dispute`), body, async (tx) =>
      NextResponse.json(await disputeCashDeliveryInTransaction(tx, { declarationId: id, actor: { id: session.id, role: session.role, cafeId: session.cafeId }, note: body.note, claimedReceivedAmount: body.claimedReceivedAmount ?? null })));
  } catch (error) {
    return handleApiError(error);
  }
}
