import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { handleApiError, requireKey } from "@/lib/api";
import { requestOwnerAction } from "@/lib/owner-action-approvals";

type Params = { params: Promise<{ id: string }> };
const bodySchema = z.object({
  reason: z.string().trim().min(3, "Write a short reason for the request").max(500),
}).strict();

export async function POST(request: NextRequest, { params }: Params) {
  try {
    const actor = await requireKey("orders.request_owner_action");
    const { id } = await params;
    const { reason } = bodySchema.parse(await request.json());
    const result = await requestOwnerAction({
      actor, action: "REFUND_ORDER", orderId: id, reason, idempotencyKey: crypto.randomUUID(),
    });
    return NextResponse.json({ request: { id: result.requestId, status: result.status, amount: result.amount } }, { status: 202 });
  } catch (error) { return handleApiError(error); }
}