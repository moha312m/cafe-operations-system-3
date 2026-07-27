// ── Table session engine ─────────────────────────────────────────────
// A session opens automatically with the first dine-in order for a table
// and gathers every subsequent order until staff closes it. Totals are
// denormalised onto the session and recomputed after every change.

import { db } from "@/lib/db";
import { audit } from "@/lib/audit";

const round2 = (n: number) => Math.round(n * 100) / 100;

// Orders in these states never count towards the table bill.
const INACTIVE_ORDER_STATUSES = ["CANCELLED", "REJECTED", "PENDING_WAITER_APPROVAL"] as const;

// Recompute a session's denormalised totals from its orders/payments.
// totalAmount   = active orders' totals
// paidAmount    = PAID payments on those orders (refunds drop out)
// remaining     = total - paid (clamped at 0)
export async function recomputeSessionTotals(sessionId: string) {
  const [orderAgg, payAgg] = await Promise.all([
    db.order.aggregate({
      where: { tableSessionId: sessionId, status: { notIn: [...INACTIVE_ORDER_STATUSES] } },
      _sum: { total: true },
    }),
    db.payment.aggregate({
      where: {
        status: "PAID",
        order: { tableSessionId: sessionId, status: { notIn: [...INACTIVE_ORDER_STATUSES] } },
      },
      _sum: { amount: true },
    }),
  ]);
  const total = round2(Number(orderAgg._sum.total ?? 0));
  const paid = round2(Number(payAgg._sum.amount ?? 0));
  return db.tableSession.update({
    where: { id: sessionId },
    data: {
      totalAmount: total,
      paidAmount: paid,
      remainingAmount: Math.max(round2(total - paid), 0),
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

  let session = await db.tableSession.findFirst({
    where: { cafeId: order.cafeId, branchId: order.branchId, tableNumber, status: "OPEN" },
  });

  let opened = false;
  if (!session) {
    session = await db.tableSession.create({
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

  await db.order.update({ where: { id: order.id }, data: { tableSessionId: session.id } });
  // Table-scoped payments (created inline with the POS order) inherit the id.
  await db.payment.updateMany({
    where: { orderId: order.id, tableSessionId: null },
    data: { tableSessionId: session.id },
  });
  await recomputeSessionTotals(session.id);

  if (opened) {
    await audit({
      cafeId: order.cafeId, userId: actingUserId, action: "TABLE_SESSION_OPENED",
      entity: "TableSession", entityId: session.id,
      details: { branchId: order.branchId, tableSessionId: session.id, tableNumber, orderId: order.id, orderNumber: order.orderNumber },
    });
  }
  await audit({
    cafeId: order.cafeId, userId: actingUserId, action: "TABLE_SESSION_ORDER_ADDED",
    entity: "TableSession", entityId: session.id,
    details: { branchId: order.branchId, tableSessionId: session.id, tableNumber, orderId: order.id, orderNumber: order.orderNumber },
  });

  return session;
}

// Derived display status for a session card.
export function sessionDisplayStatus(s: { totalAmount: unknown; paidAmount: unknown; remainingAmount: unknown }) {
  const total = Number(s.totalAmount);
  const paid = Number(s.paidAmount);
  const remaining = Number(s.remainingAmount);
  if (total > 0 && remaining <= 0.001) return "READY_TO_CLOSE" as const;
  if (paid > 0 && remaining > 0) return "PARTIAL" as const;
  if (total > 0) return "PENDING_COLLECTION" as const;
  return "OCCUPIED" as const;
}
