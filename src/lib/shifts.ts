import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/api";

const round2 = (n: number) => Math.round(n * 100) / 100;

// Cash custody gate for every transaction class that moves money into the
// register: POS collection, payment attached to order creation, and table
// settlement.
//
// Custody is deliberately NOT role-aware. Whether an actor MAY collect is
// authorization (checked by the route, before this); whether there is an open
// drawer to collect INTO is custody. Keying custody on `role === "CASHIER"`
// let owners and managers write payments with no shift, leaving that cash
// outside every drawer reconciliation (POS-001).
//
// Order creation without money is not a custody class and does not call this.
export async function requireCashCustody(
  branchId: string,
  userId: string,
  message = "لا يمكن تحصيل الدفع بدون شيفت مفتوح"
) {
  const shift = await requireOperationalShift(branchId, userId);
  if (!shift) throw new ApiError(400, message);
  return shift;
}

// Withhold the reconciliation target from whoever will physically count the
// drawer, so the count is independent evidence rather than a number typed to
// match (SHIFT-003).
//
// Keyed on custody, not role: the holder of an OPEN shift cannot see its
// expected cash. A supervisor looking at somebody else's shift is not the one
// counting it and keeps full visibility, and a CLOSED shift is settled
// history that stays readable to anyone authorised to read it.
//
// The count is revealed back to the holder by the close response, once the
// server has persisted it.
export function redactBlindCount<
  T extends { status: string; cashierId: string; expectedCashAmount: unknown },
>(shift: T, viewerId: string): T | Omit<T, "expectedCashAmount"> {
  if (shift.status !== "OPEN" || shift.cashierId !== viewerId) return shift;
  // Destructured off deliberately — the point is that the field never
  // reaches the caller, so the binding is meant to go unused.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { expectedCashAmount, ...rest } = shift;
  return rest;
}

// The cashier's currently OPEN shift at a branch, or null. A cashier may
// only ever have one open shift per branch (enforced on open).
export async function getActiveShift(
  branchId: string,
  cashierId: string,
  client: Prisma.TransactionClient | typeof db = db
) {
  return client.shift.findFirst({
    where: { branchId, cashierId, status: "OPEN", custodyGateReason: null },
    orderBy: { openedAt: "desc" },
  });
}

/** Return an open operational shift, rejecting a visibly-open but gated one. */
export async function requireOperationalShift(
  branchId: string,
  cashierId: string,
  client: Prisma.TransactionClient | typeof db = db
) {
  const shift = await client.shift.findFirst({
    where: { branchId, cashierId, status: "OPEN" },
    orderBy: { openedAt: "desc" },
  });
  if (shift?.custodyGateReason) {
    throw new ApiError(400, `Shift is awaiting custody: ${shift.custodyGateReason}`);
  }
  return shift;
}

// Recompute a shift's aggregate figures from its linked payments (and the
// orders those payments belong to). Called after every payment / refund so
// the drawer numbers are always consistent — cheap and idempotent.
//
//   expectedCash = openingCash + net cash movements
//   totalSales   = cash + card + wallet (PAID only)
//
// THIS IS THE AUTHORITATIVE EXPECTED-CASH ANSWER, and the only one. The cash
// close reconciles against what this returns rather than deriving the target
// again from payments, because two formulas would be two opinions with
// nothing in the schema saying which an owner should believe.
//
// `client` exists for exactly that caller. The close writes its snapshot, its
// variance case and its audit rows as one act, and the aggregates it
// reconciles against must be freshened inside that same transaction —
// otherwise a rolled-back close would leave the totals it recomputed
// committed, and the shift would carry an expected figure produced by an
// event that never happened. It defaults to `db`, so every existing
// fire-and-forget call site is unchanged.
export async function recomputeShiftTotals(
  shiftId: string,
  client: Prisma.TransactionClient | typeof db = db
) {
  const shift = await client.shift.findUnique({ where: { id: shiftId } });
  if (!shift) return null;
  // An accepted close is a historical snapshot. Recomputing a CLOSED shift
  // rewrote expectedCash while leaving the counted cash and stored
  // difference frozen, leaving the record contradicting itself (SHIFT-002).
  // Money moving after the close belongs to the current period instead.
  if (shift.status === "CLOSED") return shift;

  const payments = await client.payment.findMany({
    where: { shiftId },
    select: {
      amount: true, method: true, type: true, status: true, orderId: true,
      reversalOfPaymentId: true,
    },
  });

  let cash = 0,
    card = 0,
    wallet = 0,
    refunds = 0;
  const paidOrderIds = new Set<string>();

  for (const p of payments) {
    const amt = Number(p.amount);
    if (p.type === "REFUND") {
      // Money handed back out of this drawer. Amounts are magnitudes now, so
      // the outflow is subtracted explicitly rather than relying on a
      // negative value happening to be added.
      if (p.method === "CASH") cash -= amt;
      else if (p.method === "CARD") card -= amt;
      else if (p.method === "WALLET") wallet -= amt;
      refunds += amt;
      // The sale itself belongs to whichever period collected it, so a
      // refund never counts towards this period's order count.
    } else if (p.status === "PAID") {
      if (p.method === "CASH") cash += amt;
      else if (p.method === "CARD") card += amt;
      else if (p.method === "WALLET") wallet += amt;
      paidOrderIds.add(p.orderId);
    } else if (p.status === "REFUNDED") {
      // Legacy shape: a collection reversed in period before refunds became
      // their own transaction. It never entered `cash` above, so it must not
      // be subtracted again — that double subtraction was SHIFT-001.
      // Disclosed as a refund only.
      refunds += amt;
    }
  }

  // Discounts across the distinct orders paid within this shift.
  const orders = paidOrderIds.size
    ? await client.order.findMany({
        where: { id: { in: [...paidOrderIds] } },
        select: { discountAmount: true },
      })
    : [];
  const discounts = orders.reduce((s, o) => s + Number(o.discountAmount), 0);

  // `cash` is already net of refunds posted to this shift — a REFUND row
  // subtracts once, above. Subtracting `refunds` here as well would remove the
  // same reversal twice and report a shortage the cashier never caused
  // (SHIFT-001).
  const totalSales = round2(cash + card + wallet);
  const expectedCash = round2(Number(shift.openingCashAmount) + cash);

  return client.shift.update({
    where: { id: shiftId },
    data: {
      totalCashSales: round2(cash),
      totalCardSales: round2(card),
      totalWalletSales: round2(wallet),
      totalSales,
      totalRefunds: round2(refunds),
      totalDiscounts: round2(discounts),
      expectedCashAmount: expectedCash,
      orderCount: paidOrderIds.size,
    },
  });
}
