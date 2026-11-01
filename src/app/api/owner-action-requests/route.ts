import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireKey, handleApiError } from "@/lib/api";
import { listOwnerActionRequests, requestOwnerAction } from "@/lib/owner-action-approvals";

const bodySchema = z.object({
  action: z.enum(["CANCEL_ORDER", "VOID_ORDER_ITEM", "REFUND_ORDER", "REFUND_PAYMENT"]),
  orderId: z.string().min(1).optional(), orderItemId: z.string().min(1).optional(), paymentId: z.string().min(1).optional(),
  reason: z.string().trim().min(3).max(500), idempotencyKey: z.string().min(16).max(64),
}).strict();

export async function GET(request: NextRequest) {
  try {
    const actor = await requireKey("orders.request_owner_action");
    const result = await listOwnerActionRequests({ actor, branchId: request.nextUrl.searchParams.get("branchId") });
    return NextResponse.json(result);
  } catch (error) { return handleApiError(error); }
}

export async function POST(request: NextRequest) {
  try {
    const actor = await requireKey("orders.request_owner_action");
    const data = bodySchema.parse(await request.json());
    const result = await requestOwnerAction({ actor, ...data });
    return NextResponse.json({ request: { id: result.requestId, status: result.status, amount: result.amount } }, { status: 201 });
  } catch (error) { return handleApiError(error); }
}
