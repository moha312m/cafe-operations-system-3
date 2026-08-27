// Which tender methods are their own settlement channel, and which are not.
//
// The milestone adds TenderReconciliation: a per-shift record of what the
// processor says settled against what the till says was taken. It is easy to
// read that as "one row per PaymentMethod" and wrong to build it that way,
// for two different reasons.
//
// CASH already has a single source of truth. The Shift close records the
// counted drawer, the expected drawer and the difference between them, and
// every cash report in the system reads it. A second cash actual/variance
// record in TenderReconciliation would not be a cross-check — it would be a
// second answer to a question that already has one, free to disagree with
// the first, with nothing in the schema saying which is authoritative. Cash
// tolerance is still configurable (see `resolveCashTolerance`); what is
// refused is a separate cash channel to reconcile.
//
// MIXED is not a settlement channel in the first place. It marks an order
// paid across more than one method, and each of those settlements is already
// a Payment row carrying its own real method. Reconciling "MIXED" would
// count the same money twice, under a label no processor ever settles.
//
// So the electronic channels are CARD and WALLET, and that list is stated
// once, here, rather than re-derived by each caller from the PaymentMethod
// enum — which is where CASH and MIXED would keep creeping back in.

import type { PaymentMethod } from "@prisma/client";

/** The tender methods that settle through an external processor. */
export const ELECTRONIC_TENDER_METHODS = ["CARD", "WALLET"] as const;

export type ElectronicTenderMethod = (typeof ELECTRONIC_TENDER_METHODS)[number];

/**
 * Methods that must never become a TenderReconciliation channel, with the
 * reason attached — a refusal that only says "invalid" invites the caller to
 * work around it.
 */
const NOT_A_CHANNEL: Record<string, string> = {
  CASH:
    "CASH is reconciled by the Shift cash close, which is its single source of " +
    "truth. A second cash actual/variance record would be a competing answer, " +
    "not a cross-check.",
  MIXED:
    "MIXED is a split-payment marker, not a settlement channel. Each part of a " +
    "mixed payment is already a Payment row under its own real method, so " +
    "reconciling MIXED would count the same money twice.",
};

/** Whether this method settles through a processor and so has its own channel. */
export function isElectronicTender(
  method: PaymentMethod
): method is ElectronicTenderMethod {
  return (ELECTRONIC_TENDER_METHODS as readonly string[]).includes(method);
}

/**
 * Narrow a method to a reconcilable channel, or refuse it.
 *
 * Every path that creates or configures a TenderReconciliation goes through
 * here, so "which methods have a channel" is decided in one place instead of
 * being re-litigated at each call site.
 */
export function assertReconcilableTender(
  method: PaymentMethod
): ElectronicTenderMethod {
  if (isElectronicTender(method)) return method;
  const why = NOT_A_CHANNEL[method];
  throw new Error(
    `${method} has no tender reconciliation channel. ${why ?? "Only CARD and WALLET settle through a processor."}`
  );
}

/**
 * Whether a tolerance rule may be written for this method.
 *
 * Wider than `assertReconcilableTender` by exactly one method, and the gap is
 * the point: CASH has a tolerance — the bound the Shift close compares its
 * drawer difference against — without having a channel of its own. MIXED has
 * neither.
 */
export function assertTenderToleranceMethod(
  method: PaymentMethod
): Exclude<PaymentMethod, "MIXED"> {
  if (method === "MIXED") {
    throw new Error(
      `A tolerance rule cannot be scoped to MIXED. ${NOT_A_CHANNEL.MIXED}`
    );
  }
  return method;
}
