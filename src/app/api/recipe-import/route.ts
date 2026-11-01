import { NextResponse, type NextRequest } from "next/server";
import { handleApiError, resolveCafeId } from "@/lib/api";
import { requireRecipeCafe } from "@/lib/recipe-access";
import { importRecipes, recipeImportSchema } from "@/lib/recipe-import";
export async function POST(request: NextRequest) {
  try {
    const session = await requireRecipeCafe();
    const input = recipeImportSchema.parse(await request.json());
    const cafeId = resolveCafeId(session, input.cafeId);
    return NextResponse.json(await importRecipes(cafeId, session.id, input));
  } catch (error) { return handleApiError(error); }
}
