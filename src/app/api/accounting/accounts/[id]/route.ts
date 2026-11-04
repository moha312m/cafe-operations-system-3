import { type NextRequest } from "next/server";
import { handleApiError } from "@/lib/api";
import { accountUpdateInput, setupWrite, updateAccount } from "@/lib/accounting/setup";

type Params = { params: Promise<{ id: string }> };

// PATCH /api/accounting/accounts/[id] — rename, recode, (de)activate or re-parent a
// non-system account (accounting.setup, Idempotency-Key required). Identity that
// posted lines depend on is protected by the database, not only here.
export async function PATCH(request: NextRequest, { params }: Params) {
  try {
    const { id } = await params;
    const body = accountUpdateInput.parse(await request.json());
    return await setupWrite(request, `PATCH /api/accounting/accounts/${id}`, { id, ...body }, 200, (tx, actor, cafeId) => updateAccount(tx, actor, cafeId, id, body));
  } catch (error) {
    return handleApiError(error);
  }
}
