// ── Payment & serving policy ─────────────────────────────────────────
//
// Whether an order may reach the customer before it is paid. The owner sets
// this per order type; staff never choose it per order, so the decision has
// to be resolved from configuration on the server every time it is asked.
//
// Resolution is café default, optionally overridden per branch:
//
//     branch.<type>ServingPolicyOverride ?? cafeSettings.<type>ServingPolicy
//
// A NULL override means "inherit", which is why the override lives as a
// nullable column rather than its own settings row — an unconfigured branch
// and an inheriting branch are the same thing and should not be
// distinguishable.
//
// This module is the only place that fallback is expressed. Routes and
// components ask it rather than re-deriving it, so a branch cannot end up
// obeying one rule on the kitchen screen and another in the API.

import { db } from "@/lib/db";
import type { OrderType, ServingPaymentPolicy } from "@prisma/client";

export type EffectiveServingPolicy = {
  dineIn: ServingPaymentPolicy;
  takeaway: ServingPaymentPolicy;
  /** Whether each came from the branch or was inherited — for the settings UI. */
  dineInInherited: boolean;
  takeawayInherited: boolean;
};

/** DELIVERY is not configurable yet; it keeps the pre-feature behaviour. */
const DELIVERY_POLICY: ServingPaymentPolicy = "REQUIRE_PAYMENT_FIRST";

export const POLICY_LABELS: Record<ServingPaymentPolicy, string> = {
  ALLOW_BEFORE_PAYMENT: "السماح بالتقديم قبل الدفع",
  REQUIRE_PAYMENT_FIRST: "الدفع قبل التقديم",
};

/**
 * The policy actually in force at a branch. Throws if the branch does not
 * exist rather than guessing a default, because guessing here would silently
 * decide whether money is collected.
 */
export async function getEffectiveServingPolicy(
  branchId: string
): Promise<EffectiveServingPolicy> {
  const branch = await db.branch.findUnique({
    where: { id: branchId },
    select: {
      cafeId: true,
      dineInServingPolicyOverride: true,
      takeawayServingPolicyOverride: true,
    },
  });
  if (!branch) throw new Error(`Unknown branch ${branchId}`);

  // A café row that predates CafeSettings falls back to the stricter rule:
  // never hand food over unpaid because a settings row is missing.
  const settings = await db.cafeSettings.findUnique({
    where: { cafeId: branch.cafeId },
    select: { dineInServingPolicy: true, takeawayServingPolicy: true },
  });
  const cafeDineIn = settings?.dineInServingPolicy ?? "REQUIRE_PAYMENT_FIRST";
  const cafeTakeaway = settings?.takeawayServingPolicy ?? "REQUIRE_PAYMENT_FIRST";

  return {
    dineIn: branch.dineInServingPolicyOverride ?? cafeDineIn,
    takeaway: branch.takeawayServingPolicyOverride ?? cafeTakeaway,
    dineInInherited: branch.dineInServingPolicyOverride === null,
    takeawayInherited: branch.takeawayServingPolicyOverride === null,
  };
}

/** The policy governing one order type. */
export function policyForOrderType(
  policy: EffectiveServingPolicy,
  type: OrderType
): ServingPaymentPolicy {
  if (type === "DINE_IN") return policy.dineIn;
  if (type === "TAKEAWAY") return policy.takeaway;
  return DELIVERY_POLICY;
}

/** Whether this order must be settled before it may be marked SERVED. */
export async function requiresPaymentBeforeServing(
  branchId: string,
  type: OrderType
): Promise<boolean> {
  const policy = await getEffectiveServingPolicy(branchId);
  return policyForOrderType(policy, type) === "REQUIRE_PAYMENT_FIRST";
}
