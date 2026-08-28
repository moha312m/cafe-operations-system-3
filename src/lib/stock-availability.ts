// ── Pre-sale stock availability ──────────────────────────────────────
//
// Whether the branch can actually make what the cashier is about to sell,
// asked BEFORE the order exists.
//
// The café already had a stock gate, and it was in the right place for what
// it does: `deductStockForOrder` runs at SERVED, inside a transaction, under
// each item's row lock, and it is the authoritative mutation. What it cannot
// be is an availability answer, because by the time it runs the sale has
// happened — the order is created, the money may be collected, and the
// customer is standing at the counter. A shortage discovered there is not a
// refusal, it is a cancellation.
//
// So this module answers a different question at a different moment, and the
// two are deliberately not merged:
//
//   availability (here)      READ ONLY. No lock, no reservation, no write.
//   deduction (SERVED)       LOCK + MUTATE. Still the final word.
//
// There is intentionally no reservation at order creation. Locking every
// ingredient row for the duration of a user-facing POS request to imitate one
// would serialise the whole café behind the slowest cashier, and would still
// not be a reservation — nothing would hold the stock after the request
// returned. The consequence is stated plainly rather than designed around: a
// check that passes here can be overtaken by another order before this one is
// served, and the SERVED-time locked check is what catches that.
//
// ── What blocks, and why the two refusals are not the same ──
//
// A quantity shortage is a KNOWN number: we know what the drink consumes, we
// know what the shelf holds, and the café's `allowNegativeStock` is exactly
// the owner's decision about whether to sell past it. That decision is
// honoured.
//
// A recipe that does not resolve is an UNKNOWN consumption. `allowNegativeStock`
// says nothing about it — it is permission to go below a balance we can
// compute, not permission to sell something whose draw on the shelf nobody has
// written down. Letting negative stock wave through an unmapped product is how
// a café ends up with theoretical stock that has never met its shelf, and the
// next physical count reads the gap as somebody's shortage. So configuration
// gaps block regardless of the negative-stock setting.

import { db } from "@/lib/db";
import { round3, RecipeIssue } from "@/lib/costing";
import { theoreticalConsumption } from "@/lib/recipes";
import { UNIT_LABEL } from "@/lib/inventory";
import type { InventoryUnit } from "@prisma/client";

/** One thing the cart is asking the branch to make. */
export type AvailabilityLine = {
  productId: string;
  variantId: string | null;
  addOnIds: string[];
  quantity: number;
  /** How the line is named back to the cashier, e.g. "لاتيه (كبير)". */
  label: string;
};

/**
 * Recipe problems that make CONSUMPTION unknowable.
 *
 * The membership of this set is the whole judgement, so it is spelled out
 * rather than reused from `Consumption.complete`. `complete` is false for
 * MISSING_COST too, and a missing price is a costing gap, not an availability
 * one: we still know the drink takes 18 g of beans, and refusing to sell it
 * because nobody priced the bag would be the system inventing a stockout.
 *
 * Everything below, by contrast, means the quantity itself is not knowable:
 * no recipe, an empty one, a line whose unit cannot be converted (silently
 * dropped from the consumption), a non-positive quantity, or an ingredient
 * the café has withdrawn.
 */
const UNRESOLVABLE: ReadonlySet<RecipeIssue> = new Set([
  RecipeIssue.MISSING_RECIPE,
  RecipeIssue.MISSING_VARIANT_RECIPE,
  RecipeIssue.MISSING_ADDON_RECIPE,
  RecipeIssue.NO_INGREDIENTS,
  RecipeIssue.INCOMPATIBLE_UNIT,
  RecipeIssue.INVALID_QUANTITY,
  RecipeIssue.INACTIVE_INGREDIENT,
]);

export type Refusal =
  /** Nothing describes what this configuration consumes. */
  | { kind: "RECIPE_UNRESOLVABLE"; label: string; issues: RecipeIssue[] }
  /** The recipe names an ingredient this branch does not carry at all. */
  | { kind: "INGREDIENT_NOT_STOCKED"; label: string; ingredient: string }
  /** The branch carries it and does not hold enough. */
  | {
      kind: "INSUFFICIENT";
      label: string;
      ingredient: string;
      unit: InventoryUnit;
      available: number;
      required: number;
    };

/** Aggregated demand for one branch stock row, and who asked for it. */
export type Demand = {
  inventoryItemId: string;
  name: string;
  unit: InventoryUnit;
  required: number;
  available: number;
  /** Every cart line that contributed, for the message and for diagnostics. */
  labels: string[];
};

