import { hasPendingConsumption } from "@/lib/sale-consumption";
import { protectedTransaction, queueRefusalAudit, protectedContext } from "@/lib/protected-transaction";
import { acquireInventorySharedLocks, activeFreezeFor } from "@/lib/inventory-freeze";
import { recordDeferredDeduction } from "@/lib/deferred-deduction";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { assertOpeningReceiptEvidence } from "@/lib/opening-readiness";
import { requirePermission, requireKey, handleApiError, ApiError, resolveReadScope } from "@/lib/api";
import { auditInTransaction } from "@/lib/audit";
import { deductStockForOrder, auditDeduction, StockError } from "@/lib/stock-deduction";
import { recomputeSessionTotals } from "@/lib/table-sessions";
import { isOrderFullyPaid } from "@/lib/order-payments";
import { requiresPaymentBeforeServing } from "@/lib/serving-policy";
import { requestOwnerAction } from "@/lib/owner-action-approvals";
import type { OrderStatus } from "@prisma/client";
import type { StockAttributionSnapshot } from "@/lib/ledger";

class StockCustodyRequiredError extends ApiError {
  constructor(readonly branchId: string, readonly recovery: "RESUME_SHIFT" | "HANDOVER") {
    super(409, recovery === "HANDOVER"
      ? "عهدة المخزون على الفرع — أكمل التسليم والتحقق الافتتاحي قبل تسليم الطلب"
      : "عهدة المخزون غير مرتبطة بشيفت مسؤول — افتح أو استأنف شيفتك قبل تسليم الطلب");
  }
}

import { lockShifts, lockOrders, lockOrderPayments, lockTableSessions } from "@/lib/transaction-locks";

type Params = { params: Promise<{ id: string }> };

// Legal state machine for staff transitions. Approval/rejection of QR
// orders is NOT here — that goes through /approve and /reject, which
// enforce the orders:approve permission and record who decided.
const TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  PENDING_WAITER_APPROVAL: [], // only approve/reject endpoints may move it
  CONFIRMED: ["PREPARING", "CANCELLED"],
  PREPARING: ["READY", "CANCELLED"],
  READY: ["SERVED"],
  SERVED: [],
  CANCELLED: [],
  REJECTED: [],
};

const bodySchema = z.object({
  status: z.enum(["PREPARING", "READY", "SERVED", "CANCELLED"]),
  reason: z.string().trim().max(500).optional(),
}).strict();

