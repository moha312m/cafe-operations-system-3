import type { InventoryUnit } from "@prisma/client";

export const round2 = (n: number) => Math.round(n * 100) / 100;
export const round3 = (n: number) => Math.round(n * 1000) / 1000;

// Unit "families": conversion is only allowed within the same family.
// PIECE/BOX/BAG are discrete and only convert to themselves.
type Family = "mass" | "volume" | "piece" | "box" | "bag";

const FAMILY: Record<InventoryUnit, Family> = {
  GRAM: "mass",
  KG: "mass",
  ML: "volume",
  LITER: "volume",
  PIECE: "piece",
  BOX: "box",
  BAG: "bag",
};

// Factor to the family's base unit (gram / ml / one).
const TO_BASE: Record<InventoryUnit, number> = {
  GRAM: 1,
  KG: 1000,
  ML: 1,
  LITER: 1000,
  PIECE: 1,
  BOX: 1,
  BAG: 1,
};

export function unitsCompatible(a: InventoryUnit, b: InventoryUnit): boolean {
  return FAMILY[a] === FAMILY[b];
}

// Convert `quantity` expressed in `from` into the equivalent count in `to`.
// Throws if the units are incompatible (caller shows the Arabic error).
export function convertQuantity(
  quantity: number,
  from: InventoryUnit,
  to: InventoryUnit
): number {
  if (!unitsCompatible(from, to)) {
    throw new Error("وحدة القياس غير متوافقة مع الخامة");
  }
  return (quantity * TO_BASE[from]) / TO_BASE[to];
}

// ── Cost of one recipe ingredient ──
// quantity is in recipe.unit; the inventory item's costPerUnit is per its
// own storage unit — so convert the recipe amount into the item's unit,
// then multiply by cost, then apply waste %.
export function ingredientCost(args: {
  quantity: number;
  recipeUnit: InventoryUnit;
  itemUnit: InventoryUnit;
  costPerUnit: number;
  wastePercentage?: number;
}): number {
  const qtyInItemUnit = convertQuantity(args.quantity, args.recipeUnit, args.itemUnit);
  const base = qtyInItemUnit * args.costPerUnit;
  const withWaste = base * (1 + (args.wastePercentage ?? 0) / 100);
  return round2(withWaste);
}

// ── Whole-product cost from its recipe rows ──
// Numeric fields accept anything Number()-able (incl. Prisma Decimal).
type Num = number | string | { toString(): string };
export type RecipeRow = {
  quantity: Num;
  unit: InventoryUnit;
  wastePercentage?: Num;
  inventoryItem: { unit: InventoryUnit; costPerUnit: Num };
};

export function productCost(recipe: RecipeRow[]): number {
  let total = 0;
  for (const r of recipe) {
    // Read paths must never crash on a legacy row with an incompatible
    // unit — skip it (contributes 0). Saving a recipe still validates
    // units strictly and rejects incompatible ones.
    if (!unitsCompatible(r.unit, r.inventoryItem.unit)) continue;
    total += ingredientCost({
      quantity: Number(r.quantity),
      recipeUnit: r.unit,
      itemUnit: r.inventoryItem.unit,
      costPerUnit: Number(r.inventoryItem.costPerUnit),
      wastePercentage: Number(r.wastePercentage ?? 0),
    });
  }
  return round2(total);
}

// ── Profit & margin ──
export type Profitability = "high" | "medium" | "low" | "loss" | "no-recipe";

export function profitFor(sellingPrice: number, cost: number, hasRecipe: boolean) {
  if (!hasRecipe) {
    return { cost: 0, profit: 0, margin: 0, tier: "no-recipe" as Profitability };
  }
  const profit = round2(sellingPrice - cost);
  const margin = sellingPrice > 0 ? round2((profit / sellingPrice) * 100) : 0;
  let tier: Profitability;
  if (margin >= 60) tier = "high";
  else if (margin >= 40) tier = "medium";
  else if (margin >= 20) tier = "low";
  else tier = "loss";
  return { cost: round2(cost), profit, margin, tier };
}

export const PROFIT_LABEL: Record<Profitability, string> = {
  high: "ربح عالي",
  medium: "ربح متوسط",
  low: "ربح ضعيف",
  loss: "هامش ضعيف",
  "no-recipe": "لا توجد وصفة",
};
