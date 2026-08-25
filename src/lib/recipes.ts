// ── Recipe resolution, validation and the accuracy gate ──────────────
//
// One question runs through this module: for a thing the café actually sold,
// what did it consume, and do we trust that answer well enough to put money
// on it?
//
// Trust is deliberately two-sided. The system can check that a recipe is
// structurally sound — the ingredient exists, the quantity is positive, the
// unit converts, the cost is known. It cannot check that 18 g is really what
// the barista puts in the portafilter. Only a person can say that, so a
// recipe becomes VERIFIED when structural validation passes AND somebody with
// the authority to say so has confirmed it. Either half alone is not enough:
// a sound-looking recipe nobody has confirmed is still a guess, and a
// confirmation over a broken recipe is a rubber stamp.
//
// Who confirms is recorded as a user, never a job title. In a one-person café
// the same person edits and confirms, and that is a legitimate setup rather
// than a control weakness to design around.

import { db } from "@/lib/db";
import {
  convertQuantity, unitsCompatible, round2, round3,
  RecipeIssue, productCostStrict, profitFor,
} from "@/lib/costing";
import type { InventoryUnit, Prisma } from "@prisma/client";
import { createHash } from "node:crypto";

export { RecipeIssue };

export type RecipeSource =
  | "VARIANT" // the size's own recipe
  | "PRODUCT_DEFAULT" // product has no variants
  | "PRODUCT_DEFAULT_ALL_VARIANTS" // default, explicitly declared to cover sizes
  | "NOT_APPLICABLE" // consumes nothing trackable, by decision
  | "NONE"; // nothing usable

type ItemWithStock = Prisma.RecipeItemGetPayload<{ include: { inventoryItem: true } }>;

export type ResolvedRecipe = {
  source: RecipeSource;
  recipeId: string | null;
  items: ItemWithStock[];
  issues: RecipeIssue[];
  /** Set when the recipe carries an operational confirmation that still holds. */
  confirmed: boolean;
  verifiedById: string | null;
  verifiedAt: Date | null;
};

const withItems = {
  items: { include: { inventoryItem: true } },
} satisfies Prisma.RecipeInclude;

/**
 * A stable digest of what a recipe actually says. Confirmation is stored
 * against this, so changing an ingredient, a quantity, a unit or the waste
 * allowance makes the old confirmation stop matching — which is exactly what
 * "this edit invalidates the sign-off" needs, without a version table or a
 * trigger. Sorted so row order can never fake a change.
 */
export function recipeFingerprint(
  items: { inventoryItemId: string; quantity: unknown; unit: string; wastePercentage?: unknown }[],
  scope: { appliesToAllVariants?: boolean } = {}
): string {
  const body = items
    .map((i) => `${i.inventoryItemId}:${Number(i.quantity)}:${i.unit}:${Number(i.wastePercentage ?? 0)}`)
    .sort()
    .join("|");
  return createHash("sha1")
    .update(`${body}#allVariants=${scope.appliesToAllVariants ? 1 : 0}`)
    .digest("hex");
}

/** Structural problems with a set of ingredient lines. */
export function validateItems(items: ItemWithStock[]): RecipeIssue[] {
  const issues = new Set<RecipeIssue>();
  if (items.length === 0) issues.add(RecipeIssue.NO_INGREDIENTS);
  for (const i of items) {
    if (!i.inventoryItem) { issues.add(RecipeIssue.INACTIVE_INGREDIENT); continue; }
    if (!i.inventoryItem.isActive || i.inventoryItem.archivedAt) {
      issues.add(RecipeIssue.INACTIVE_INGREDIENT);
    }
    if (Number(i.quantity) <= 0) issues.add(RecipeIssue.INVALID_QUANTITY);
    if (!unitsCompatible(i.unit, i.inventoryItem.unit)) issues.add(RecipeIssue.INCOMPATIBLE_UNIT);
    if (Number(i.inventoryItem.costPerUnit) <= 0) issues.add(RecipeIssue.MISSING_COST);
  }
  return [...issues];
}

