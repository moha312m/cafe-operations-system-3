// ── Financial reporting semantics ────────────────────────────────────
// One place that knows what "sales" means, so the dashboard, the daily
// report and anything added later cannot drift apart.
//
// Sales and money movement answer different questions and come from
// different tables:
//
//   GROSS SALES   what was sold. Canonical recognition, unchanged by this
//                 module: Order.status = SERVED, dated Order.createdAt,
//                 valued Order.total (the amount actually charged, after the
//                 discount/tax rules already baked into that column). A
//                 refunded order still sold, so it still counts.
//   REFUNDS       money returned: Payment.type = REFUND.
//   NET SALES     Gross Sales - Refunds.
//   COLLECTIONS   money received: Payment.type = COLLECTION. This is NOT Net
//                 Sales — an order can be sold in one period and collected in
//                 another, and the two figures answer different questions.
//   NET MOVEMENT  Collections - Refunds. Useful, but never labelled Net Sales.
//
// Accounting is by transaction period. A refund belongs to the day it was
// issued, never to the day of the sale it reverses, so a day that only
// returned money legitimately reports negative Net Sales.
//
// Nothing here reads meaning from the sign of an amount or treats
// `paymentStatus = PAID` as a sale.

import { db } from "@/lib/db";

/** Canonical sale recognition. Sales exist only in this state. */
export const SALE_STATUS = "SERVED" as const;

export type Period = { gte: Date; lte?: Date; lt?: Date };

export type FinancialScope = {
  cafeId: string;
  /** Undefined means every branch the caller is allowed to see. */
  branchId?: string;
  period: Period;
};

export type Financials = {
  grossSales: number;
  refunds: number;
  netSales: number;
  collections: number;
  netMoneyMovement: number;
  cashCollections: number;
  cardCollections: number;
  walletCollections: number;
  cashRefunds: number;
  cardRefunds: number;
  walletRefunds: number;
};

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Orders that count as sales in this scope. */
export function salesWhere(scope: FinancialScope) {
  return {
    cafeId: scope.cafeId,
    ...(scope.branchId ? { branchId: scope.branchId } : {}),
    status: SALE_STATUS,
    createdAt: scope.period,
  };
}

/**
 * Payment rows in this scope. Branch is filtered through the order, matching
 * how the existing reports scope payments — Payment.branchId is nullable on
 * older rows and would silently drop them.
 */
export function movementWhere(scope: FinancialScope) {
  return {
    cafeId: scope.cafeId,
    ...(scope.branchId ? { order: { branchId: scope.branchId } } : {}),
    createdAt: scope.period,
  };
}

/**
 * The four headline figures, by database aggregation rather than by loading
 * rows: one aggregate over orders and one grouped aggregate over payments.
 */
export async function periodFinancials(scope: FinancialScope): Promise<Financials> {
  const [sales, movement] = await Promise.all([
    db.order.aggregate({ where: salesWhere(scope), _sum: { total: true } }),
    db.payment.groupBy({
      by: ["type", "method", "status"],
      where: movementWhere(scope),
      _sum: { amount: true },
    }),
  ]);

  const bucket = { CASH: 0, CARD: 0, WALLET: 0, MIXED: 0 };
  const collectedBy = { ...bucket };
  const refundedBy = { ...bucket };

  for (const row of movement) {
    const amt = Number(row._sum.amount ?? 0);
    if (row.type === "REFUND") {
      refundedBy[row.method] += amt;
    } else {
      // Money received. A collection later reversed in period under the old
      // model (status REFUNDED, no separate row) was still received, so it
      // belongs here — and is mirrored as a refund below so the two net out.
      collectedBy[row.method] += amt;
      if (row.status === "REFUNDED") refundedBy[row.method] += amt;
    }
  }

  const collections = r2(collectedBy.CASH + collectedBy.CARD + collectedBy.WALLET + collectedBy.MIXED);
  const refunds = r2(refundedBy.CASH + refundedBy.CARD + refundedBy.WALLET + refundedBy.MIXED);
  const grossSales = r2(Number(sales._sum.total ?? 0));

  return {
    grossSales,
    refunds,
    netSales: r2(grossSales - refunds),
    collections,
    netMoneyMovement: r2(collections - refunds),
    cashCollections: r2(collectedBy.CASH),
    cardCollections: r2(collectedBy.CARD),
    walletCollections: r2(collectedBy.WALLET),
    cashRefunds: r2(refundedBy.CASH),
    cardRefunds: r2(refundedBy.CARD),
    walletRefunds: r2(refundedBy.WALLET),
  };
}

