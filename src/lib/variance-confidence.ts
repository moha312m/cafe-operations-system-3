// Judge the whole gap since the last count, and cost nothing we cannot price.
//
// Two mistakes this module exists to prevent, both of which look reasonable
// until you follow them through.
//
// THE WINDOW. An earlier revision rolled confidence over "the orders served
// under this shift". Stock does not work that way. It drifts across every
// shift since the last physical count, so a shortage found this evening may
// have been created by an unmapped add-on three shifts ago. Judging only
// today's orders would find them all well-mapped, report VERIFIED, and hand
// somebody a confident figure resting on a gap nobody looked at.
//
// So the window runs from the last TRUSTED BASELINE — the `confirmedAt` of
// the most recent CONFIRMED or LOCKED count covering that item at that
// branch, or the item's own `createdAt` when there has never been one — up to
// the moment the line was counted. An unconfirmed count is not a baseline: it
// would shorten the window on the strength of a count still being argued
// about. The chosen window is stored on the line (`confidenceWindowFrom`) so
// the judgement can be reproduced later, rather than re-derived from a menu
// that has since changed.
//
// THE ZERO. A missing cost is not a cost of zero. `stockCostImpact` returns
// unavailable when the ingredient has no usable price and when confidence is
// anything but VERIFIED, and no path through it returns a value for something
// it could not price. Zero remains expressible — but only when zero is the
// true, trustworthy answer.
//
// And the consequence that matters most: PARTIAL or UNVERIFIABLE evidence
// must never quietly become somebody's fault. `mayAssignResponsibility` is
// true for VERIFIED alone.

import type { TheoreticalConfidence } from "@prisma/client";
import { db } from "@/lib/db";
import { RecipeIssue, round2 } from "@/lib/costing";
import { isEligibleForVarianceCosting } from "@/lib/recipes";
import type { FinancialImpact } from "@/lib/variance-case";

/** Counts somebody confirmed. A DRAFT or SUBMITTED count is not a baseline. */
const TRUSTED_STATUSES = ["CONFIRMED", "LOCKED"] as const;

/**
 * When this item was last counted and believed, at this branch.
 *
 * Falls back to the item's `createdAt` rather than to the epoch or to now: an
 * item that has never been counted has been drifting since it existed, and
 * that whole span is exactly the window worth judging.
 */
export async function lastTrustedBaselineAt(args: {
  branchId: string;
  inventoryItemId: string;
  before: Date;
}): Promise<{ at: Date; sessionId: string | null }> {
  const line = await db.stockCountLine.findFirst({
    where: {
      inventoryItemId: args.inventoryItemId,
      session: {
        branchId: args.branchId,
        status: { in: [...TRUSTED_STATUSES] },
        confirmedAt: { not: null, lt: args.before },
      },
    },
    orderBy: { session: { confirmedAt: "desc" } },
    select: { session: { select: { id: true, confirmedAt: true } } },
  });

  if (line?.session.confirmedAt) {
    return { at: line.session.confirmedAt, sessionId: line.session.id };
  }

  const item = await db.inventoryItem.findUniqueOrThrow({
    where: { id: args.inventoryItemId },
    select: { createdAt: true },
  });
  return { at: item.createdAt, sessionId: null };
}

/**
 * How far the theoretical consumption for this item can be trusted over the
 * window.
 *
 * Every contributing configuration eligible → VERIFIED. Some → PARTIAL. None,
 * or anything with a missing recipe → UNVERIFIABLE. This is the STOCK-002 gap
 * carried up to the reconciliation layer: a configuration that cannot be
 * priced is disclosed rather than skipped silently.
 *
 * `ordersExamined` is returned so a caller — and a test — can tell an empty
 * window from a clean one.
 */
export async function confidenceForCountedItem(args: {
  cafeId: string;
  branchId: string;
  inventoryItemId: string;
  windowFrom: Date;
  countedAt: Date;
}): Promise<{ confidence: TheoreticalConfidence; issues: RecipeIssue[]; ordersExamined: number }> {
  const orders = await db.order.findMany({
    where: {
      cafeId: args.cafeId,
      branchId: args.branchId,
      createdAt: { gte: args.windowFrom, lte: args.countedAt },
      status: { notIn: ["CANCELLED"] },
    },
    select: {
      id: true,
      items: {
        select: {
          productId: true,
          variantId: true,
          addOns: { select: { addOnId: true } },
        },
      },
    },
  });

  const issues = new Set<RecipeIssue>();
  let eligible = 0;
  let considered = 0;

  // One verdict per distinct configuration, not per line sold: selling the
  // same unmapped latte forty times is one gap, and counting it forty times
  // would make the ratio a popularity contest.
  const seen = new Set<string>();

  for (const order of orders) {
    for (const item of order.items) {
      if (!item.productId) continue;
      const addOnIds = item.addOns
        .map((a) => a.addOnId)
        .filter((id): id is string => id !== null)
        .sort();
      const key = `${item.productId}|${item.variantId ?? ""}|${addOnIds.join(",")}`;
      if (seen.has(key)) continue;
      seen.add(key);

      considered += 1;
      const verdict = await isEligibleForVarianceCosting({
        productId: item.productId,
        variantId: item.variantId,
        addOnIds,
      });
      verdict.issues.forEach((i) => issues.add(i));
      if (verdict.eligible) eligible += 1;
    }
  }

  const missingRecipe =
    issues.has(RecipeIssue.MISSING_RECIPE) || issues.has(RecipeIssue.MISSING_VARIANT_RECIPE);

  let confidence: TheoreticalConfidence;
  if (considered === 0 || eligible === 0 || missingRecipe) {
    // Nothing to judge, nothing that passed, or a recipe that does not exist
    // at all — in every case the theoretical figure is not something to hold
    // anybody to.
    confidence = "UNVERIFIABLE";
  } else if (eligible === considered) {
    confidence = "VERIFIED";
  } else {
    confidence = "PARTIAL";
  }

  return { confidence, issues: [...issues], ordersExamined: orders.length };
}

/**
 * What a stock variance cost, or why that cannot be said.
 *
 * `costPerUnit <= 0` is treated as missing rather than as free: an ingredient
 * priced at zero has not been priced. Confidence below VERIFIED is unavailable
 * for a different reason — the cost is knowable, but the consumption it would
 * be measured against is not, and multiplying the two would produce a
 * confident number resting on a gap.
 */
export function stockCostImpact(args: {
  varianceQuantity: number;
  costPerUnit: number | null;
  confidence: TheoreticalConfidence;
}): FinancialImpact {
  if (args.costPerUnit === null || !Number.isFinite(args.costPerUnit) || args.costPerUnit <= 0) {
    return { available: false, reason: "MISSING_COST" };
  }
  if (args.confidence !== "VERIFIED") {
    return { available: false, reason: "CONFIDENCE_NOT_VERIFIED" };
  }
  // Sign is irrelevant: an unexplained surplus is as much a discrepancy as an
  // unexplained shortage, and both cost the same to investigate.
  return { available: true, value: round2(Math.abs(args.varianceQuantity) * args.costPerUnit) };
}

/**
 * Whether evidence at this confidence may carry somebody's name.
 *
 * VERIFIED only. PARTIAL means some configurations behind the figure were
 * unmapped, and holding a person responsible for a number built partly on
 * guesswork is the failure this whole module exists to prevent.
 */
export function mayAssignResponsibility(c: TheoreticalConfidence): boolean {
  return c === "VERIFIED";
}