function confirmationHolds(r: {
  verifiedAt: Date | null;
  verifiedFingerprint: string | null;
  appliesToAllVariants: boolean;
  items: ItemWithStock[];
}): boolean {
  if (!r.verifiedAt || !r.verifiedFingerprint) return false;
  return r.verifiedFingerprint === recipeFingerprint(r.items, {
    appliesToAllVariants: r.appliesToAllVariants,
  });
}

/**
 * The recipe that governs one sellable configuration.
 *
 * A product default never stands in for a variant on its own. The old model
 * had no choice but to reuse it, which is how a large latte came to be costed
 * as a small one; here the default only reaches a variant when someone has
 * explicitly declared that the same preparation applies to every size.
 */
export async function resolveEffectiveRecipe(
  productId: string,
  variantId: string | null
): Promise<ResolvedRecipe> {
  const empty = (source: RecipeSource, issues: RecipeIssue[]): ResolvedRecipe => ({
    source, recipeId: null, items: [], issues,
    confirmed: false, verifiedById: null, verifiedAt: null,
  });

  const [variantRecipe, defaultRecipe, variantCount] = await Promise.all([
    variantId
      ? db.recipe.findFirst({ where: { productId, variantId }, include: withItems })
      : Promise.resolve(null),
    db.recipe.findFirst({ where: { productId, variantId: null, addOnId: null }, include: withItems }),
    db.productVariant.count({ where: { productId } }),
  ]);

  const chosen =
    variantRecipe ??
    // Only reachable when the default has been declared to cover sizes, or
    // when the product has no sizes at all.
    (defaultRecipe && (!variantId || defaultRecipe.appliesToAllVariants) ? defaultRecipe : null);

  if (!chosen) {
    // Be specific: "no recipe at all" and "this size was never configured"
    // are different problems with different fixes.
    if (variantId && defaultRecipe) return empty("NONE", [RecipeIssue.MISSING_VARIANT_RECIPE]);
    if (variantId && variantCount > 0) return empty("NONE", [RecipeIssue.MISSING_RECIPE, RecipeIssue.MISSING_VARIANT_RECIPE]);
    return empty("NONE", [RecipeIssue.MISSING_RECIPE]);
  }

  if (chosen.notApplicable) {
    return { ...empty("NOT_APPLICABLE", []), recipeId: chosen.id };
  }

  const source: RecipeSource =
    chosen === variantRecipe
      ? "VARIANT"
      : variantId
        ? "PRODUCT_DEFAULT_ALL_VARIANTS"
        : "PRODUCT_DEFAULT";

  return {
    source,
    recipeId: chosen.id,
    items: chosen.items,
    issues: validateItems(chosen.items),
    confirmed: confirmationHolds(chosen),
    verifiedById: chosen.verifiedById,
    verifiedAt: chosen.verifiedAt,
  };
}

/** The recipe attached to an add-on, if one has been configured. */
export async function resolveAddOnRecipe(addOnId: string): Promise<ResolvedRecipe> {
  const r = await db.recipe.findFirst({ where: { addOnId }, include: withItems });
  if (!r) {
    return {
      source: "NONE", recipeId: null, items: [], issues: [RecipeIssue.MISSING_ADDON_RECIPE],
      confirmed: false, verifiedById: null, verifiedAt: null,
    };
  }
  if (r.notApplicable) {
    return {
      source: "NOT_APPLICABLE", recipeId: r.id, items: [], issues: [],
      confirmed: true, verifiedById: r.verifiedById, verifiedAt: r.verifiedAt,
    };
  }
  return {
    source: "PRODUCT_DEFAULT", recipeId: r.id, items: r.items, issues: validateItems(r.items),
    confirmed: confirmationHolds(r), verifiedById: r.verifiedById, verifiedAt: r.verifiedAt,
  };
}

export type ConsumptionLine = {
  inventoryItemId: string;
  name: string;
  stockUnit: InventoryUnit;
  quantityInStockUnit: number;
  cost: number | null;
};

export type Consumption = {
  lines: ConsumptionLine[];
  /** Every contributing recipe resolved and validated cleanly. */
  complete: boolean;
  cost: number | null;
  issues: RecipeIssue[];
};

