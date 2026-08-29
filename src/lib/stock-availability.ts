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
// know what the shelf holds, and whether to sell past it is the owner's
// decision. That decision is honoured.
//
// A recipe that does not resolve is an UNKNOWN consumption — nobody has
// written down what the drink draws off the shelf. Selling against it is how a
// café ends up with theoretical stock that has never met its shelf, and the
// next physical count reads the gap as somebody's shortage.
//
// Those are different risks, so the café's policy names them separately:
//
//   STRICT                refuse both
//   ALLOW_NEGATIVE_STOCK  accept the known shortage, still refuse the unknown
//   OVERRIDE_ALL          accept both, and say so — the sale carries a
//                         warning, an audit row, and an explicit record of
//                         what could not be resolved
//
// The middle mode is the point of having three: an owner can accept going
// below a balance we can compute without also agreeing to sell a draw nobody
// has written down. This module decides; it never chooses the policy, which is
// read from the café and never from the request.

import { db } from "@/lib/db";
import { round3, RecipeIssue } from "@/lib/costing";
import {
  theoreticalConsumption,
  loadRecipeIndex,
  mergeConsumption,
  resolveAddOnRecipeFrom,
  resolveEffectiveRecipeFrom,
  type Consumption,
} from "@/lib/recipes";
import { UNIT_LABEL } from "@/lib/inventory";
import {
  allowsKnownShortage,
  allowsUnknownConsumption,
  OVERRIDE_SALE_WARNING,
  type InventoryEnforcementMode,
} from "@/lib/inventory-policy";
import {
  countUncommittedOpenOrders,
  lockBranchItems,
  persistOrderCommitments,
  readBranchFreeQuantities,
  type CommitmentLine,
  type FreeQuantity,
} from "@/lib/inventory-commitment";
import type {
  AddOnRequirement,
  AvailabilityState,
  BranchAvailability,
  ConfigurationRequirement,
  IngredientSlot,
  Requirement,
} from "@/lib/available-to-sell";
import type { Prisma, PrismaClient, InventoryUnit } from "@prisma/client";

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
  /**
   * What a NEW sale may draw on: the shelf balance less what accepted orders
   * have already promised. This is the figure the refusal message quotes,
   * because it is the one the cashier can actually act on — "the freezer has
   * a kilo" is no use when the kilo is already spoken for.
   */
  available: number;
  /** The two halves of `available`, kept for the audit row and diagnostics. */
  currentStock: number;
  committed: number;
  /** Every cart line that contributed, for the message and for diagnostics. */
  labels: string[];
};

/** What a configuration wanted that we could not read. */
export type UnresolvedConsumption = { label: string; issues: RecipeIssue[] };

export type EnforcementDecision = "ALLOW" | "ALLOW_WITH_WARNING" | "BLOCK";

/**
 * The whole answer, in one shape, so callers never re-derive policy.
 *
 * `ok` is kept as the plain "may this sale proceed" question, which is what
 * every caller actually branches on; the richer fields are for the audit row
 * and the cashier's warning.
 */
export type AvailabilityVerdict = {
  ok: boolean;
  decision: EnforcementDecision;
  mode: InventoryEnforcementMode;
  /** Refusals that actually blocked. Empty unless decision is BLOCK. */
  refusals: Refusal[];
  /** Refusals the café's policy waived. Empty under STRICT, by construction. */
  waived: Refusal[];
  /** Blocking message for the cashier; null unless blocked. */
  message: string | null;
  /** Non-blocking messages for the cashier. */
  warnings: string[];
  /** Aggregated demand we could read, per branch stock row. */
  knownConsumption: Demand[];
  /** Configurations whose consumption we could NOT read. Never invented. */
  unresolvedConsumption: UnresolvedConsumption[];
  /** @deprecated use knownConsumption — kept so existing call sites read the same. */
  demand: Demand[];
};

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
 * ── Two callers, one calculator ──
 *
 * By default this writes nothing and locks nothing: it is the read the POS
 * makes before an order exists, and locking every ingredient row for the
 * length of a user-facing request would serialise the café behind the slowest
 * cashier while still holding nothing after the response was sent.
 *
 * Pass `client` + `lock` and the SAME function becomes the authoritative
 * check inside order creation: it takes the branch rows FOR UPDATE, re-reads
 * stock and live commitments underneath those locks, and returns a verdict
 * the caller can persist a commitment against. Two implementations — a
 * friendly one for the screen and a strict one for the transaction — is
 * exactly how a POS comes to promise what the till then refuses.
 */
