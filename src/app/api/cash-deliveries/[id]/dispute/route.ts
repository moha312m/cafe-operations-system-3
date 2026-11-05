import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { handleApiError, requireActiveSession } from "@/lib/api";
import { disputeCashDelivery } from "@/lib/cash-disposition";

type Params = { params: Promise<{ id: string }> };
const schema = z.object({ note: z.string().min(1, "اكتب وصف الاختلاف").max(1000), claimedReceivedAmount: z.union([z.number(), z.string()]).nullish() }).strict();

export async function POST(request: NextRequest, { params }: Params) {
  try {
    const session = await requireActiveSession();
    const { id } = await params;
    const body = schema.parse(await request.json());
    return NextResponse.json(await disputeCashDelivery({ declarationId: id, actor: { id: session.id, role: session.role, cafeId: session.cafeId }, note: body.note, claimedReceivedAmount: body.claimedReceivedAmount ?? null }));
  } catch (error) {
    return handleApiError(error);
  }
}