export async function PATCH(request: NextRequest, { params }: Params) {
  try {
    const session = await requirePermission("orders:update-status");
    resolveReadScope(session);
    const { id } = await params;
    const { status, reason } = bodySchema.parse(await request.json());

    if (status === "CANCELLED") await requireKey("orders.request_owner_action");
    return await protectedTransaction(async (tx) => {
      let responsibleShiftId: string | null = null;
      if (status === "SERVED") {
        const candidate = await tx.order.findFirst({ where: { id, ...resolveReadScope(session) }, select: { branchId: true } });
      if (!candidate) throw new ApiError(404, "الطلب مش موجود");
        const custody = await tx.custodyPeriod.findFirst({ where: { branchId: candidate.branchId, scope: "STOCK", status: "OPEN" }, select: { responsibleShiftId: true } });
        responsibleShiftId = custody?.responsibleShiftId ?? null;
        if (responsibleShiftId) await lockShifts(tx, [responsibleShiftId]);
      }
      await lockOrders(tx, [id]);
      await lockOrderPayments(tx, [id]);
      const order = await tx.order.findFirst({
        where: { id, ...resolveReadScope(session) },
        // Every payment row on the order, because "how much is collected" is
        // collections less refunds — filtering to status PAID alone would count
        // a refund as money received (REFUND-005).
        include: { payments: true },
      });
      if (!order) throw new ApiError(404, "الطلب مش موجود");
      if (session.role !== "SUPER_ADMIN" && order.cafeId !== session.cafeId) {
        throw new ApiError(403, "ليس لديك صلاحية لتنفيذ هذا الإجراء");
      }
      if (session.branchId && order.branchId !== session.branchId) {
        throw new ApiError(403, "الطلب تبع فرع تاني");
      }

      if (!(status === "SERVED" && order.status === "SERVED") && !TRANSITIONS[order.status].includes(status)) {
        throw new ApiError(400, "الحالة دي مش مسموحة للطلب في وضعه الحالي");
      }
      if (status === "CANCELLED") {
        const actor = session;
        if (!reason || reason.trim().length < 3) throw new ApiError(400, "اكتب سبب إلغاء الطلب في ٣ حروف على الأقل");
        const approval = await requestOwnerAction({
          actor, action: "CANCEL_ORDER", orderId: id, reason, idempotencyKey: crypto.randomUUID(),
        }, tx);
        return NextResponse.json({ request: { id: approval.requestId, status: approval.status, amount: approval.amount } }, { status: 202 });
      }
      // Whether an unpaid order may reach the customer is the owner's decision,
      // set per order type and resolved from the branch's effective policy —
      // never from anything the caller sends. A café with table service serves
      // first and bills after; a takeaway counter does not.
      if (status === "SERVED" && order.status !== "SERVED") {
        const mustBePaid = await requiresPaymentBeforeServing(order.branchId, order.type, tx);
        if (mustBePaid && !isOrderFullyPaid({ total: order.total, payments: order.payments })) {
          throw new ApiError(400, "لازم الطلب يتدفع بالكامل قبل التسليم");
        }
      }

      if (order.tableSessionId) await lockTableSessions(tx, [order.tableSessionId]);
      const now = new Date();
      const timeline =
        status === "PREPARING"
          ? { preparationStartedAt: now }
          : status === "READY"
            ? { readyAt: now }
            : status === "SERVED"
              ? { servedAt: now, completedAt: now }
              : {};

      // Item-level kitchen status mirrors the order status for now
      // (item-by-item tracking is prepared in the schema for later).
      const itemKitchenStatus =
        status === "PREPARING"
          ? "PREPARING"
          : status === "READY"
            ? "READY"
            : status === "SERVED"
              ? "SERVED"
              : status === "CANCELLED"
                ? "CANCELLED"
                : null;

      // Deduction and its audit share this transaction.
      let deduction: Awaited<ReturnType<typeof deductStockForOrder>> | null = null;
      let stockDeferred = false;

      let updated;
      let servedReplay = false;
      try {
        updated = await (async () => {
          if (status === "SERVED") {
            // Money and order locks precede inventory in both serving and closing.
            await acquireInventorySharedLocks(tx, [order.branchId]);
            const lockedOrder = await tx.order.findUniqueOrThrow({
              where: { id },
              include: { payments: true },
            });

            if (lockedOrder.status === "SERVED") {
              servedReplay = true;
              return tx.order.findUniqueOrThrow({
                where: { id },
                include: {
                  items: { include: { addOns: true } },
                  payments: true,
                  branch: { select: { id: true, name: true } },
                  createdBy: { select: { id: true, name: true } },
                },
              });
            }
            if (!TRANSITIONS[lockedOrder.status].includes(status)) {
          throw new ApiError(400, "مينفعش تغيّر حالة الطلب من حالته الحالية");
            }

            const custodyRows = await tx.$queryRaw<{
              id: string;
              holderType: "USER" | "BRANCH";
              responsibleShiftId: string | null;
            }[]>`SELECT "id", "holderType", "responsibleShiftId" FROM "CustodyPeriod" WHERE "branchId"=${lockedOrder.branchId} AND "cafeId"=${lockedOrder.cafeId} AND "scope"='STOCK' AND "status"='OPEN' FOR UPDATE`;
            protectedContext(tx).trace.push({ entity: "CustodyPeriod", ids: custodyRows.map(row => row.id), mode: "FOR UPDATE" });
            const custody = custodyRows[0];
            if (!custody || custody.holderType !== "USER" || !custody.responsibleShiftId) {
              throw new StockCustodyRequiredError(lockedOrder.branchId, custody?.holderType === "BRANCH" ? "HANDOVER" : "RESUME_SHIFT");
            }
        if (custody.responsibleShiftId !== responsibleShiftId) throw new ApiError(409, "مسؤولية المخزون اتغيرت — جرّب التسليم تاني");
            await assertOpeningReceiptEvidence(tx, custody.responsibleShiftId);
            const attribution: StockAttributionSnapshot = {
              custodyPeriodId: custody.id,
              shiftId: custody.responsibleShiftId,
            };
            // An order carried across a handover while it was being made had
            // its recipe deducted then, against the outgoing custody. Serving it
            // records who served it and moves no stock a second time.
            const preDeducted = !await hasPendingConsumption(tx, id);
            // While a handover count holds the shelf frozen nothing may move, so
            // the order is served and its recipe deducted when the freeze lifts.
            const freeze = preDeducted ? null : await activeFreezeFor(tx, lockedOrder.branchId);
            const servedTimeline = { servedAt: now, completedAt: now };
            if (freeze) {
              await recordDeferredDeduction(tx, {
                cafeId: lockedOrder.cafeId,
                branchId: lockedOrder.branchId,
                orderId: id,
                orderNumber: lockedOrder.orderNumber,
                freeze,
                servedById: session.id,
                servedAt: now,
              });
              stockDeferred = true;
            } else if (!preDeducted) {
              deduction = await deductStockForOrder(tx, id, session.id, attribution);
            }
            await tx.orderItem.updateMany({
              where: { orderId: id, kitchenStatus: { not: "CANCELLED" } },
              data: { kitchenStatus: "SERVED" },
            });
            return tx.order.update({
              where: { id },
              data: {
                status: "SERVED",
                ...servedTimeline,
                servedById: session.id,
                servedStockCustodyPeriodId: custody.id,
                servedShiftId: custody.responsibleShiftId,
              },
              include: {
                items: { include: { addOns: true } },
                payments: true,
                branch: { select: { id: true, name: true } },
                createdBy: { select: { id: true, name: true } },
              },
            });
          }
          if (itemKitchenStatus) {
            await tx.orderItem.updateMany({
              where: { orderId: id, kitchenStatus: { not: "CANCELLED" } },
              data: { kitchenStatus: itemKitchenStatus },
            });
          }
          // Auto-deduct ingredients on SERVED. Throws on insufficient
          // stock (unless the cafe allows negative) → rolls back the whole
          // transition so the order is NOT marked served.
          const timelineExtra: { stockDeductedAt?: Date } = {};
          return tx.order.update({
            where: { id },
            data: { status, ...timeline, ...timelineExtra },
            include: {
              items: { include: { addOns: true } },
              payments: true,
              branch: { select: { id: true, name: true } },
              createdBy: { select: { id: true, name: true } },
            },
          });
        })();
      } catch (e) {
        if (e instanceof StockError) {
          queueRefusalAudit(tx, {
            cafeId: order.cafeId,
            userId: session.id,
            action: "STOCK_DEDUCTION_FAILED",
            entity: "Order",
            entityId: id,
            details: { orderNumber: order.orderNumber, reason: e.message },
          });
          throw new ApiError(400, e.message);
        }
        throw e;
      }

      if (servedReplay) return NextResponse.json({ order: updated });

      // Cancellations change the table bill — keep the session totals fresh.
      if (order.tableSessionId) {
        await recomputeSessionTotals(order.tableSessionId, tx);
      }

      if (deduction) {
        await auditDeduction(
          order.cafeId,
          order.branchId,
          session.id,
          id,
          order.orderNumber,
          deduction, tx
        );
      }

      const AUDIT_ACTIONS: Record<string, string> = {
        PREPARING: "ORDER_PREPARATION_STARTED",
        READY: "ORDER_READY",
        SERVED: "ORDER_SERVED",
        CANCELLED: "ORDER_CANCELLED",
      };
      await auditInTransaction(tx, {
        cafeId: order.cafeId,
        userId: session.id,
        action: AUDIT_ACTIONS[status] ?? "ORDER_STATUS_CHANGED",
        entity: "Order",
        entityId: id,
        details: {
          from: order.status,
          to: status,
          orderNumber: order.orderNumber,
          branchId: order.branchId,
        },
      });

      return NextResponse.json(stockDeferred ? { order: updated, stockDeferred: true } : { order: updated });
    }, resolveReadScope(session));
  } catch (error) {
    if (error instanceof StockCustodyRequiredError) {
      return NextResponse.json({ error: error.message, code: "STOCK_CUSTODY_REQUIRED", branchId: error.branchId, recovery: error.recovery }, { status: error.status });
    }
    return handleApiError(error);
  }
}
