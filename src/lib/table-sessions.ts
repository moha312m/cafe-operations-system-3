// ── Table session engine ─────────────────────────────────────────────
// A session opens automatically with the first dine-in order for a table
// and gathers every subsequent order until staff closes it. Totals are
// denormalised onto the session and recomputed after every change.

import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { auditInTransaction } from "@/lib/audit";

const round2 = (n: number) => Math.round(n * 100) / 100;

// Orders in these states never count towards the table bill.
const INACTIVE_ORDER_STATUSES = ["CANCELLED", "REJECTED", "PENDING_WAITER_APPROVAL"] as const;

// Recompute a session's denormalised totals from its orders/payments.
//
// The three figures answer different questions and must not be derived from
// each other:
//
// totalAmount     historical — what the table's active orders came to.
//                 Reporting reads this, so a refunded bill stays counted.
// paidAmount      money movement — collected minus returned, i.e. what the
//                 café is still holding against this table.
// remainingAmount current receivable — what the customer still owes.
//
// remaining is the sum of each order's own remainingAmount rather than
// `total - paid`. Only the order knows whether its balance is live: a full
// refund is terminal and settles the order at 0, a part-refund leaves the
// balance owed, and loyalty may have moved the total. Deriving it from a
// historical total against a net cash figure reopened refunded bills as a
// phantom balance and forced a manager override to close the table
// (REFUND-006).
export async function recomputeSessionTotals(
  sessionId: string,
  // Optional so every existing caller is unchanged; supplied when the
  // recompute has to commit or roll back with the writes around it.
  client: Prisma.TransactionClient | typeof db = db
) {
  const [orderAgg, payAgg] = await Promise.all([
    client.order.aggregate({
      where: { tableSessionId: sessionId, status: { notIn: [...INACTIVE_ORDER_STATUSES] } },
      _sum: { total: true, remainingAmount: true },
    }),
    // Collections and refunds are summed separately: a refund carries
    // status PAID too, so one aggregate would report money returned as
    // money collected (REFUND-005).
    client.payment.groupBy({
      by: ["type"],
      where: {
        status: "PAID",
        order: { tableSessionId: sessionId, status: { notIn: [...INACTIVE_ORDER_STATUSES] } },
      },
      _sum: { amount: true },
    }),
  ]);
  const total = round2(Number(orderAgg._sum.total ?? 0));
  const collected = payAgg
    .filter((r) => r.type !== "REFUND")
    .reduce((s, r) => s + Number(r._sum.amount ?? 0), 0);
  const returned = payAgg
    .filter((r) => r.type === "REFUND")
    .reduce((s, r) => s + Number(r._sum.amount ?? 0), 0);
  const paid = Math.max(round2(collected - returned), 0);
  const receivable = Math.max(round2(Number(orderAgg._sum.remainingAmount ?? 0)), 0);
  return client.tableSession.update({
    where: { id: sessionId },
    data: {
      totalAmount: total,
      paidAmount: paid,
      remainingAmount: receivable,
    },
  });
}