export type AvailabilityVerdict =
  | { ok: true; demand: Demand[] }
  | { ok: false; refusals: Refusal[]; message: string; demand: Demand[] };

/**
 * Can this whole cart be made from this branch's stock right now?
 *
 * Aggregation is across the WHOLE order, not per line. Checking each line
 * against the same opening balance is the bug that makes two milkshakes look
 * affordable when only one is: 0.300 KG of ice cream satisfies 0.220 twice
 * over if you ask the question twice, and never satisfies 0.440 once. Demand
 * is therefore summed per BRANCH stock row before anything is compared, which
 * also merges the cases that reach the same ingredient by different routes —
 * base recipe and add-on, two sizes of the same drink, two separate lines.
 *
 * Writes nothing. Locks nothing.
 */
export async function checkCartAvailability(args: {
  cafeId: string;
  branchId: string;
  allowNegativeStock: boolean;
  lines: AvailabilityLine[];
}): Promise<AvailabilityVerdict> {
  const refusals: Refusal[] = [];

  // ── 1. What the cart theoretically consumes ──
  // Resolution is `theoreticalConsumption`'s, not a second copy of it: the
  // exact-configuration rules (a product default reaches a variant only when
  // it was declared to, add-ons merge into the base, NOT_APPLICABLE consumes
  // nothing) must be the same ones the SERVED-time deduction obeys, or the
  // POS would refuse orders the deduction would have allowed and vice versa.
  const cafeDemand = new Map<string, { qty: number; labels: string[] }>();

  for (const line of args.lines) {
    const consumption = await theoreticalConsumption({
      productId: line.productId,
      variantId: line.variantId,
      addOnIds: line.addOnIds,
      quantity: line.quantity,
    });

    const blocking = consumption.issues.filter((i) => UNRESOLVABLE.has(i));
    if (blocking.length > 0) {
      if (!refusals.some((r) => r.kind === "RECIPE_UNRESOLVABLE" && r.label === line.label)) {
        refusals.push({ kind: "RECIPE_UNRESOLVABLE", label: line.label, issues: blocking });
      }
      // No quantity is guessed for a configuration we could not read. It
      // contributes nothing to demand, and the refusal above is why.
      continue;
    }

    // An explicit NOT_APPLICABLE resolves cleanly to no lines. That is a
    // decision somebody recorded — "this consumes nothing trackable" — and it
    // is the one empty consumption that is an answer rather than a gap.
    for (const cl of consumption.lines) {
      const cur = cafeDemand.get(cl.inventoryItemId);
      if (cur) {
        cur.qty = round3(cur.qty + cl.quantityInStockUnit);
        if (!cur.labels.includes(line.label)) cur.labels.push(line.label);
      } else {
        cafeDemand.set(cl.inventoryItemId, {
          qty: cl.quantityInStockUnit,
          labels: [line.label],
        });
      }
    }
  }

  // ── 2. Re-point that demand at THIS branch's own stock rows ──
  // Recipes name café-level ingredients; the shelf that empties belongs to
  // one branch. Matching is by name + unit, deliberately the identical rule
  // `deductStockForOrder` uses, so the figure the POS refuses on is the
  // figure the deduction will later work from.
  //
  // Both lookups are scoped to the café, and the branch lookup to the branch:
  // another café's ice cream, or another branch's, can never make an order
  // here look servable.
  const demand: Demand[] = [];

  if (cafeDemand.size > 0) {
    const cafeItems = await db.inventoryItem.findMany({
      where: { id: { in: [...cafeDemand.keys()] }, cafeId: args.cafeId },
      select: { id: true, name: true, unit: true },
    });

    const branchRows = cafeItems.length
      ? await db.inventoryItem.findMany({
          where: {
            cafeId: args.cafeId,
            branchId: args.branchId,
            archivedAt: null,
            OR: cafeItems.map((i) => ({ name: i.name, unit: i.unit })),
          },
          select: { id: true, name: true, unit: true, currentStock: true },
        })
      : [];
    const byKey = new Map(branchRows.map((r) => [`${r.name}|${r.unit}`, r]));

    // Two café rows can name the same ingredient; they land on one branch row
    // and their demand must add up there rather than compete.
    const perBranchRow = new Map<string, Demand>();

    for (const [cafeItemId, want] of cafeDemand) {
      const cafeItem = cafeItems.find((i) => i.id === cafeItemId);
      // A recipe line pointing outside this café is not stock we may spend.
      if (!cafeItem) {
        for (const label of want.labels) {
          refusals.push({ kind: "INGREDIENT_NOT_STOCKED", label, ingredient: "—" });
        }
        continue;
      }

      const branchRow = byKey.get(`${cafeItem.name}|${cafeItem.unit}`);
      if (!branchRow) {
        // Deliberately unconditional, and deliberately different from the
        // SERVED-time path, which skips an unstocked ingredient when the café
        // allows negative stock. Negative stock is permission to go below a
        // balance; there is no balance here. The branch has never carried this
        // ingredient, so selling the drink would consume an amount that no
        // count will ever see leave — which is the unknown-consumption case,
        // not the known-shortage one.
        for (const label of want.labels) {
          refusals.push({
            kind: "INGREDIENT_NOT_STOCKED",
            label,
            ingredient: cafeItem.name,
          });
        }
        continue;
      }

      const cur = perBranchRow.get(branchRow.id);
      if (cur) {
        cur.required = round3(cur.required + want.qty);
        for (const l of want.labels) if (!cur.labels.includes(l)) cur.labels.push(l);
      } else {
        perBranchRow.set(branchRow.id, {
          inventoryItemId: branchRow.id,
          name: branchRow.name,
          unit: branchRow.unit,
          required: round3(want.qty),
          available: round3(Number(branchRow.currentStock)),
          labels: [...want.labels],
        });
      }
    }

    demand.push(...perBranchRow.values());
  }

  // ── 3. Compare ──
  // `available - required < 0`, so spending the last exact portion is allowed:
  // a branch holding 0.220 KG may sell the drink that takes 0.220 KG and
  // finish at zero. round3 first, because stock is Decimal(12,3) and the
  // comparison must not turn a float tail into a phantom shortage.
  for (const d of demand) {
    if (round3(d.available - d.required) < 0 && !args.allowNegativeStock) {
      refusals.push({
        kind: "INSUFFICIENT",
        label: d.labels[0],
        ingredient: d.name,
        unit: d.unit,
        available: d.available,
        required: d.required,
      });
    }
  }

  if (refusals.length === 0) return { ok: true, demand };
  return { ok: false, refusals, message: refusalMessage(refusals), demand };
}

