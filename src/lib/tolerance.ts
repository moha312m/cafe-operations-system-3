// How close is close enough, and who gets to say.
//
// Precedence is ITEM → CATEGORY → BRANCH → CAFE. The narrowest configured
// rule wins because it is the one somebody chose most deliberately: a café
// rule of 2% is a general statement, an item rule of 18 g on espresso beans
// is a specific one, and the specific must not be overridden by the general.
//
// Two readings here are conservative on purpose:
//
// NO RULE MEANS EXACT MATCH. A café that has never configured tolerance has
// not thereby permitted unlimited drift — it has simply not spoken, and the
// safe reading of silence is zero. The alternative would let an unconfigured
// shop silently absorb every discrepancy it ever found.
//
// BOTH SET MEANS BOTH MUST BE EXCEEDED. A rule carrying quantity 0.5 kg AND
// percent 2% describes a variance that is small in EITHER sense as
// acceptable. Requiring only one to be exceeded would make the pair stricter
// than either bound on its own, which is not what anyone configuring two
// bounds intends.

import type { PaymentMethod, ToleranceScope } from "@prisma/client";
import { db } from "@/lib/db";
import { round3 } from "@/lib/costing";

export type ResolvedTolerance = {
  quantityTolerance: number | null;
  percentTolerance: number | null;
  amountTolerance: number | null;
  /** "NONE" means no rule was configured, which is an exact-match demand. */
  scope: ToleranceScope | "NONE";
  ruleId: string | null;
};

const NO_TOLERANCE: ResolvedTolerance = {
  quantityTolerance: null,
  percentTolerance: null,
  amountTolerance: null,
  scope: "NONE",
  ruleId: null,
};

type RuleRow = {
  id: string;
  scope: ToleranceScope;
  quantityTolerance: unknown;
  percentTolerance: unknown;
  amountTolerance: unknown;
};

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

function shape(rule: RuleRow | null | undefined): ResolvedTolerance {
  if (!rule) return NO_TOLERANCE;
  return {
    quantityTolerance: num(rule.quantityTolerance),
    percentTolerance: num(rule.percentTolerance),
    amountTolerance: num(rule.amountTolerance),
    scope: rule.scope,
    ruleId: rule.id,
  };
}

/**
 * The stock tolerance governing one item at one branch.
 *
 * TENDER-scoped rules are excluded by construction: an EGP amount tolerance
 * on card settlement says nothing about how many grams of coffee may be
 * missing, and letting one leak into a stock decision would be a category
 * error with a real consequence.
 */
export async function resolveStockTolerance(args: {
  cafeId: string;
  branchId: string;
  inventoryItemId: string;
  category: string | null;
}): Promise<ResolvedTolerance> {
  const rules = await db.toleranceRule.findMany({
    where: {
      cafeId: args.cafeId,
      isActive: true,
      scope: { in: ["ITEM", "CATEGORY", "BRANCH", "CAFE"] },
      OR: [
        { scope: "ITEM", inventoryItemId: args.inventoryItemId },
        ...(args.category ? [{ scope: "CATEGORY" as const, category: args.category }] : []),
        { scope: "BRANCH", branchId: args.branchId },
        { scope: "CAFE" },
      ],
    },
    select: {
      id: true, scope: true,
      quantityTolerance: true, percentTolerance: true, amountTolerance: true,
    },
  });

  // Narrowest wins. Ordered in code rather than SQL so the precedence is
  // legible next to the comment that explains it.
  const order: ToleranceScope[] = ["ITEM", "CATEGORY", "BRANCH", "CAFE"];
  for (const scope of order) {
    const hit = rules.find((r) => r.scope === scope);
    if (hit) return shape(hit);
  }
  return NO_TOLERANCE;
}

/** The tolerance governing one non-cash tender method at a branch. */
export async function resolveTenderTolerance(args: {
  cafeId: string;
  branchId: string;
  method: PaymentMethod;
}): Promise<ResolvedTolerance> {
  const rule = await db.toleranceRule.findFirst({
    where: {
      cafeId: args.cafeId,
      isActive: true,
      scope: "TENDER",
      tenderMethod: args.method,
      // A branch-specific tender rule wins over a café-wide one; NULL here
      // means the rule was written for the whole café.
      OR: [{ branchId: args.branchId }, { branchId: null }],
    },
    orderBy: { branchId: { sort: "desc", nulls: "last" } },
    select: {
      id: true, scope: true,
      quantityTolerance: true, percentTolerance: true, amountTolerance: true,
    },
  });
  return shape(rule);
}

/**
 * Cash tolerance.
 *
 * Cash is a tender method like any other for the purpose of "how far off may
 * the drawer be" — but it stays authoritative on the existing Shift close
 * path, and this function only supplies the bound that path compares against.
 */
export async function resolveCashTolerance(args: {
  cafeId: string;
  branchId: string;
}): Promise<ResolvedTolerance> {
  return resolveTenderTolerance({ ...args, method: "CASH" });
}

/**
 * Whether a variance falls inside the resolved tolerance.
 *
 * Sign is irrelevant: an unexplained surplus is as much a discrepancy as an
 * unexplained shortage, and a rule that only caught shortages would let
 * over-receiving pass unremarked.
 */
export function withinTolerance(args: {
  varianceQuantity?: number;
  expectedQuantity?: number;
  varianceAmount?: number;
  tolerance: ResolvedTolerance;
}): boolean {
  const { tolerance } = args;

  const bounds: boolean[] = [];

  if (args.varianceQuantity !== undefined) {
    const variance = Math.abs(round3(args.varianceQuantity));

    if (tolerance.quantityTolerance !== null) {
      bounds.push(variance <= tolerance.quantityTolerance);
    }
    if (tolerance.percentTolerance !== null && args.expectedQuantity !== undefined) {
      const allowed = Math.abs(args.expectedQuantity) * (tolerance.percentTolerance / 100);
      bounds.push(variance <= round3(allowed));
    }
  }

  if (args.varianceAmount !== undefined && tolerance.amountTolerance !== null) {
    bounds.push(Math.abs(args.varianceAmount) <= tolerance.amountTolerance);
  }

  // No applicable bound: silence is not permission, so only an exact match
  // passes. This is the `scope: "NONE"` case, and also a rule whose
  // configured dimension does not apply to what is being judged.
  if (bounds.length === 0) {
    if (args.varianceQuantity !== undefined) return round3(args.varianceQuantity) === 0;
    if (args.varianceAmount !== undefined) return args.varianceAmount === 0;
    return true;
  }

  // Both set means both must be exceeded to fall outside — so being inside
  // ANY configured bound keeps the variance within tolerance.
  return bounds.some(Boolean);
}
