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
//   SALES REFUNDS refunds linked to recognized SERVED orders, including
//                 legacy refunded collections. Unserved refunds affect money
//                 movement only because no sale was recognized.
//   NET SALES     Gross Sales - Sales Refunds.
//   COLLECTIONS   money received: Payment.type = COLLECTION. This is NOT Net
//                 Sales — an order can be sold in one period and collected in
//                 another, and the two figures answer different questions.
//   NET MOVEMENT  Collections - Refunds. Useful, but never labelled Net Sales.
//
// Accounting is by transaction period. A refund belongs to the day it was
// issued, never to the day of the sale it reverses, so a day that only
// returned money for an earlier recognized sale legitimately reports negative
// Net Sales. A never-served refund does not reverse recognized sales.
//
// Nothing here reads meaning from the sign of an amount or treats
// `paymentStatus = PAID` as a sale.

import { db } from "@/lib/db";
import type { Prisma } from "@prisma/client";
import { decimal, money, sumMoney, type Decimal, type Numeric } from "@/lib/money";
import {reportEventWhere,type EventWindow} from './report-window-scope';
export function financialEventWhere(scope:FinancialScope,field='createdAt',viaOrder=false){return scope.windows?reportEventWhere(scope.windows,field,viaOrder):{[field]:scope.period};}

// Live order totals describe the latest bill. Recognition retains the original
// period and posts amendments in their own period. Refund rows are subtracted
// separately, so recognizedDelta already compensates for amendment refunds.
async function revisionRecognition(scope: FinancialScope) {
  const base=await db.orderRevision.findMany({where:{order:salesWhere(scope),before:{path:['status'],equals:'SERVED'}},select:{oldTotal:true,newTotal:true,order:{select:{source:true,createdById:true,approvedById:true}}}});
  const current=await db.orderRevision.findMany({where:{cafeId:scope.cafeId,...(scope.branchId?{branchId:scope.branchId}:{}),...financialEventWhere(scope)},select:{recognizedDelta:true,order:{select:{source:true,createdById:true,approvedById:true}}}});
  return [...base.map(r=>({order:r.order,amount:decimal(r.oldTotal).minus(r.newTotal)})),...current.map(r=>({order:r.order,amount:decimal(r.recognizedDelta)})),...await preServiceRefundBasis(scope)];
}

// Refunds made while a paid order was still preparing must remain in its first
// gross recognition; otherwise the revised price AND refund are deducted twice.
export async function preServiceRefundBasis(scope:FinancialScope){
 const revisions=await db.orderRevision.findMany({where:{order:salesWhere(scope),NOT:{before:{path:['status'],equals:'SERVED'}}},select:{amendmentId:true,orderId:true,order:{select:{source:true,createdById:true,approvedById:true}}}});
 if(!revisions.length)return [];
 const payments=await db.payment.findMany({where:{amendmentId:{in:revisions.map(r=>r.amendmentId)},type:'REFUND',status:'PAID'},select:{amendmentId:true,amount:true}});
 return revisions.map(r=>({orderId:r.orderId,order:r.order,amount:sumMoney(payments.filter(p=>p.amendmentId===r.amendmentId).map(p=>p.amount))}));
}

/** Canonical sale recognition. Sales exist only in this state. */
export const SALE_STATUS = "SERVED" as const;

export type Period = { gte: Date; lte?: Date; lt?: Date };

export type FinancialScope = {
  cafeId: string;
  /** Undefined means every branch the caller is allowed to see. */
  branchId?: string;
  period: Period;
  windows?:EventWindow[];
};

