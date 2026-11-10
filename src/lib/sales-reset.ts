import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { auditInTransaction } from "@/lib/audit";
import { round2, round3 } from "@/lib/costing";
import { decimal, money } from "@/lib/money";
import { drawerExpected, expenseAggregate } from "@/lib/expense-rules";
import { recomputeSessionTotals } from "@/lib/table-sessions";

export type SalesResetScope = {
  cafeId: string;
  branchId?: string | null;
  from?: string | null;
  to?: string | null;
  resetAll?: boolean;
};

export type RestoredItemPreview = {
  id: string;
  name: string;
  unit: string;
  quantity: number;
  branchId: string;
};

export type SalesResetPreview = {
  orderCount: number;
  totalAmount: number;
  paidAmount: number;
  itemsToRestore: RestoredItemPreview[];
  affectedShiftCount: number;
  orderIds: string[];
};

export type ExecuteSalesResetArgs = SalesResetScope & {
  actorId: string;
  reason?: string | null;
};

export type ExecuteSalesResetResult = {
  success: boolean;
  orderCount: number;
  totalAmount: number;
  paidAmount: number;
  restoredItemsCount: number;
  itemsRestored: RestoredItemPreview[];
  affectedShiftCount: number;
};

/**
 * Validates the confirmation phrase required to trigger a sales reset.
 * Must match either "تصفير المبيعات" or "RESET" (trimmed, case-insensitive for RESET).
 */
export function validateConfirmationPhrase(phrase?: string | null): boolean {
  if (!phrase) return false;
  const trimmed = phrase.trim();
  return trimmed === "تصفير المبيعات" || trimmed.toUpperCase() === "RESET";
}

/**
 * Parses from and to date strings into a Prisma DateTime filter.
 * When `to` is a date (YYYY-MM-DD), it expands to the end of the day.
 */
export function parseDateFilter(
  from?: string | null,
  to?: string | null
): { gte?: Date; lte?: Date } | undefined {
  const filter: { gte?: Date; lte?: Date } = {};
  if (from && from.trim()) {
    const f = new Date(from.trim());
    if (!isNaN(f.getTime())) {
      filter.gte = f;
    }
  }
  if (to && to.trim()) {
    const t = new Date(to.trim());
    if (!isNaN(t.getTime())) {
      if (to.trim().length === 10) {
        // YYYY-MM-DD -> set to end of that day (23:59:59.999 UTC)
        t.setUTCHours(23, 59, 59, 999);
      }
      filter.lte = t;
    }
  }
  return Object.keys(filter).length > 0 ? filter : undefined;
}

/**
 * Pure helper to aggregate restored quantities per inventory item from consumption transactions.
 */