export type StaffSales = {
  userId: string;
  name: string;
  grossSales: number;
  refunds: number;
  netSales: number;
  orders: number;
};

/**
 * Sales per employee, attributed to whoever made the sale.
 *
 * Ownership follows the model already used on screen (src/lib/order-staff.ts):
 * a WAITER or CASHIER_POS order belongs to its creator, a QR_MENU order to the
 * waiter who approved it. A refund reduces the ORIGINAL seller's figure rather
 * than charging it to whoever processed the refund — otherwise an employee who
 * merely handed money back appears to have sold a negative amount. Who
 * processed the refund is answered separately by refundsByActor().
 */
export async function salesByStaff(scope: FinancialScope): Promise<StaffSales[]> {
  const where = salesWhere(scope);

  const [byCreator, byApprover, refundRows] = await Promise.all([
    db.order.groupBy({
      by: ["createdById"],
      where: { ...where, source: { in: ["WAITER", "CASHIER_POS"] }, createdById: { not: null } },
      _sum: { total: true },
      _count: true,
    }),
    db.order.groupBy({
      by: ["approvedById"],
      where: { ...where, source: "QR_MENU", approvedById: { not: null } },
      _sum: { total: true },
      _count: true,
    }),
    // Refunds are rare next to sales, so resolving each back to its seller is
    // a small read rather than a scan.
    db.payment.findMany({
      where: { ...movementWhere(scope), type: "REFUND" },
      select: {
        amount: true,
        order: { select: { source: true, createdById: true, approvedById: true } },
      },
    }),
  ]);

  const totals = new Map<string, { gross: number; refunds: number; orders: number }>();
  const add = (id: string, gross: number, orders: number) => {
    const cur = totals.get(id) ?? { gross: 0, refunds: 0, orders: 0 };
    cur.gross += gross;
    cur.orders += orders;
    totals.set(id, cur);
  };

  for (const row of byCreator) add(row.createdById!, Number(row._sum.total ?? 0), row._count);
  for (const row of byApprover) add(row.approvedById!, Number(row._sum.total ?? 0), row._count);

  for (const row of refundRows) {
    const o = row.order;
    const owner = o?.source === "QR_MENU" ? o.approvedById : o?.createdById;
    // A sale whose owner cannot be determined (an unapproved QR order) is
    // deliberately left out rather than guessed at.
    if (!owner) continue;
    const cur = totals.get(owner) ?? { gross: 0, refunds: 0, orders: 0 };
    cur.refunds += Number(row.amount);
    totals.set(owner, cur);
  }

  if (totals.size === 0) return [];
  const users = await db.user.findMany({
    where: { id: { in: [...totals.keys()] } },
    select: { id: true, name: true },
  });
  const nameOf = new Map(users.map((u) => [u.id, u.name]));

  return [...totals.entries()]
    .map(([userId, v]) => ({
      userId,
      name: nameOf.get(userId) ?? "—",
      grossSales: r2(v.gross),
      refunds: r2(v.refunds),
      netSales: r2(v.gross - v.refunds),
      orders: v.orders,
    }))
    .sort((a, b) => b.netSales - a.netSales);
}

export type RefundActivity = {
  userId: string;
  name: string;
  refunds: number;
  count: number;
};

/**
 * Who processed refunds, kept apart from selling performance so the activity
 * stays auditable without turning into negative sales for that employee.
 */
export async function refundsByActor(scope: FinancialScope): Promise<RefundActivity[]> {
  const rows = await db.payment.groupBy({
    by: ["cashierId"],
    where: { ...movementWhere(scope), type: "REFUND", cashierId: { not: null } },
    _sum: { amount: true },
    _count: true,
  });
  if (rows.length === 0) return [];

  const users = await db.user.findMany({
    where: { id: { in: rows.map((r) => r.cashierId!) } },
    select: { id: true, name: true },
  });
  const nameOf = new Map(users.map((u) => [u.id, u.name]));

  return rows
    .map((r) => ({
      userId: r.cashierId!,
      name: nameOf.get(r.cashierId!) ?? "—",
      refunds: r2(Number(r._sum.amount ?? 0)),
      count: r._count,
    }))
    .sort((a, b) => b.refunds - a.refunds);
}
