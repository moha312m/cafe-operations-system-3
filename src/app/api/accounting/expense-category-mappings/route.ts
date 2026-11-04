import { type NextRequest } from "next/server";
import { handleApiError } from "@/lib/api";
import { changeMapping, mappingChangeInput, setupWrite } from "@/lib/accounting/setup";

// POST /api/accounting/expense-category-mappings — save a category→account mapping
// from a date (or end it with accountId null). accounting.setup, Idempotency-Key
// required, reason and accountant approval reference required. Append-only: posted
// entries keep the account they were posted with.
export async function POST(request: NextRequest) {
  try {
    const body = mappingChangeInput.parse(await request.json());
    return await setupWrite(request, "POST /api/accounting/expense-category-mappings", body, 201, (tx, actor, cafeId) => changeMapping(tx, actor, cafeId, body));
  } catch (error) {
    return handleApiError(error);
  }
}