/**
 * What one order line theoretically consumes: its base recipe plus whatever
 * its add-ons contribute, scaled by quantity.
 *
 * Base and add-on may name the same ingredient — an extra shot on a latte is
 * more of the same beans — so lines are merged per inventory item after being
 * converted into that item's own storage unit. Merging in the stock unit is
 * what makes it safe: the two sources may express themselves in different but
 * compatible units.
 */
export async function theoreticalConsumption(args: {
  productId: string;
  variantId: string | null;
  addOnIds: string[];
  quantity: number;
}): Promise<Consumption> {
  const base = await resolveEffectiveRecipe(args.productId, args.variantId);
  const addOns = await Promise.all(args.addOnIds.map((id) => resolveAddOnRecipe(id)));

  const issues = new Set<RecipeIssue>([...base.issues]);
  for (const a of addOns) a.issues.forEach((i) => issues.add(i));
  if (base.source === "NONE") issues.add(RecipeIssue.MISSING_RECIPE);

  const merged = new Map<string, ConsumptionLine>();
  const contribute = (items: ItemWithStock[]) => {
    for (const i of items) {
      if (!i.inventoryItem || !unitsCompatible(i.unit, i.inventoryItem.unit)) continue;
      const perUnit = convertQuantity(
        Number(i.quantity) * (1 + Number(i.wastePercentage) / 100),
        i.unit,
        i.inventoryItem.unit
      );
      const qty = round3(perUnit * args.quantity);
      const cur = merged.get(i.inventoryItemId);
      const cost = Number(i.inventoryItem.costPerUnit) > 0
        ? round2(qty * Number(i.inventoryItem.costPerUnit))
        : null;
      if (cur) {
        cur.quantityInStockUnit = round3(cur.quantityInStockUnit + qty);
        cur.cost = cur.cost === null || cost === null ? null : round2(cur.cost + cost);
      } else {
        merged.set(i.inventoryItemId, {
          inventoryItemId: i.inventoryItemId,
          name: i.inventoryItem.name,
          stockUnit: i.inventoryItem.unit,
          quantityInStockUnit: qty,
          cost,
        });
      }
    }
  };
  if (base.source !== "NOT_APPLICABLE") contribute(base.items);
  for (const a of addOns) if (a.source !== "NOT_APPLICABLE") contribute(a.items);

  const lines = [...merged.values()];
  const costable = lines.length > 0 && lines.every((l) => l.cost !== null);
  return {
    lines,
    complete: issues.size === 0,
    cost: costable ? round2(lines.reduce((s, l) => s + (l.cost ?? 0), 0)) : null,
    issues: [...issues],
  };
}

export type GateStatus = "VERIFIED" | "INCOMPLETE" | "NOT_APPLICABLE";

export type GateResult = {
  status: GateStatus;
  source: RecipeSource;
  structurallyValid: boolean;
  confirmed: boolean;
  costAvailable: boolean;
  issues: RecipeIssue[];
  verifiedById: string | null;
  verifiedAt: Date | null;
};

function gateForResolvedRecipe(r: ResolvedRecipe): GateResult {
  if (r.source === "NOT_APPLICABLE") {
    return {
      status: "NOT_APPLICABLE", source: r.source, structurallyValid: true,
      confirmed: true, costAvailable: false, issues: [],
      verifiedById: r.verifiedById, verifiedAt: r.verifiedAt,
    };
  }

  const issues = new Set<RecipeIssue>(r.issues);
  // A missing recipe already has the actionable missing-recipe reason; adding
  // "no ingredients" would only restate the same problem.
  const cost = r.source === "NONE"
    ? ({ ok: false, total: null, issues: [] } as const)
    : productCostStrict(r.items);
  if (!cost.ok) cost.issues.forEach((issue) => issues.add(issue));

  const structurallyValid = r.source !== "NONE" && issues.size === 0;
  if (structurallyValid && !r.confirmed) {
    issues.add(r.verifiedAt ? RecipeIssue.STALE_CONFIRMATION : RecipeIssue.NOT_CONFIRMED);
  }
  return {
    status: structurallyValid && r.confirmed ? "VERIFIED" : "INCOMPLETE",
    source: r.source, structurallyValid, confirmed: r.confirmed,
    costAvailable: cost.ok, issues: [...issues],
    verifiedById: r.verifiedById, verifiedAt: r.verifiedAt,
  };
}