export async function checkCartAvailability(args: {
  cafeId: string;
  branchId: string;
  /** The café's persisted policy. Never taken from a request body. */
  mode: InventoryEnforcementMode;
  lines: AvailabilityLine[];
  /** Run inside a caller's transaction, so the answer can be acted on. */
  client?: Prisma.TransactionClient | PrismaClient;
  /** Take the branch rows FOR UPDATE first. Requires an interactive `client`. */
  lock?: boolean;
}): Promise<AvailabilityVerdict> {
  const client = args.client ?? db;
  const refusals: Refusal[] = [];
  const unresolvedConsumption: UnresolvedConsumption[] = [];

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
      client,
    });

    const blocking = consumption.issues.filter((i) => UNRESOLVABLE.has(i));
    if (blocking.length > 0) {
      if (!refusals.some((r) => r.kind === "RECIPE_UNRESOLVABLE" && r.label === line.label)) {
        refusals.push({ kind: "RECIPE_UNRESOLVABLE", label: line.label, issues: blocking });
        // Recorded whether or not policy lets the sale through. Under
        // OVERRIDE_ALL this is what stops an unreadable recipe being quietly
        // treated as zero consumption later.
        unresolvedConsumption.push({ label: line.label, issues: blocking });
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
    const cafeItems = await client.inventoryItem.findMany({
      where: { id: { in: [...cafeDemand.keys()] }, cafeId: args.cafeId },
      select: { id: true, name: true, unit: true },
    });

    // ── Take the locks BEFORE reading the balances ──
    // In lock mode the whole point is that the numbers cannot move between
    // being read and being acted on, so the rows this cart touches are
    // resolved by name+unit first, locked, and only then measured. The lock
    // set is the cart's own ingredients, never the branch's whole store: a
    // milkshake order must not stop an espresso order.
    if (args.lock && args.client && cafeItems.length > 0) {
      const targets = await args.client.inventoryItem.findMany({
        where: {
          cafeId: args.cafeId,
          branchId: args.branchId,
          archivedAt: null,
          OR: cafeItems.map((i) => ({ name: i.name, unit: i.unit })),
        },
        select: { id: true },
      });
      await lockBranchItems(
        args.client as Prisma.TransactionClient,
        targets.map((t) => t.id)
      );
    }

    // Free quantity, not shelf balance: an accepted order that has not been
    // deducted yet has already spent its ingredients, and a check that
    // ignored that would let the branch sell the same last portion twice.
    // One statement, so the balance and the commitments describe one instant.
    const branchRows = cafeItems.length
      ? await readBranchFreeQuantities(client, args.cafeId, args.branchId)
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

      const cur = perBranchRow.get(branchRow.inventoryItemId);
      if (cur) {
        cur.required = round3(cur.required + want.qty);
        for (const l of want.labels) if (!cur.labels.includes(l)) cur.labels.push(l);
      } else {
        perBranchRow.set(branchRow.inventoryItemId, {
          inventoryItemId: branchRow.inventoryItemId,
          name: branchRow.name,
          unit: branchRow.unit,
          required: round3(want.qty),
          available: branchRow.free,
          currentStock: branchRow.currentStock,
          committed: branchRow.committed,
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
  // A shortage is recorded as a refusal REGARDLESS of policy. Whether it
  // actually blocks is decided in one place below, so the arithmetic and the
  // business rule never drift apart.
  for (const d of demand) {
    if (round3(d.available - d.required) < 0) {
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

  return applyPolicy(args.mode, refusals, demand, unresolvedConsumption);
}

/**
 * The single place the café's policy turns refusals into a decision.
 *
 * Everything above this point is arithmetic and resolution — the same facts
 * whatever the café has chosen. Keeping the policy in one function is what
 * stops `if (strict) … if (override) …` spreading into routes that have no
 * business knowing about it.
 */
function applyPolicy(
  mode: InventoryEnforcementMode,
  all: Refusal[],
  demand: Demand[],
  unresolvedConsumption: UnresolvedConsumption[]
): AvailabilityVerdict {
  const waivable = (r: Refusal) =>
    r.kind === "INSUFFICIENT"
      // A known number the owner has decided to sell past.
      ? allowsKnownShortage(mode)
      // An unknown draw on the shelf: a recipe that will not resolve, or an
      // ingredient this branch does not carry at all.
      : allowsUnknownConsumption(mode);

  const waived = all.filter(waivable);
  const refusals = all.filter((r) => !waivable(r));

  if (refusals.length > 0) {
    return {
      ok: false, decision: "BLOCK", mode,
      refusals, waived,
      message: refusalMessage(refusals),
      warnings: [],
      knownConsumption: demand, unresolvedConsumption, demand,
    };
  }

  const warnings: string[] = [];
  if (waived.length > 0) {
    // The cashier is told the sale went through on policy rather than on
    // stock, so "it let me sell it" never reads as "there was enough".
    if (waived.some((r) => r.kind !== "INSUFFICIENT")) {
      warnings.push(OVERRIDE_SALE_WARNING);
    }
    for (const r of waived) {
      if (r.kind === "INSUFFICIENT") {
        warnings.push(
          `الخامة «${r.ingredient}» أقل من المطلوب — المتاح ${r.available} ` +
            `${UNIT_LABEL[r.unit]} والمطلوب ${r.required} ${UNIT_LABEL[r.unit]}. ` +
            `تم السماح بالبيع حسب سياسة المنشأة وهيتسجل رصيد سالب.`
        );
      } else if (r.kind === "INGREDIENT_NOT_STOCKED") {
        warnings.push(
          `الخامة «${r.ingredient}» غير مسجلة في مخزون الفرع، فاستهلاكها مش هيتخصم.`
        );
      } else {
        warnings.push(
          `«${r.label}» مكوناته غير مضبوطة (${r.issues.map(issueLabel).join("، ")}) ` +
            `— الاستهلاك المسجل للطلب ده هيكون ناقص.`
        );
      }
    }
  }

  return {
    ok: true,
    decision: waived.length > 0 ? "ALLOW_WITH_WARNING" : "ALLOW",
    mode, refusals: [], waived,
    message: null, warnings,
    knownConsumption: demand, unresolvedConsumption, demand,
  };
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

// ── The POS availability board ───────────────────────────────────────
//
// Everything above answers "may this cart be sold". This answers the other
// half of the feature: for every sellable configuration on the menu, how many
// more could this branch make.
//
// The shape of the load is the design. A café has dozens of products and most
// of them have sizes, so a per-card question is not a slower version of the
// right answer — it is a different one that falls over at the counter. So:
//
//   one query   the branch's stock with its live commitments netted off
//   one query   how many open orders predate the commitment ledger
//   two queries the menu (products with their sizes and add-ons)
//   two queries every recipe in the café, and the per-product size counts
//
// and then the SAME resolution and merge that `theoreticalConsumption` uses,
// applied in memory. Not a bulk re-implementation of it: `mergeConsumption`
// and `chooseEffectiveRecipe` are the very functions the per-order path calls,
// reached through an index rather than through three queries per
// configuration. A second calculator written for speed is how a board comes
// to promise a drink the till then refuses.
//
// Nothing here is cached. Availability changes on every sale, every delivery,
// every cancellation and every recipe edit; a menu-shaped cache would serve a
// number that was true when the shift started.

/** Aggregate demand per branch slot for one resolved consumption. */
function requirementsFor(
  consumption: Consumption,
  slotOf: Map<string, number>
): { requirements: Requirement[]; missing: string[] } {
  const perSlot = new Map<number, number>();
  const missing: string[] = [];

  for (const line of consumption.lines) {
    // Recipes name café-level ingredients; the shelf that empties belongs to
    // one branch, and the match is by name+unit — the identical rule the
    // deduction uses, so the board counts what the deduction will remove.
    const slot = slotOf.get(`${line.name}|${line.stockUnit}`);
    if (slot === undefined) {
      if (!missing.includes(line.name)) missing.push(line.name);
      continue;
    }
    perSlot.set(slot, round3((perSlot.get(slot) ?? 0) + line.quantityInStockUnit));
  }

  return {
    requirements: [...perSlot.entries()].sort((a, b) => a[0] - b[0]),
    missing,
  };
}

/**
 * The state of one consumption before any arithmetic.
 *
 * The order is the café's own order of seriousness, and it is why these are
 * four answers rather than one number with caveats. An unreadable draw is not
 * a shortage — nobody has written down what the cup takes, so there is no
 * quantity to be short of. A branch that has never carried an ingredient is
 * not out of it either. Only when neither applies is there a count.
 */
function stateFor(
  consumption: Consumption,
  requirements: Requirement[],
  missing: string[]
): AvailabilityState {
  const unreadable = consumption.issues.filter((i) => UNRESOLVABLE.has(i));
  if (unreadable.length > 0) return "UNKNOWN";
  if (missing.length > 0) return "NOT_STOCKED";
  if (requirements.length === 0) return "NOT_STOCK_TRACKED";
  return "EXACT";
}

/** Blocking issues only — a missing PRICE is not a missing quantity. */
function unreadableIssues(consumption: Consumption): string[] {
  return consumption.issues.filter((i) => UNRESOLVABLE.has(i));
}

/** A stable identity for a requirement vector, so sizes can be compared. */
const vectorKey = (r: Requirement[]) => r.map(([s, q]) => `${s}:${q}`).join(",");

export async function branchAvailability(args: {
  cafeId: string;
  branchId: string;
  mode: InventoryEnforcementMode;
}): Promise<BranchAvailability> {
  const [free, uncertainOpenOrders, products, addOnRows, index] = await Promise.all([
    readBranchFreeQuantities(db, args.cafeId, args.branchId),
    countUncommittedOpenOrders(db, args.branchId),
    db.product.findMany({
      where: { cafeId: args.cafeId, isActive: true },
      select: {
        id: true,
        variants: { where: { isActive: true }, select: { id: true }, orderBy: { sortOrder: "asc" } },
      },
      orderBy: { sortOrder: "asc" },
    }),
    db.addOn.findMany({
      where: { cafeId: args.cafeId, isActive: true },
      select: { id: true },
    }),
    loadRecipeIndex(args.cafeId),
  ]);

  const ingredients: IngredientSlot[] = free.map((f) => ({
    name: f.name,
    unit: f.unit,
    free: f.free,
  }));
  const slotOf = new Map(free.map((f, i) => [`${f.name}|${f.unit}`, i]));

  const describe = (consumption: Consumption) => {
    const { requirements, missing } = requirementsFor(consumption, slotOf);
    return {
      state: stateFor(consumption, requirements, missing),
      requirements,
      missing,
      issues: unreadableIssues(consumption),
    };
  };

  const configurationOf = (productId: string, variantId: string | null) =>
    describe(
      mergeConsumption(resolveEffectiveRecipeFrom(index, productId, variantId), [], 1)
    );

  const configurations: ConfigurationRequirement[] = [];

  for (const p of products) {
    if (p.variants.length === 0) {
      configurations.push({ productId: p.id, variantId: null, ...configurationOf(p.id, null) });
      continue;
    }

    const sized = p.variants.map((v) => ({
      ...configurationOf(p.id, v.id),
      variantId: v.id,
    }));
    for (const s of sized) {
      configurations.push({ productId: p.id, ...s });
    }

    // The product-level entry, for a card whose size has not been chosen yet.
    //
    // When every size draws identically — which is what a product default
    // declared to cover all variants means — that IS the product's count and
    // showing it is honest. When they differ there is no single true number,
    // and picking either size's would be a lie about the other, so the card
    // is told to defer to the sizes and given their spread instead.
    const uniform =
      sized.every((s) => s.state === sized[0].state) &&
      new Set(sized.map((s) => vectorKey(s.requirements))).size === 1;

    configurations.push(
      uniform
        ? {
            productId: p.id,
            variantId: null,
            state: sized[0].state,
            requirements: sized[0].requirements,
            missing: sized[0].missing,
            issues: sized[0].issues,
          }
        : {
            productId: p.id,
            variantId: null,
            state: "PER_VARIANT",
            requirements: [],
            missing: [...new Set(sized.flatMap((s) => s.missing))],
            issues: [...new Set(sized.flatMap((s) => s.issues))],
          }
    );
  }

  const addOns: AddOnRequirement[] = addOnRows.map((a) => ({
    addOnId: a.id,
    ...describe(mergeConsumption(resolveAddOnRecipeFrom(index, a.id), [], 1)),
  }));

  return {
    branchId: args.branchId,
    mode: args.mode,
    generatedAt: new Date().toISOString(),
    uncertainOpenOrders,
    ingredients,
    configurations,
    addOns,
  };
}

/**
 * The commitment rows implied by a verdict, ready to persist.
 *
 * Taken from `knownConsumption` rather than recomputed, so what is recorded is
 * exactly the figure the policy decision was made against. Nothing is written
 * for a consumption that could not be read: the absence IS the honest record,
 * and a zero row would later read as "measured and found to be nothing".
 */
export function commitmentLinesFor(verdict: AvailabilityVerdict): CommitmentLine[] {
  return verdict.knownConsumption
    .filter((d) => d.required > 0)
    .map((d) => ({
      inventoryItemId: d.inventoryItemId,
      quantity: d.required,
      unit: d.unit,
    }));
}

export type { FreeQuantity };

/**
 * Snapshot an already-accepted order's consumption, from its own item rows.
 *
 * The till path builds its lines from a validated cart and blocks on the
 * verdict; a QR order does not go through a till. It is accepted either by a
 * branch that routes without approval or by the person who taps approve, and
 * in both cases the decision has already been taken — the customer has been
 * told yes. So this records what the order will consume and does NOT enforce:
 * refusing here would reject an order that has already been accepted, which
 * is a different feature and one nobody asked for.
 *
 * What it must not do is leave the order unaccounted for. Without a snapshot
 * a QR order would be indistinguishable from a pre-ledger legacy one, and
 * would sit in the branch's "uncertain" count until it finalised while its
 * ingredients quietly stayed available to the till.
 *
 * Runs inside the caller's transaction, behind the same row locks the till
 * takes, so two acceptances cannot race each other.
 */
export async function commitOrderConsumption(
  tx: Prisma.TransactionClient,
  order: {
    id: string;
    cafeId: string;
    branchId: string;
    inventoryEnforcementMode: InventoryEnforcementMode;
  }
): Promise<AvailabilityVerdict> {
  const items = await tx.orderItem.findMany({
    where: { orderId: order.id },
    select: {
      productId: true, variantId: true, productName: true, variantName: true,
      quantity: true, addOns: { select: { addOnId: true } },
    },
  });

  const verdict = await checkCartAvailability({
    cafeId: order.cafeId,
    branchId: order.branchId,
    mode: order.inventoryEnforcementMode,
    client: tx,
    lock: true,
    lines: items
      .filter((i): i is typeof i & { productId: string } => Boolean(i.productId))
      .map((i) => ({
        productId: i.productId,
        variantId: i.variantId ?? null,
        addOnIds: i.addOns.map((a) => a.addOnId).filter((id): id is string => Boolean(id)),
        quantity: i.quantity,
        label: i.variantName ? `${i.productName} (${i.variantName})` : i.productName,
      })),
  });

  await persistOrderCommitments(tx, {
    orderId: order.id,
    cafeId: order.cafeId,
    branchId: order.branchId,
    lines: commitmentLinesFor(verdict),
  });
  return verdict;
}