export function aggregateRestoredInventory(
  transactions: Array<{
    quantity: Prisma.Decimal | number | string;
    inventoryItemId: string;
    inventoryItem?: {
      id: string;
      name: string;
      unit: string;
      branchId: string;
    } | null;
  }>
): RestoredItemPreview[] {
  const map = new Map<string, RestoredItemPreview>();

  for (const txn of transactions) {
    const rawQty = Number(txn.quantity);
    // Deductions have negative quantity; we restore the absolute value
    if (rawQty >= 0) continue;
    const qty = Math.abs(rawQty);

    const itemId = txn.inventoryItemId;
    const name = txn.inventoryItem?.name ?? itemId;
    const unit = txn.inventoryItem?.unit ?? "PIECE";
    const branchId = txn.inventoryItem?.branchId ?? "";

    const existing = map.get(itemId);
    if (existing) {
      existing.quantity = round3(existing.quantity + qty);
    } else {
      map.set(itemId, {
        id: itemId,
        name,
        unit,
        quantity: round3(qty),
        branchId,
      });
    }
  }

  return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Builds the Order where clause from the reset scope.
 */
export function buildOrderScopeWhere(scope: SalesResetScope): Prisma.OrderWhereInput {
  const where: Prisma.OrderWhereInput = {
    cafeId: scope.cafeId,
  };

  if (scope.branchId && scope.branchId !== "ALL") {
    where.branchId = scope.branchId;
  }

  if (scope.resetAll) {
    return where;
  }

  const dateFilter = parseDateFilter(scope.from, scope.to);
  if (dateFilter) {
    where.createdAt = dateFilter;
  } else {
    // Safety guard: In period mode without valid dates, never silently match all orders
    where.id = "__NO_MATCH_PERIOD_WITHOUT_DATES__";
  }

  return where;
}

/**
 * Previews what orders, monetary totals, raw inventory items, and shifts
 * would be affected by a sales reset under the given scope.
 */
export async function previewSalesReset(
  scope: SalesResetScope,
  client: Prisma.TransactionClient | typeof db = db
): Promise<SalesResetPreview> {
  const where = buildOrderScopeWhere(scope);

  const orders = await client.order.findMany({
    where,
    select: {
      id: true,
      total: true,
      paidAmount: true,
      saleShiftId: true,
      servedShiftId: true,
      branchId: true,
    },
  });

  if (orders.length === 0) {
    return {
      orderCount: 0,
      totalAmount: 0,
      paidAmount: 0,
      itemsToRestore: [],
      affectedShiftCount: 0,
      orderIds: [],
    };
  }

  const orderIds = orders.map((o) => o.id);
  const totalAmount = round2(
    orders.reduce((acc, o) => acc + Number(o.total ?? 0), 0)
  );
  const paidAmount = round2(
    orders.reduce((acc, o) => acc + Number(o.paidAmount ?? 0), 0)
  );

  // Fetch consumption inventory transactions (where quantity < 0)
  const deductions = await client.inventoryTransaction.findMany({
    where: {
      cafeId: scope.cafeId,
      orderId: { in: orderIds },
      quantity: { lt: 0 },
    },
    include: {
      inventoryItem: {
        select: { id: true, name: true, unit: true, branchId: true },
      },
    },
  });

  const itemsToRestore = aggregateRestoredInventory(deductions);

  // Collect affected shifts
  const shiftIds = new Set<string>();
  for (const o of orders) {
    if (o.saleShiftId) shiftIds.add(o.saleShiftId);
    if (o.servedShiftId) shiftIds.add(o.servedShiftId);
  }

  const payments = await client.payment.findMany({
    where: {
      orderId: { in: orderIds },
      shiftId: { not: null },
    },
    select: { shiftId: true },
  });

  for (const p of payments) {
    if (p.shiftId) shiftIds.add(p.shiftId);
  }

  return {
    orderCount: orders.length,
    totalAmount,
    paidAmount,
    itemsToRestore,
    affectedShiftCount: shiftIds.size,
    orderIds,
  };
}

/**
 * Atomically executes the sales reset and inventory restoration:
 * 1. Fetches all matching orders
 * 2. Aggregates inventory deductions and restores InventoryItem.currentStock & advances ledgerVersion
 * 3. Records an ADJUSTMENT InventoryTransaction for each restored item
 * 4. Cleans up dependent child records (DeferredStockDeduction, OrderItem, Payment, etc.)
 * 5. Deletes Order records
 * 6. Recalculates affected Shift totals (cash/card/wallet/discounts/expectedCash)
 * 7. Recomputes or cleans up affected TableSession records
 * 8. Records AuditLog entry
 */
export async function executeSalesResetInTransaction(
  tx: Prisma.TransactionClient,
  args: ExecuteSalesResetArgs
): Promise<ExecuteSalesResetResult> {
  // Allow administrative sales reset to clean up append-only OrderTrace and OrderRevision
  try {
    await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica';`);
  } catch {
    // Continue if running on SQLite or driver without raw query support
  }

  const where = buildOrderScopeWhere(args);

      const orders = await tx.order.findMany({
        where,
        select: {
          id: true,
          total: true,
          paidAmount: true,
          saleShiftId: true,
          servedShiftId: true,
          branchId: true,
          tableSessionId: true,
        },
      });

      if (orders.length === 0) {
        return {
          success: true,
          orderCount: 0,
          totalAmount: 0,
          paidAmount: 0,
          restoredItemsCount: 0,
          itemsRestored: [],
          affectedShiftCount: 0,
        };
      }

      const orderIds = orders.map((o) => o.id);
      const totalAmount = round2(
        orders.reduce((acc, o) => acc + Number(o.total ?? 0), 0)
      );
      const paidAmount = round2(
        orders.reduce((acc, o) => acc + Number(o.paidAmount ?? 0), 0)
      );

      // 1. Find consumption inventory transactions
      const deductions = await tx.inventoryTransaction.findMany({
        where: {
          cafeId: args.cafeId,
          orderId: { in: orderIds },
          quantity: { lt: 0 },
        },
        include: {
          inventoryItem: {
            select: { id: true, name: true, unit: true, branchId: true },
          },
        },
      });

      const itemsToRestore = aggregateRestoredInventory(deductions);

      // 2. Restore currentStock on each affected InventoryItem & create ledger row
      for (const item of itemsToRestore) {
        const updatedItem = await tx.inventoryItem.update({
          where: { id: item.id },
          data: {
            currentStock: { increment: item.quantity },
            ledgerVersion: { increment: 1 },
          },
          select: { ledgerVersion: true, branchId: true, costPerUnit: true },
        });

        const hasCost =
          updatedItem.costPerUnit !== null &&
          updatedItem.costPerUnit !== undefined;
        const totalCost = hasCost
          ? round2(Number(updatedItem.costPerUnit) * item.quantity)
          : null;

        await tx.inventoryTransaction.create({
          data: {
            cafeId: args.cafeId,
            branchId: updatedItem.branchId,
            inventoryItemId: item.id,
            type: "ADJUSTMENT",
            quantity: item.quantity,
            unitCost: updatedItem.costPerUnit ?? null,
            totalCost,
            note: "استرجاع مخزون بعد تصفير مبيعات تجريبية",
            createdById: args.actorId,
            itemVersion: updatedItem.ledgerVersion,
          },
        });
      }

      // 3. Find payments and affected shifts / table sessions before deleting
      const payments = await tx.payment.findMany({
        where: { orderId: { in: orderIds } },
        select: {
          id: true,
          shiftId: true,
          amount: true,
          method: true,
          type: true,
          status: true,
        },
      });

      const affectedShiftIds = [
        ...new Set([
          ...orders.flatMap((o) => [o.saleShiftId, o.servedShiftId]),
          ...payments.map((p) => p.shiftId),
        ].filter((id): id is string => Boolean(id))),
      ];

      const affectedTableSessionIds = [
        ...new Set(
          orders
            .map((o) => o.tableSessionId)
            .filter((id): id is string => Boolean(id))
        ),
      ];

      // 4. Delete related / child records in safe dependency order
      // a. FinishedGoodsReturn
      await tx.finishedGoodsReturn.deleteMany({
        where: { orderId: { in: orderIds } },
      });

      // b. Unlink finished stock transaction and snapshot on OrderItem
      await tx.orderItem.updateMany({
        where: { orderId: { in: orderIds } },
        data: {
          finishedStockTransactionId: null,
          finishedStockCafeId: null,
          finishedStockBranchId: null,
        },
      });

      // c. Delete USAGE InventoryTransaction rows for these orders
      await tx.inventoryTransaction.deleteMany({
        where: { orderId: { in: orderIds } },
      });

      // d. DeferredStockDeduction
      await tx.deferredStockDeduction.deleteMany({
        where: { orderId: { in: orderIds } },
      });

      // e. HandoverCarriedOrder
      await tx.handoverCarriedOrder.deleteMany({
        where: { orderId: { in: orderIds } },
      });

      // f. LoyaltyTransaction
      await tx.loyaltyTransaction.deleteMany({
        where: { orderId: { in: orderIds } },
      });

      // g. Gather order items and payments for OwnerActionRequest cleanup
      const orderItems = await tx.orderItem.findMany({
        where: { orderId: { in: orderIds } },
        select: { id: true },
      });
      const orderItemIds = orderItems.map((i) => i.id);
      const paymentIds = payments.map((p) => p.id);

      const amendments = await tx.orderAmendment.findMany({
        where: { orderId: { in: orderIds } },
        select: { id: true },
      });
      const amendmentIds = amendments.map((a) => a.id);

      // Clean up OwnerActionRequest referencing these orders, items, payments, or amendments
      await tx.ownerActionRequest.deleteMany({
        where: {
          OR: [
            { targetOrderId: { in: orderIds } },
            ...(orderItemIds.length > 0
              ? [{ targetOrderItemId: { in: orderItemIds } }]
              : []),
            ...(paymentIds.length > 0
              ? [{ targetPaymentId: { in: paymentIds } }]
              : []),
            ...(amendmentIds.length > 0
              ? [{ targetAmendmentId: { in: amendmentIds } }]
              : []),
          ],
        },
      });

      // h. OrderTrace
      await tx.orderTrace.deleteMany({
        where: { orderId: { in: orderIds } },
      });

      // i. OrderRevision (Must be deleted BEFORE OrderAmendment because OrderRevision.amendmentId references OrderAmendment with Restrict)
      await tx.orderRevision.deleteMany({
        where: { orderId: { in: orderIds } },
      });

      // j. AmendmentSettlement & OrderAmendment
      if (amendmentIds.length > 0) {
        await tx.amendmentSettlement.deleteMany({
          where: { amendmentId: { in: amendmentIds } },
        });
        await tx.orderAmendment.deleteMany({
          where: { id: { in: amendmentIds } },
        });
      }

      // k. OrderItemPayment
      await tx.orderItemPayment.deleteMany({
        where: { orderId: { in: orderIds } },
      });

      // l. OrderItemAddOn & OrderItem
      if (orderItemIds.length > 0) {
        await tx.orderItemAddOn.deleteMany({
          where: { orderItemId: { in: orderItemIds } },
        });
      }
      await tx.orderItem.deleteMany({
        where: { orderId: { in: orderIds } },
      });

      // m. Payment rows (unlinking reversals first)
      if (paymentIds.length > 0) {
        await tx.payment.updateMany({
          where: { reversalOfPaymentId: { in: paymentIds } },
          data: { reversalOfPaymentId: null },
        });
        await tx.payment.deleteMany({
          where: { orderId: { in: orderIds } },
        });
      }

      // n. Disconnect TableSessions from Orders
      await tx.order.updateMany({
        where: { id: { in: orderIds } },
        data: { tableSessionId: null },
      });

      // o. Delete the Orders
      await tx.order.deleteMany({
        where: { id: { in: orderIds } },
      });

      // 5. Clean up or recompute affected TableSessions
      for (const sessionId of affectedTableSessionIds) {
        const remainingOrders = await tx.order.count({
          where: { tableSessionId: sessionId },
        });
        const remainingPayments = await tx.payment.count({
          where: { tableSessionId: sessionId },
        });
        if (remainingOrders === 0 && remainingPayments === 0) {
          await tx.tableSession
            .delete({ where: { id: sessionId } })
            .catch(() => {});
        } else {
          await recomputeSessionTotals(sessionId, tx).catch(() => {});
        }
      }

      // 6. Recalculate affected shifts
      for (const shiftId of affectedShiftIds) {
        const shift = await tx.shift.findUnique({ where: { id: shiftId } });
        if (!shift) continue;

        const remainingPayments = await tx.payment.findMany({
          where: { shiftId },
          select: {
            amount: true,
            method: true,
            type: true,
            status: true,
            orderId: true,
            amendmentId: true,
          },
        });

        let cash = decimal(0),
          card = decimal(0),
          wallet = decimal(0),
          refunds = decimal(0);
        const paidOrderIds = new Set<string>();

        for (const p of remainingPayments) {
          const amt = decimal(p.amount);
          if (p.type === "REFUND") {
            if (p.method === "CASH") cash = cash.minus(amt);
            else if (p.method === "CARD") card = card.minus(amt);
            else if (p.method === "WALLET") wallet = wallet.minus(amt);
            refunds = refunds.plus(amt);
          } else if (p.status === "PAID") {
            if (p.method === "CASH") cash = cash.plus(amt);
            else if (p.method === "CARD") card = card.plus(amt);
            else if (p.method === "WALLET") wallet = wallet.plus(amt);
            if (!p.amendmentId) paidOrderIds.add(p.orderId);
          } else if (p.status === "REFUNDED") {
            refunds = refunds.plus(amt);
          }
        }

        const payouts = await tx.purchasePayment.aggregate({
          where: { shiftId, fundingSource: "DRAWER" },
          _sum: { amount: true },
        });
        const cashPayouts = money(payouts._sum.amount ?? 0);
        const totalSales = money(cash.plus(card).plus(wallet));

        const [expensePayouts, expenseReturns] = await Promise.all([
          tx.operatingExpense.aggregate({
            where: { shiftId },
            _sum: { amount: true },
          }),
          tx.operatingExpenseReturn.aggregate({
            where: { shiftId },
            _sum: { amount: true },
          }),
        ]);
        const totalExpensePayouts = expenseAggregate(
          expensePayouts._sum.amount ?? 0
        );
        const totalExpenseReturns = expenseAggregate(
          expenseReturns._sum.amount ?? 0
        );

        const expectedCash = drawerExpected({
          opening: shift.openingCashAmount,
          netCollections: cash,
          supplierPayouts: cashPayouts,
          expensePayouts: totalExpensePayouts,
          expenseReturns: totalExpenseReturns,
        });

        let cashDifference = shift.cashDifference;
        let cashWithinTolerance = shift.cashWithinTolerance;
        if (shift.actualCashAmount !== null) {
          cashDifference = money(
            decimal(shift.actualCashAmount).minus(expectedCash)
          );
          if (
            shift.cashToleranceAmount !== null &&
            shift.cashToleranceAmount !== undefined
          ) {
            cashWithinTolerance = cashDifference
              .abs()
              .lte(decimal(shift.cashToleranceAmount));
          }
        }

        const remainingOrders = paidOrderIds.size
          ? await tx.order.findMany({
              where: { id: { in: [...paidOrderIds] } },
              select: { discountAmount: true },
            })
          : [];
        const discounts = remainingOrders.reduce(
          (sum, o) => sum.plus(decimal(o.discountAmount ?? 0)),
          decimal(0)
        );

        await tx.shift.update({
          where: { id: shiftId },
          data: {
            totalCashSales: round2(cash.toNumber()),
            totalCardSales: round2(card.toNumber()),
            totalWalletSales: round2(wallet.toNumber()),
            totalSales,
            totalRefunds: round2(refunds.toNumber()),
            totalCashPayouts: cashPayouts,
            totalExpensePayouts,
            totalExpenseReturns,
            totalDiscounts: round2(discounts.toNumber()),
            expectedCashAmount: expectedCash,
            cashDifference,
            cashWithinTolerance,
            orderCount: paidOrderIds.size,
          },
        });
      }

      // 7. Audit log entry
      await auditInTransaction(tx, {
        cafeId: args.cafeId,
        userId: args.actorId,
        action: "SALES_DATA_RESET",
        entity: "Order",
        entityId: args.cafeId,
        details: {
          branchId: args.branchId ?? "ALL",
          resetAll: args.resetAll ?? false,
          from: args.from ?? null,
          to: args.to ?? null,
          deletedOrderCount: orders.length,
          totalAmount,
          paidAmount,
          restoredItemsCount: itemsToRestore.length,
          restoredItems: itemsToRestore,
          affectedShiftCount: affectedShiftIds.length,
          reason: args.reason ?? "تصفير مبيعات تجريبية قبل الافتتاح",
        },
      });

      return {
        success: true,
        orderCount: orders.length,
        totalAmount,
        paidAmount,
        restoredItemsCount: itemsToRestore.length,
        itemsRestored: itemsToRestore,
        affectedShiftCount: affectedShiftIds.length,
      };
}

export async function executeSalesReset(
  args: ExecuteSalesResetArgs,
  client: Prisma.TransactionClient | typeof db = db
): Promise<ExecuteSalesResetResult> {
  if ("$transaction" in client && typeof client.$transaction === "function") {
    return (client as typeof db).$transaction(
      async (tx) => executeSalesResetInTransaction(tx, args),
      { timeout: 60000 }
    );
  }
  return executeSalesResetInTransaction(client as Prisma.TransactionClient, args);
}
