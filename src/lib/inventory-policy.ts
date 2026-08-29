// The café's inventory & recipe enforcement policy: where it is read from,
// what each mode means, and how it is described to a person.
//
// One authoritative source. `CafeSettings.inventoryEnforcementMode` replaced
// `Cafe.allowNegativeStock`, which could only answer "may stock go below
// zero". Three behaviours are needed, and the distinction a boolean could not
// express is the one that matters:
//
//   going below a balance we CAN compute   is a known, priced risk
//   selling against a recipe nobody wrote  is an unknown draw on the shelf
//
// An owner may reasonably accept the first without the second, which is why
// ALLOW_NEGATIVE_STOCK sits between STRICT and OVERRIDE_ALL rather than being
// a synonym for either.

import { db } from "@/lib/db";
import type { InventoryEnforcementMode } from "@prisma/client";

export type { InventoryEnforcementMode };

export const INVENTORY_ENFORCEMENT_MODES = [
  "STRICT",
  "ALLOW_NEGATIVE_STOCK",
  "OVERRIDE_ALL",
] as const;

/** The safe end of the range, and what a café with no opinion gets. */
export const DEFAULT_ENFORCEMENT_MODE: InventoryEnforcementMode = "STRICT";

export const ENFORCEMENT_MODE_LABEL: Record<InventoryEnforcementMode, string> = {
  STRICT: "صارم",
  ALLOW_NEGATIVE_STOCK: "السماح بالرصيد السالب",
  OVERRIDE_ALL: "تجاوز كامل",
};

export const ENFORCEMENT_MODE_DESCRIPTION: Record<InventoryEnforcementMode, string> = {
  STRICT: "منع البيع عند نقص المخزون أو عدم اكتمال الوصفة",
  ALLOW_NEGATIVE_STOCK:
    "السماح بالبيع عند نقص المخزون وتسجيل رصيد سالب، مع اشتراط اكتمال الوصفة",
  OVERRIDE_ALL:
    "السماح بالبيع حتى مع نقص المخزون أو عدم اكتمال الوصفة، مع تسجيل تحذير ومراجعة",
};

/** Shown when OVERRIDE_ALL is being selected, before it is saved. */
export const OVERRIDE_ALL_WARNING =
  "تحذير: في الوضع ده الطلب هيعدي حتى لو الوصفة ناقصة، وساعتها استهلاك " +
  "المخزون هيبقى غير مكتمل — الأصناف اللي مش متعرّفة مش هتتخصم، وهتظهر في " +
  "المراجعة. الفرق بينها وبين الجرد الفعلي مش هيكون معناه عجز.";

/** The warning the POS shows when a sale passed only because policy allowed it. */
export const OVERRIDE_SALE_WARNING =
  "تم السماح بالبيع حسب سياسة المنشأة رغم عدم اكتمال بيانات المخزون أو الوصفة.";

/**
 * The café's policy, read from the database and never from the request.
 *
 * A café with no settings row has expressed no opinion, so it gets STRICT
 * rather than inheriting something permissive by accident — the same reading
 * the serving-policy route applies to its own absent row.
 */
export async function getInventoryEnforcementMode(
  cafeId: string
): Promise<InventoryEnforcementMode> {
  const settings = await db.cafeSettings.findUnique({
    where: { cafeId },
    select: { inventoryEnforcementMode: true },
  });
  return settings?.inventoryEnforcementMode ?? DEFAULT_ENFORCEMENT_MODE;
}

/** Whether a KNOWN quantity shortage may pass. */
export function allowsKnownShortage(mode: InventoryEnforcementMode): boolean {
  return mode !== "STRICT";
}

/**
 * Whether an UNKNOWN consumption may pass — a recipe that does not resolve, or
 * an ingredient this branch does not stock at all.
 *
 * Deliberately not the same question as the one above. This is the line
 * OVERRIDE_ALL exists to cross, and the reason it needs its own mode.
 */
export function allowsUnknownConsumption(mode: InventoryEnforcementMode): boolean {
  return mode === "OVERRIDE_ALL";
}
