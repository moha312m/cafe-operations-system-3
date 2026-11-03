import { NextResponse, type NextRequest } from "next/server";
import { handleApiError } from "@/lib/api";
import { accountingScope } from "@/lib/accounting/api-scope";
import { journalEntryDetail, SHADOW_NOTICE } from "@/lib/accounting/queries";

type Params = { params: Promise<{ id: string }> };

// GET /api/accounting/journal/[id] — one entry, its lines, reversal links and
// the operational record behind it.
export async function GET(request: NextRequest, { params }: Params) {
  try {
    const { scope } = await accountingScope(request);
    const { id } = await params;
    return NextResponse.json({ ...(await journalEntryDetail(scope, id)), notice: SHADOW_NOTICE });
  } catch (error) {
    return handleApiError(error);
  }
}