/**
 * What the cashier is told.
 *
 * The first refusal is spelled out in full — the drink, the ingredient, what
 * is on the shelf and what the order needs — because that is what the person
 * at the counter has to act on. Further refusals are counted rather than
 * listed, so a cart with a systemic gap does not produce a wall of text at
 * the till. Ingredient and product names are shown; ids are not, because they
 * mean nothing to the person reading the message.
 */
function refusalMessage(refusals: Refusal[]): string {
  const first = refusals[0];
  const more =
    refusals.length > 1 ? ` (و${refusals.length - 1} صنف آخر في نفس الطلب)` : "";

  switch (first.kind) {
    case "RECIPE_UNRESOLVABLE":
      return (
        `لا يمكن بيع «${first.label}» لأن مكوناته غير مضبوطة على النظام` +
        ` (${first.issues.map(issueLabel).join("، ")}).` +
        ` راجع الوصفة الأول${more}`
      );
    case "INGREDIENT_NOT_STOCKED":
      return (
        `لا يمكن إضافة «${first.label}» لأن الخامة «${first.ingredient}»` +
        ` غير مسجلة في مخزون الفرع${more}`
      );
    case "INSUFFICIENT":
      return (
        `لا يمكن إضافة «${first.label}» لأن الخامة «${first.ingredient}» غير متوفرة بالكمية المطلوبة.` +
        ` المتاح: ${first.available} ${UNIT_LABEL[first.unit]}` +
        ` — المطلوب: ${first.required} ${UNIT_LABEL[first.unit]}${more}`
      );
  }
}

/** Recipe gaps in the language of the person who has to fix them. */
function issueLabel(issue: RecipeIssue): string {
  switch (issue) {
    case RecipeIssue.MISSING_RECIPE:
      return "لا توجد وصفة";
    case RecipeIssue.MISSING_VARIANT_RECIPE:
      return "الحجم ده مالوش وصفة";
    case RecipeIssue.MISSING_ADDON_RECIPE:
      return "إضافة بدون وصفة";
    case RecipeIssue.NO_INGREDIENTS:
      return "الوصفة بدون مكونات";
    case RecipeIssue.INCOMPATIBLE_UNIT:
      return "وحدة قياس غير متوافقة";
    case RecipeIssue.INVALID_QUANTITY:
      return "كمية غير صحيحة";
    case RecipeIssue.INACTIVE_INGREDIENT:
      return "خامة موقوفة";
    default:
      return issue;
  }
}
