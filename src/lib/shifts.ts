import { db } from "@/lib/db";

const round2 = (n: number) => Math.round(n * 100) / 100;

// The cashier's currently OPEN shift at a branch, or null. A cashier may
// only ever have one open shift per branch (enforced on open).
export async function getActiveShift(branchId: string, cashierId: string) {
  return db.shift.findFirst({
    where: { branchId, cashierId, status: "OPEN" },
    orderBy: { openedAt: "desc" },
  });
}

// Recompute a shift's aggregate figures from its linked payments (and the
// orders those payments belong to). Called after every payment / refund so
// the drawer numbers are always consistent — cheap and idempotent.
//
//   expectedCash = openingCash + cashSales − cashRefunds
//   totalSales   = cash + card + wallet (PAID only)
export async function recomputeShiftTotals(shiftId: string) {
  const shift = await db.shift.findUnique({ where: { id: shiftId } });
  if (!shift) return null;

  const payments = await db.payment.findMany({
    where: { shiftId },
    select: { amount: true, method: true, status: true, orderId: true },
  });

  let cash = 0,
    card = 0,
    wallet = 0,
    refunds = 0,
    cashRefunds = 0;
  const paidOrderIds = new Set<string>();

  for (const p of payments) {
    const amt = Number(p.amount);
    if (p.status === "PAID") {
      if (p.method === "CASH") cash += amt;
      else if (p.method === "CARD") card += amt;
      else if (p.method === "WALLET") wallet += amt;
      paidOrderIds.add(p.orderId);
    } else if (p.status === "REFUNDED") {
      refunds += amt;
      if (p.method === "CASH") cashRefunds += amt;
    }
  }

  // Discounts across the distinct orders paid within this shift.
  const orders = paidOrderIds.size
    ? await db.order.findMany({
        where: { id: { in: [...paidOrderIds] } },
        select: { discountAmount: true },
      })
    : [];
  const discounts = orders.reduce((s, o) => s + Number(o.discountAmount), 0);

  const totalSales = round2(cash + card + wallet);
  const expectedCash = round2(Number(shift.openingCashAmount) + cash - cashRefunds);

  return db.shift.update({
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
