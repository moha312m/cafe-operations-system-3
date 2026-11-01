import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireKey, handleApiError } from "@/lib/api";
import { executeApprovedAction } from "@/lib/approved-order-actions";

type Params = { params: Promise<{ id: string }> };
const bodySchema = z.object({ idempotencyKey: z.string().min(8).max(64) }).strict();

export async function POST(request: NextRequest, { params }: Params) {
  try {
    const actor = await requireKey("orders.request_owner_action");
    const { id } = await params;
    const { idempotencyKey } = bodySchema.parse(await request.json());
    return NextResponse.json(await executeApprovedAction({ actor, requestId: id, idempotencyKey }));
  } catch (error) { return handleApiError(error); }
}