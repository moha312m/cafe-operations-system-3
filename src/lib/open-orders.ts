import type { OrderStatus, PaymentStatus, Prisma } from "@prisma/client";
import { db } from "@/lib/db";

export const DEFAULT_STALE_ORDER_ALERT_HOURS = 2;
export const MAX_STALE_ORDER_ALERT_HOURS = 48;

/** Orders that still stand in the way of a handover close. */
export const OPEN_ORDER_STATUSES: OrderStatus[] = ["PENDING_WAITER_APPROVAL", "CONFIRMED", "PREPARING", "READY"];
const UNPAID: PaymentStatus[] = ["UNPAID", "PENDING_COLLECTION", "PARTIAL"];
const REF_LIMIT = 10;
const STALE_LIMIT = 30;

/** What a manager can do about a forgotten order, through the existing routes. */
export type StaleAction = "SERVE" | "CANCEL" | "APPROVE" | "COLLECT";

export type StaleOrder = {
  id: string;
  orderNumber: number;
  branchId: string;
  branchName: string;
  status: OrderStatus;
  paymentStatus: PaymentStatus;
  type: string;
  tableNumber: string | null;
  remaining: number;
  /** When the order last moved: ready, started, approved, served or created. */
  since: Date;
  actions: StaleAction[];
};

const remainingOf = (o: { total: unknown; paidAmount: unknown }) =>
  Math.max(0, Math.round((Number(o.total) - Number(o.paidAmount)) * 100) / 100);

function actionsFor(o: { status: OrderStatus; paymentStatus: PaymentStatus; paidAmount: unknown }): StaleAction[] {
  if (o.status === "PENDING_WAITER_APPROVAL") return ["APPROVE"];
  const actions: StaleAction[] = [];
  if (o.status === "READY") actions.push("SERVE");
  // Collected money cannot be cancelled away — the status route refuses it too.
  if ((o.status === "CONFIRMED" || o.status === "PREPARING") && Number(o.paidAmount) <= 0) actions.push("CANCEL");
  if (UNPAID.includes(o.paymentStatus)) actions.push("COLLECT");
  return actions;
}

/**
 * Open orders at a branch (or a café's branches) and the ones that have been
 * sitting long enough to count as forgotten. Read-only.
 */
export async function openOrdersSummary(args: {
  cafeId: string;
  branchId: string | null;
  staleMinutes: number;
  now?: Date;
}) {
  const now = args.now ?? new Date();
  const scope = { cafeId: args.cafeId, ...(args.branchId ? { branchId: args.branchId } : {}) };

  const [grouped, firstOpen] = await Promise.all([
    db.order.groupBy({
      by: ["status"],
      where: { ...scope, status: { in: OPEN_ORDER_STATUSES } },
      _count: { _all: true },
    }),
    db.order.findMany({
      where: { ...scope, status: { in: OPEN_ORDER_STATUSES } },
      select: { orderNumber: true },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: REF_LIMIT,
    }),
  ]);
  const byStatus = Object.fromEntries(grouped.map((g) => [g.status, g._count._all])) as Partial<Record<OrderStatus, number>>;
  const total = grouped.reduce((s, g) => s + g._count._all, 0);

  let stale: StaleOrder[] = [];
  let staleCount = 0;
  if (args.staleMinutes > 0) {
    const cutoff = new Date(now.getTime() - args.staleMinutes * 60_000);
    const staleWhere: Prisma.OrderWhereInput = {
      ...scope,
      OR: [
        // Not served yet, and nothing has happened to it since the cutoff.
        {
          status: { in: OPEN_ORDER_STATUSES },
          createdAt: { lt: cutoff },
          AND: [
            { OR: [{ readyAt: null }, { readyAt: { lt: cutoff } }] },
            { OR: [{ preparationStartedAt: null }, { preparationStartedAt: { lt: cutoff } }] },
            { OR: [{ approvedAt: null }, { approvedAt: { lt: cutoff } }] },
          ],
        },
        // Served long ago and still owing money.
        { status: "SERVED", paymentStatus: { in: UNPAID }, servedAt: { lt: cutoff } },
      ],
    };
    staleCount = await db.order.count({ where: staleWhere });
    const rows = await db.order.findMany({
      where: staleWhere,
      select: {
        id: true, orderNumber: true, branchId: true, status: true, paymentStatus: true, type: true,
        tableNumber: true, total: true, paidAmount: true, createdAt: true, approvedAt: true,
        preparationStartedAt: true, readyAt: true, servedAt: true,
        branch: { select: { name: true } },
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: STALE_LIMIT,
    });
    stale = rows.map((o) => ({
      id: o.id,
      orderNumber: o.orderNumber,
      branchId: o.branchId,
      branchName: o.branch.name,
      status: o.status,
      paymentStatus: o.paymentStatus,
      type: o.type,
      tableNumber: o.tableNumber,
      remaining: remainingOf(o),
      since: o.servedAt ?? o.readyAt ?? o.preparationStartedAt ?? o.approvedAt ?? o.createdAt,
      actions: actionsFor(o),
    }));
  }

  return {
    open: { total, byStatus, refs: firstOpen.map((o) => `#${o.orderNumber}`) },
    stale,
    staleCount,
  };
}
