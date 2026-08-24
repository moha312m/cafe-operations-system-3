// ── Collection semantics for an order's payment rows ─────────────────
//
// `Payment.status` describes where a row sits in its lifecycle;
// `Payment.type` describes what it MEANS. A refund is money out recorded as
// `type: REFUND, status: PAID` with a positive amount, so any calculation
// that asks "how much has been collected?" by filtering on `status: "PAID"`
// alone counts a refund as income (REFUND-005).
//
// This is the one place that answers that question for an order, so the
// kitchen screen and the orders screen cannot drift apart on what "paid"
// means, and so the rule can be tested at all.

export type PaymentLike = {
  // Structural rather than importing Prisma's Decimal, so this stays usable
  // from client components without dragging the Prisma types into the bundle.
  amount: string | number | { toString(): string };
  type?: string | null;
  status?: string | null;
};

/**
 * Money standing in hand for these rows: collections, less anything returned.
 *
 * Three shapes exist and all three are handled here rather than at each call
 * site:
 *   • COLLECTION / PAID      — money received                    (+)
 *   • REFUND                 — money returned                    (−)
 *   • COLLECTION / REFUNDED  — legacy in-period reversal, where the original
 *                              row was flipped instead of a refund row being
 *                              written. Never money in hand.     (0)
 */
export function collectedAmount(payments: PaymentLike[]): number {
  const net = payments.reduce((sum, p) => {
    const amount = Number(p.amount);
    if (!Number.isFinite(amount)) return sum;
    if (p.type === "REFUND") return sum - amount;
    // Rows still awaiting collection, cancelled, or reversed in period are
    // not money in hand.
    if (p.status !== "PAID") return sum;
    return sum + amount;
  }, 0);
  return Math.round(net * 100) / 100;
}

/** Whether an order's own payment rows cover its total. */
export function isOrderFullyPaid(order: {
  total: string | number | { toString(): string };
  payments: PaymentLike[];
}): boolean {
  return collectedAmount(order.payments) + 0.001 >= Number(order.total);
}