export type ConfigurationFinancials = {
  costStatus: "AVAILABLE" | "RECIPE_INCOMPLETE" | "NOT_APPLICABLE";
  recipeSource: RecipeSource;
  issues: RecipeIssue[];
  cost: number | null;
  profit: number | null;
  margin: number | null;
  tier: ReturnType<typeof profitFor>["tier"] | null;
};

/**
 * Honest cost/profit for one thing a customer can actually buy.
 *
 * Financial screens must not use a product-default estimate as though it
 * described a size. Resolution and trust therefore come from the same gate
 * used by inventory/variance work. If the exact configuration is incomplete,
 * the absence of a number is deliberate: a made-up margin is worse than no
 * margin.
 */
export async function configurationFinancials(args: {
  productId: string;
  variantId: string | null;
  sellingPrice: number;
}): Promise<ConfigurationFinancials> {
  const resolved = await resolveEffectiveRecipe(args.productId, args.variantId);
  const gate = gateForResolvedRecipe(resolved);

  if (gate.status === "NOT_APPLICABLE") {
    return {
      costStatus: "NOT_APPLICABLE", recipeSource: resolved.source,
      issues: gate.issues, cost: null, profit: null, margin: null, tier: null,
    };
  }
  if (gate.status !== "VERIFIED") {
    return {
      costStatus: "RECIPE_INCOMPLETE", recipeSource: resolved.source,
      issues: gate.issues, cost: null, profit: null, margin: null, tier: null,
    };
  }

  const strict = productCostStrict(resolved.items);
  if (!strict.ok) {
    return {
      costStatus: "RECIPE_INCOMPLETE", recipeSource: resolved.source,
      issues: strict.issues, cost: null, profit: null, margin: null, tier: null,
    };
  }
  const profitability = profitFor(args.sellingPrice, strict.total, true);
  return {
    costStatus: "AVAILABLE", recipeSource: resolved.source, issues: [],
    cost: profitability.cost, profit: profitability.profit,
    margin: profitability.margin, tier: profitability.tier,
  };
}

/** The gate for one sellable configuration, ignoring add-ons. */
export async function sellableGate(
  productId: string,
  variantId: string | null
): Promise<GateResult> {
  const r = await resolveEffectiveRecipe(productId, variantId);
  return gateForResolvedRecipe(r);
}

/**
 * Whether the exact configuration that was sold may later carry money charged
 * against a person.
 *
 * It must be VERIFIED, and every add-on that was actually chosen must be
 * verified too: a verified latte with an unmapped vanilla shot has an
 * incomplete theoretical consumption, and a variance computed from it would
 * bill the barista for syrup the system never expected them to pour.
 *
 * NOT_APPLICABLE is deliberately not eligible. It means "there is nothing to
 * measure here", which is not the same as "measured and found correct".
 */
export async function isEligibleForVarianceCosting(args: {
  productId: string;
  variantId: string | null;
  addOnIds?: string[];
}): Promise<{ eligible: boolean; issues: RecipeIssue[] }> {
  const gate = await sellableGate(args.productId, args.variantId);
  const issues = new Set<RecipeIssue>(gate.issues);
  if (gate.status !== "VERIFIED") {
    return { eligible: false, issues: [...issues] };
  }
  for (const id of args.addOnIds ?? []) {
    const a = await resolveAddOnRecipe(id);
    if (a.source === "NOT_APPLICABLE") continue;
    if (a.source === "NONE") { issues.add(RecipeIssue.MISSING_ADDON_RECIPE); continue; }
    a.issues.forEach((i) => issues.add(i));
    if (!a.confirmed) issues.add(RecipeIssue.NOT_CONFIRMED);
  }
  return { eligible: issues.size === 0, issues: [...issues] };
}