// Attach a freshly created dine-in order to its table's OPEN session,
// creating the session if this is the table's first order. Never creates
// a second open session for the same table (unique-by-lookup + retry-safe
// because callers run after the order exists).
export async function attachOrderToTableSession(order: {
  id: string;
  cafeId: string;
  branchId: string;
  type: string;
  tableNumber: string | null;
  orderNumber: number;
  customerName?: string | null;
}, actingUserId: string | null) {
  if (order.type !== "DINE_IN" || !order.tableNumber?.trim()) return null;
  const tableNumber = order.tableNumber.trim();

  // Opening the bill, joining the order to it, adopting the order's inline
  // payments and recomputing the totals are ONE act (R-POS-02A/A12).
  //
  // These were five sequential writes with no transaction, run after the
  // order had already been committed. A failure in the middle left states
  // nobody designed: an OPEN table session for a table nobody is sitting at,
  // holding the table and showing an empty bill; or an order joined to a
  // bill whose payments were never adopted, so the money sat in the drawer
  // total while the table showed it as unpaid.
  //
  // The audit rows are written through the same transaction, so a failure
  // takes them with it rather than leaving a record of something that did
  // not happen — the reason `auditInTransaction` exists.
  return db.$transaction(async (tx) => {
    let session = await tx.tableSession.findFirst({
      where: { cafeId: order.cafeId, branchId: order.branchId, tableNumber, status: "OPEN" },
    });

    let opened = false;
    if (!session) {
      session = await tx.tableSession.create({
        data: {
          cafeId: order.cafeId,
          branchId: order.branchId,
          tableNumber,
          status: "OPEN",
          openedByUserId: actingUserId,
          customerName: order.customerName ?? null,
        },
      });
      opened = true;
    }

    await tx.order.update({ where: { id: order.id }, data: { tableSessionId: session.id } });
    // Table-scoped payments (created inline with the POS order) inherit the id.
    await tx.payment.updateMany({
      where: { orderId: order.id, tableSessionId: null },
      data: { tableSessionId: session.id },
    });
    await recomputeSessionTotals(session.id, tx);

    if (opened) {
      await auditInTransaction(tx, {
        cafeId: order.cafeId, userId: actingUserId, action: "TABLE_SESSION_OPENED",
        entity: "TableSession", entityId: session.id,
        details: { branchId: order.branchId, tableSessionId: session.id, tableNumber, orderId: order.id, orderNumber: order.orderNumber },
      });
    }
    await auditInTransaction(tx, {
      cafeId: order.cafeId, userId: actingUserId, action: "TABLE_SESSION_ORDER_ADDED",
      entity: "TableSession", entityId: session.id,
      details: { branchId: order.branchId, tableSessionId: session.id, tableNumber, orderId: order.id, orderNumber: order.orderNumber },
    });

    return session;
  });
}

// Orders that still owe the customer something: confirmed, being made, or
// made and sitting on the pass. CANCELLED and REJECTED are finished with;
// PENDING_WAITER_APPROVAL has not joined the bill yet and is already outside
// the session's totals.
//
// Exported because closing a table and labelling one are the same question
// asked twice, and they must not drift apart.
export const BLOCKING_ORDER_STATUSES = ["CONFIRMED", "PREPARING", "READY"] as const;

export type SessionDisplayStatus =
  | "CLOSED"
  | "PENDING_COLLECTION"
  | "PARTIAL"
  | "AWAITING_HANDOVER"
  | "READY_TO_CLOSE"
  | "OCCUPIED";

// What the table's badge should say.
//
// This asks exactly what closing asks — is the bill settled, and has
// everything reached the customer — so the badge cannot promise something the
// close endpoint then refuses. `unservedOrders` is a required argument rather
// than an optional one precisely so a caller cannot quietly fall back to the
// money-only answer that caused a settled-but-still-cooking table to advertise
// itself as ready to close (POLICY-004).
//
// Nothing here is persisted: it is derived per request.
export function sessionDisplayStatus(
  s: { status?: string; totalAmount: unknown; paidAmount: unknown; remainingAmount: unknown },
  unservedOrders: number
): SessionDisplayStatus {
  if (s.status && s.status !== "OPEN") return "CLOSED";

  const total = Number(s.totalAmount);
  const paid = Number(s.paidAmount);
  const remaining = Number(s.remainingAmount);

  // Money outstanding is the louder problem and is reported first, even when
  // the kitchen is also still busy — it is the one that stops the customer
  // leaving.
  if (remaining > 0.001) {
    return paid > 0 ? "PARTIAL" : "PENDING_COLLECTION";
  }
  if (total > 0) {
    return unservedOrders > 0 ? "AWAITING_HANDOVER" : "READY_TO_CLOSE";
  }
  return "OCCUPIED";
}

/** Whether a table may be closed on the normal (non-override) path. */
export function isReadyToClose(
  s: { status?: string; totalAmount: unknown; paidAmount: unknown; remainingAmount: unknown },
  unservedOrders: number
): boolean {
  return sessionDisplayStatus(s, unservedOrders) === "READY_TO_CLOSE";
}
