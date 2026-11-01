import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireKey, handleApiError } from "@/lib/api";
import { decideOwnerAction } from "@/lib/owner-action-approvals";

type Params = { params: Promise<{ id: string }> };
const bodySchema = z.object({ decision: z.enum(["ACCEPT", "REJECT"]), note: z.string().trim().max(500).optional() }).strict();

export async function POST(request: NextRequest, { params }: Params) {
  try {
    const actor = await requireKey("orders.request_owner_action");
    const { id } = await params;
    const data = bodySchema.parse(await request.json());
    const result = await decideOwnerAction({ actor, requestId: id, ...data });
    return NextResponse.json(result);
  } catch (error) { return handleApiError(error); }
}
