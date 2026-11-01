import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireKey, handleApiError } from "@/lib/api";
import { authorizeOwnerActionByPasscode } from "@/lib/owner-passcode";

type Params = { params: Promise<{ id: string }> };
const bodySchema = z.object({ passcode: z.string().regex(/^\d{6,12}$/) }).strict();

export async function POST(request: NextRequest, { params }: Params) {
  try {
    const actor = await requireKey("orders.request_owner_action");
    const { id } = await params;
    const { passcode } = bodySchema.parse(await request.json());
    const result = await authorizeOwnerActionByPasscode({ actor, requestId: id, passcode });
    return NextResponse.json(result);
  } catch (error) { return handleApiError(error); }
}