export type Financials = {
  grossSales: number;
  /** All money returned, including never-served orders. */
  refunds: number;
  salesRefunds: number;
  unservedRefunds: number;
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

// Sums stay Decimal; numbers appear only at the response boundary.
const r2 = (n: Numeric) => money(n).toNumber();

/** Orders that count as sales in this scope. */
export function salesWhere(scope: FinancialScope) {
  return {
    cafeId: scope.cafeId,
    ...(scope.branchId ? { branchId: scope.branchId } : {}),
    status: SALE_STATUS,
    ...financialEventWhere(scope),
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
    ...financialEventWhere(scope,'createdAt',true),
  };
}

/** Refund activity that reverses recognized sales, dated by the payment. */
export function salesRefundWhere(scope: FinancialScope): Prisma.PaymentWhereInput {
  return {
    AND: [
      movementWhere(scope),
      { order: { status: SALE_STATUS } },
      { OR: [{ type: "REFUND" }, { type: "COLLECTION", status: "REFUNDED" }] },
    ],
  };
}

/** Sales recognition and money movement, aggregated independently. */
export async function periodFinancials(scope: FinancialScope): Promise<Financials> {
  const [sales, movement, salesRefundMovement] = await Promise.all([
    db.order.aggregate({ where: salesWhere(scope), _sum: { total: true } }),
    db.payment.groupBy({
      by: ["type", "method", "status"],
      where: movementWhere(scope),
      _sum: { amount: true },
    }),
    db.payment.aggregate({ where: salesRefundWhere(scope), _sum: { amount: true } }),
  ]);

  const bucket = () => ({ CASH: decimal(0), CARD: decimal(0), WALLET: decimal(0), MIXED: decimal(0) });
  const collectedBy = bucket();
  const refundedBy = bucket();

  for (const row of movement) {
    const amt = decimal(row._sum.amount ?? 0);
    if (row.type === "REFUND") {
      refundedBy[row.method] = refundedBy[row.method].plus(amt);
    } else {
      // Money received. A collection later reversed in period under the old
      // model (status REFUNDED, no separate row) was still received, so it
      // belongs here — and is mirrored as a refund below so the two net out.
      collectedBy[row.method] = collectedBy[row.method].plus(amt);
      if (row.status === "REFUNDED") refundedBy[row.method] = refundedBy[row.method].plus(amt);
    }
  }

  const collections = sumMoney(Object.values(collectedBy));
  const refunds = sumMoney(Object.values(refundedBy));
  const salesRefunds = decimal(salesRefundMovement._sum.amount ?? 0);
  const recognition=await revisionRecognition(scope);
  const grossSales = decimal(sales._sum.total ?? 0).plus(sumMoney(recognition.map(r=>r.amount)));

  return {
    grossSales: r2(grossSales),
    refunds: r2(refunds),
    salesRefunds: r2(salesRefunds),
    unservedRefunds: r2(refunds.minus(salesRefunds)),
    netSales: r2(grossSales.minus(salesRefunds)),
    collections: r2(collections),
    netMoneyMovement: r2(collections.minus(refunds)),
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
 * Sales per employee, attributed to whoever made the sale. Only refunds of
 * recognized SERVED orders reduce selling performance; refund processing is
 * reported independently, including never-served orders.
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
      where: salesRefundWhere(scope),
      select: {
        amount: true,
        order: { select: { source: true, createdById: true, approvedById: true } },
      },
    }),
  ]);

  const totals = new Map<string, { gross: Decimal; refunds: Decimal; orders: number }>();
  const empty = () => ({ gross: decimal(0), refunds: decimal(0), orders: 0 });
  const add = (id: string, gross: Numeric, orders: number) => {
    const cur = totals.get(id) ?? empty();
    cur.gross = cur.gross.plus(decimal(gross));
    cur.orders += orders;
    totals.set(id, cur);
  };

  for (const row of byCreator) add(row.createdById!, row._sum.total ?? 0, row._count);
  for (const row of byApprover) add(row.approvedById!, row._sum.total ?? 0, row._count);
  for (const row of await revisionRecognition(scope)) {
    const seller=row.order.source==='QR_MENU'?row.order.approvedById:row.order.createdById;
    if(seller)add(seller,row.amount,0);
  }

  for (const row of refundRows) {
    const o = row.order;
    const owner = o?.source === "QR_MENU" ? o.approvedById : o?.createdById;
    // A sale whose owner cannot be determined (an unapproved QR order) is
    // deliberately left out rather than guessed at.
    if (!owner) continue;
    const cur = totals.get(owner) ?? empty();
    cur.refunds = cur.refunds.plus(row.amount);
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
      netSales: r2(v.gross.minus(v.refunds)),
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
      refunds: r2(r._sum.amount ?? 0),
      count: r._count,
    }))
    .sort((a, b) => b.refunds - a.refunds);
}
