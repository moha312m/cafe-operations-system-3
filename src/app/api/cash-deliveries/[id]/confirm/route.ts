import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { handleApiError, requireActiveSession } from "@/lib/api";
import { confirmCashDelivery } from "@/lib/cash-disposition";

type Params = { params: Promise<{ id: string }> };
// The confirming actor is the session, and only the delivery's named recipient may confirm.
const schema = z.object({ idempotencyKey: z.string({ error: "لازم تبعت مفتاح إعادة المحاولة" }).min(1).max(200) }).strict();

export async function POST(request: NextRequest, { params }: Params) {
  try {
    const session = await requireActiveSession();
    const { id } = await params;
    const body = schema.parse(await request.json());
    return NextResponse.json(await confirmCashDelivery({ declarationId: id, actor: { id: session.id, role: session.role, cafeId: session.cafeId }, idempotencyKey: body.idempotencyKey }));
  } catch (error) {
    return handleApiError(error);
  }
}
