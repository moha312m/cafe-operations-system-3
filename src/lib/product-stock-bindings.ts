import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { ApiError } from "@/lib/api";

export const stockBindingsSchema = z.array(z.object({
  branchId: z.string().min(1), variantId: z.string().min(1).nullable().default(null), inventoryItemId: z.string().min(1),
}).strict());

export async function saveProductStockBindings(tx: Prisma.TransactionClient, productId: string, cafeId: string, rows: z.infer<typeof stockBindingsSchema>, actorBranchId?: string | null) {
  const keys = new Set<string>();
  for (const row of rows) {
    const key = `${row.branchId}:${row.variantId ?? "base"}`;
    if (keys.has(key)) throw new ApiError(400, "ربط مكرر لنفس الفرع والحجم");
    keys.add(key);
    if (actorBranchId && actorBranchId !== row.branchId) throw new ApiError(403, "الربط خارج فرعك");
    const branch = await tx.branch.findFirst({ where: { id: row.branchId, cafeId, isActive: true } });
    const stock = await tx.inventoryItem.findFirst({ where: { id: row.inventoryItemId, cafeId, branchId: row.branchId, unit: "PIECE", archivedAt: null } });
    const variant = row.variantId ? await tx.productVariant.findFirst({ where: { id: row.variantId, productId, isActive: true } }) : null;
    if (!branch || !stock || (row.variantId && !variant)) throw new ApiError(400, "ربط المخزون لازم يكون قطعة نشطة بنفس المنشأة والفرع والحجم");
  }
  await tx.productStockBinding.deleteMany({ where: { productId, cafeId, ...(actorBranchId ? { branchId: actorBranchId } : {}) } });
  if (rows.length) await tx.productStockBinding.createMany({ data: rows.map(row => ({ ...row, productId, cafeId, unit: "PIECE" })) });
}
