import type { Prisma } from "@prisma/client";
import { ApiError } from "@/lib/api";

/** Called with the inventory row held, matching acceptance's stock SHARE lock. */
export async function assertFinishedStockEditable(tx: Prisma.TransactionClient, id: string, change: { retire?: boolean; changingUnit?: boolean }) {
  if (change.changingUnit && (await tx.productStockBinding.count({ where: { inventoryItemId: id } }) || await tx.orderItem.count({ where: { finishedStockItemId: id } }))) throw new ApiError(409, "وحدة مخزون مرتبط بمنتجات أو مبيعات جاهزة لا تتغير");
  if (change.retire && (await tx.orderItem.count({ where: { finishedStockItemId: id, voidedAt: null, finishedStockDeductedAt: null, order: { status: { notIn: ["CANCELLED", "REJECTED"] } } } }) || await tx.finishedGoodsReturn.count({ where: { inventoryItemId: id, appliedAt: null } }))) throw new ApiError(409, "سوّي المبيعات المقبولة والمرتجعات المعلّقة قبل أرشفة المخزون");
}
