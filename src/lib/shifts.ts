import { decimal, money, sumMoney } from "@/lib/money";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/api";
import { assertOpeningReady } from "@/lib/opening-readiness";

const round2 = money;

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
  message = "لا يمكن تحصيل الدفع بدون شيفت مفتوح",
  client: Prisma.TransactionClient | typeof db = db
) {
  const shift = await requireOperationalShift(branchId, userId, client);
  if (!shift) throw new ApiError(400, message);
  return shift;
}

// A counter enters independent cash and processor counts. Shift sales and
// variances belong to oversight, including after close; returning the sales
// subtotal would let the counter reconstruct expected cash from the opening
// float. Keep only the channel-presence flags needed to render count inputs.
export function redactBlindCount<T extends {
  totalCardSales: unknown;
  totalWalletSales: unknown;
}>(shift: T, canViewReports: boolean) {
  if (canViewReports) return shift;
  const visible: Record<string, unknown> = { ...shift };
  const cardSettlementRequired = Number(shift.totalCardSales) !== 0;
  const walletSettlementRequired = Number(shift.totalWalletSales) !== 0;
  for (const field of [
    "expectedCashAmount", "cashDifference", "cashWithinTolerance",
    "cashToleranceAmount", "cashVarianceCaseId", "totalSales",
    "totalCashSales", "totalCardSales", "totalWalletSales",
    "totalDiscounts", "totalRefunds", "totalCashPayouts", "orderCount",
    "tenderReconciliations",
  ]) {
    delete visible[field];
  }
  return { ...visible, cardSettlementRequired, walletSettlementRequired };
}

// The cashier's currently OPEN shift at a branch, or null. A cashier may
// only ever have one open shift per branch (enforced on open).
export async function getActiveShift(
  branchId: string,
  cashierId: string,
  client: Prisma.TransactionClient | typeof db = db
) {
  const shift = await client.shift.findFirst({
    where: { branchId, cashierId, status: "OPEN", custodyGateReason: null },
    orderBy: { openedAt: "desc" },
  });
  if (!shift) return null;
  try { await assertOpeningReady(client, { shiftId: shift.id, scope: 'OPERATIONS' }); }
  catch(error) { if(error instanceof ApiError && error.status === 400) return null; throw error; }
  return shift;
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
  if (shift) await assertOpeningReady(client, { shiftId: shift.id, scope: 'OPERATIONS' });
  return shift;
}

// Recompute a shift's aggregate figures from its linked payments (and the
// orders those payments belong to). Called after every payment / refund so
// the drawer numbers are always consistent — cheap and idempotent.
//
//   expectedCash = openingCash + net cash movements - supplier cash payouts
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
  //
  // AWAITING_HANDOVER is the same fact one stage earlier: the money was
  // settled and the drawer reconciled, and only the STOCK is still open.
  // A shift waiting on its handover must not have the figures it was
  // settled against rewritten underneath the custodian being discharged.
  if (shift.status === "CLOSED" || shift.status === "AWAITING_HANDOVER") {
    return shift;
  }

  const payments = await client.payment.findMany({
    where: { shiftId },
    select: {
      amount: true, method: true, type: true, status: true, orderId: true,
      reversalOfPaymentId: true,
      amendmentId: true,
    },
  });

  let cash = decimal(0),
    card = decimal(0),
    wallet = decimal(0),
    refunds = decimal(0);
  const paidOrderIds = new Set<string>();

  for (const p of payments) {
    const amt = decimal(p.amount);
    if (p.type === "REFUND") {
      // Money handed back out of this drawer. Amounts are magnitudes now, so
      // the outflow is subtracted explicitly rather than relying on a
      // negative value happening to be added.
      if (p.method === "CASH") cash = cash.minus(amt);
      else if (p.method === "CARD") card = card.minus(amt);
      else if (p.method === "WALLET") wallet = wallet.minus(amt);
      refunds = refunds.plus(amt);
      // The sale itself belongs to whichever period collected it, so a
      // refund never counts towards this period's order count.
    } else if (p.status === "PAID") {
      if (p.method === "CASH") cash = cash.plus(amt);
      else if (p.method === "CARD") card = card.plus(amt);
      else if (p.method === "WALLET") wallet = wallet.plus(amt);
      if (!p.amendmentId) paidOrderIds.add(p.orderId);
    } else if (p.status === "REFUNDED") {
      // Legacy shape: a collection reversed in period before refunds became
      // their own transaction. It never entered `cash` above, so it must not
      // be subtracted again — that double subtraction was SHIFT-001.
      // Disclosed as a refund only.
      refunds = refunds.plus(amt);
    }
  }

  // Discounts across the distinct orders paid within this shift.
  const orders = paidOrderIds.size
    ? await client.order.findMany({
        where: { id: { in: [...paidOrderIds] } },
        select: { discountAmount: true, revisions: { orderBy: {number:'asc'}, take:1, select:{before:true} } },
      })
    : [];
  const revisionDiscounts = await client.orderRevision.findMany({where:{postingShiftId:shiftId},select:{discountDelta:true}});
  const discounts = sumMoney([...orders.map(o => o.revisions.length ? String((o.revisions[0].before as {discountAmount:string}).discountAmount) : o.discountAmount),...revisionDiscounts.map(r=>r.discountDelta)]);

  // `cash` is already net of refunds posted to this shift — a REFUND row
  // subtracts once, above. Subtracting `refunds` here as well would remove the
  // same reversal twice and report a shortage the cashier never caused
  // (SHIFT-001).
  // Supplier payments handed out of this drawer leave it without being a
  // refund or a sale: they lower expected cash and nothing else.
  const payouts = await client.purchasePayment.aggregate({
    where: { shiftId, fundingSource: "DRAWER" },
    _sum: { amount: true },
  });
  const cashPayouts = money(payouts._sum.amount ?? 0);
  const totalSales = money(cash.plus(card).plus(wallet));
  const expectedCash = money(decimal(shift.openingCashAmount).plus(cash).minus(cashPayouts));

  return client.shift.update({
    where: { id: shiftId },
    data: {
      totalCashSales: round2(cash),
      totalCardSales: round2(card),
      totalWalletSales: round2(wallet),
      totalSales,
      totalRefunds: round2(refunds),
      totalCashPayouts: cashPayouts,
      totalDiscounts: round2(discounts),
      expectedCashAmount: expectedCash,
      orderCount: paidOrderIds.size,
    },
  });
}
