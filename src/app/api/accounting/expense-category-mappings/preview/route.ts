import { NextResponse, type NextRequest } from "next/server";
import { handleApiError } from "@/lib/api";
import { db } from "@/lib/db";
import { mappingPreviewQuery, previewMapping, setupScope } from "@/lib/accounting/setup";

// GET …/preview?categoryId=&effectiveFrom= — what a mapping change on that date would
// touch: expenses on or after it, and how many already have a journal entry. Read-only.
export async function GET(request: NextRequest) {
  try {
    const { cafeId } = await setupScope(request);
    const q = mappingPreviewQuery.parse(Object.fromEntries(["categoryId", "effectiveFrom"].map((k) => [k, request.nextUrl.searchParams.get(k) ?? undefined])));
    return NextResponse.json(await db.$transaction((tx) => previewMapping(tx, cafeId, q)));
  } catch (error) {
    return handleApiError(error);
  }
}
