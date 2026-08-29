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
import type { InventoryUnit, Prisma, PrismaClient } from "@prisma/client";
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

/** A recipe row loaded with everything resolution needs in order to read it. */
export type LoadedRecipe = Prisma.RecipeGetPayload<{ include: typeof withItems }>;

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
  variantId: string | null,
  // Reads inside somebody's transaction must go through THAT transaction.
  // Reaching for the global client from inside `db.$transaction` takes a
  // second connection out of the same pool while the first is held, which
  // under concurrency exhausts the pool and leaves every request waiting on a
  // connection that only another waiting request can release. It also reads a
  // different snapshot than the transaction is working from.
  client: Prisma.TransactionClient | PrismaClient = db
): Promise<ResolvedRecipe> {
  const [variantRecipe, defaultRecipe, variantCount] = await Promise.all([
    variantId
      ? client.recipe.findFirst({ where: { productId, variantId }, include: withItems })
      : Promise.resolve(null),
    client.recipe.findFirst({ where: { productId, variantId: null, addOnId: null }, include: withItems }),
    client.productVariant.count({ where: { productId } }),
  ]);

  return chooseEffectiveRecipe({ variantId, variantRecipe, defaultRecipe, variantCount });
}

/**
 * The resolution rules themselves, over rows somebody has already loaded.
 *
 * Split out from the query so a screen that needs FIFTY configurations can
 * load the café's recipes once and apply the identical rules in memory. The
 * POS availability board is that screen: a per-configuration query would be
 * forty round trips before the cashier's first tap, and a second copy of
 * these rules written to avoid them is how the board and the till come to
 * disagree about what a large latte draws.
 */
export function chooseEffectiveRecipe(args: {
  variantId: string | null;
  variantRecipe: LoadedRecipe | null;
  defaultRecipe: LoadedRecipe | null;
  variantCount: number;
}): ResolvedRecipe {
  const { variantId, variantRecipe, defaultRecipe, variantCount } = args;
  const empty = (source: RecipeSource, issues: RecipeIssue[]): ResolvedRecipe => ({
    source, recipeId: null, items: [], issues,
    confirmed: false, verifiedById: null, verifiedAt: null,
  });

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
export async function resolveAddOnRecipe(
  addOnId: string,
  client: Prisma.TransactionClient | PrismaClient = db
): Promise<ResolvedRecipe> {
  return readAddOnRecipe(await client.recipe.findFirst({ where: { addOnId }, include: withItems }));
}

/** The same reading, over a row somebody has already loaded. */
export function readAddOnRecipe(r: LoadedRecipe | null): ResolvedRecipe {
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
  /** Read through the caller's transaction when there is one. */
  client?: Prisma.TransactionClient | PrismaClient;
}): Promise<Consumption> {
  const client = args.client ?? db;
  const base = await resolveEffectiveRecipe(args.productId, args.variantId, client);
  const addOns = await Promise.all(
    args.addOnIds.map((id) => resolveAddOnRecipe(id, client))
  );
  return mergeConsumption(base, addOns, args.quantity);
}

/**
 * The merge itself, over recipes somebody has already resolved.
 *
 * Same reason as `chooseEffectiveRecipe`: the availability board needs this
 * arithmetic for every configuration on the menu and cannot afford a query
 * per configuration, and a second implementation written to avoid them is how
 * the board and the SERVED-time deduction come to disagree about what one cup
 * takes off the shelf. There is one merge, and both callers use it.
 */
export function mergeConsumption(
  base: ResolvedRecipe,
  addOns: ResolvedRecipe[],
  quantity: number
): Consumption {
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
      const qty = round3(perUnit * quantity);
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

// ── Reading a whole café's recipes at once ───────────────────────────
//
// One query for the recipes, one for the variant counts, and then the SAME
// resolution and merge rules applied in memory. The POS availability board
// needs an answer for every sellable configuration on the menu, and the
// per-configuration functions above cost three queries each: fifty
// configurations would be a hundred and fifty round trips before a cashier's
// first tap.
//
// The alternative — a bespoke bulk calculator — is the one thing that must
// not exist. The whole point of variant-aware recipes is that a large latte
// and a small one resolve differently, and a second implementation of those
// rules would drift from this one silently, in the direction of a board that
// promises drinks the till then refuses.

export type RecipeIndex = {
  byVariant: Map<string, LoadedRecipe>;
  byProduct: Map<string, LoadedRecipe>;
  byAddOn: Map<string, LoadedRecipe>;
  variantCount: Map<string, number>;
};

export async function loadRecipeIndex(cafeId: string): Promise<RecipeIndex> {
  const [recipes, variantGroups] = await Promise.all([
    db.recipe.findMany({ where: { cafeId }, include: withItems }),
    db.productVariant.groupBy({
      by: ["productId"],
      where: { product: { cafeId } },
      _count: { _all: true },
    }),
  ]);

  const index: RecipeIndex = {
    byVariant: new Map(),
    byProduct: new Map(),
    byAddOn: new Map(),
    variantCount: new Map(variantGroups.map((g) => [g.productId, g._count._all])),
  };
  for (const r of recipes) {
    if (r.variantId) index.byVariant.set(r.variantId, r);
    else if (r.addOnId) index.byAddOn.set(r.addOnId, r);
    else if (r.productId) index.byProduct.set(r.productId, r);
  }
  return index;
}

/** `resolveEffectiveRecipe`, answered from a loaded index. */
export function resolveEffectiveRecipeFrom(
  index: RecipeIndex,
  productId: string,
  variantId: string | null
): ResolvedRecipe {
  return chooseEffectiveRecipe({
    variantId,
    variantRecipe: variantId ? (index.byVariant.get(variantId) ?? null) : null,
    defaultRecipe: index.byProduct.get(productId) ?? null,
    variantCount: index.variantCount.get(productId) ?? 0,
  });
}

/** `resolveAddOnRecipe`, answered from a loaded index. */
export function resolveAddOnRecipeFrom(index: RecipeIndex, addOnId: string): ResolvedRecipe {
  return readAddOnRecipe(index.byAddOn.get(addOnId) ?? null);
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

/**
 * Re-point recipe lines at a branch's own stock rows.
 *
 * Matching is by name + unit, deliberately the same rule stock deduction
 * uses, so the number on the board is the number that will leave the shelf.
 * A branch that does not carry an ingredient keeps the café row rather than
 * silently costing it at zero — the gate still reports MISSING_COST if that
 * row has no price.
 */
async function withBranchIngredientCosts(
  items: ItemWithStock[],
  branchId: string
): Promise<ItemWithStock[]> {
  if (items.length === 0) return items;
  const branchRows = await db.inventoryItem.findMany({
    where: {
      branchId,
      archivedAt: null,
      OR: items.map((i) => ({ name: i.inventoryItem.name, unit: i.inventoryItem.unit })),
    },
  });
  const byKey = new Map(branchRows.map((r) => [`${r.name}|${r.unit}`, r]));
  return items.map((i) => {
    const match = byKey.get(`${i.inventoryItem.name}|${i.inventoryItem.unit}`);
    return match ? { ...i, inventoryItem: match } : i;
  });
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
  /**
   * Cost the recipe against one branch's own stock. Recipes name café-level
   * ingredients, but each branch holds its own copy at its own price, and
   * that copy is what stock deduction actually draws down. Costing against
   * the café row while deducting from the branch row would let the board and
   * the shelf disagree about the same cup.
   */
  branchId?: string | null;
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

  const items = args.branchId
    ? await withBranchIngredientCosts(resolved.items, args.branchId)
    : resolved.items;
  const strict = productCostStrict(items);
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
