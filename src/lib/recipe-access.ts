// Authorisation for recipe configuration.
//
// Editing and confirming a recipe are costing decisions, so they borrow the
// existing menu.manage_recipes capability. Capability rather than job title is
// the point: a café can grant it to a senior barista through a custom role,
// and a one-person café's owner already holds it, so the same design serves a
// single operator and a larger hierarchy without a separate rule for each.
//
// RBAC note for the later phase — this module borrows:
//   menu.manage_recipes → edit, confirm, mark not-applicable, copy to variants
// The intended long-term split is recipes:edit / recipes:verify /
// recipes:view_cost, deliberately NOT introduced here.

import { db } from "@/lib/db";
import { requireKey, ApiError } from "@/lib/api";

export const RECIPE_EDIT_KEY = "menu.manage_recipes";

/** Load a recipe for a write, refusing another tenant's data outright. */
export async function loadRecipeForWrite(id: string) {
  const session = await requireKey(RECIPE_EDIT_KEY);
  const recipe = await db.recipe.findUnique({
    where: { id },
    include: { items: { include: { inventoryItem: true } } },
  });
  if (!recipe) throw new ApiError(404, "الوصفة غير موجودة");
  if (session.role !== "SUPER_ADMIN" && recipe.cafeId !== session.cafeId) {
    throw new ApiError(403, "ليس لديك صلاحية على هذه الوصفة");
  }
  return { session, recipe };
}

/** The café the caller may write to, taken from the session, never the body. */
export async function requireRecipeCafe() {
  const session = await requireKey(RECIPE_EDIT_KEY);
  if (!session.cafeId && session.role !== "SUPER_ADMIN") {
    throw new ApiError(400, "المستخدم غير مرتبط بكافيه");
  }
  return session;
}
