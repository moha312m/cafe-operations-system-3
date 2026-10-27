import type { InventoryUnit, Prisma, ProductStockMode } from "@prisma/client";
import { Prisma as Sql } from "@prisma/client";
import { ApiError } from "@/lib/api";
import { theoreticalConsumption } from "@/lib/recipes";
import { round3 } from "@/lib/costing";
import { acquireInventorySharedLocks } from "@/lib/inventory-freeze";
import type { AvailabilityLine, AvailabilityVerdict } from "@/lib/stock-availability";

type Tx = Prisma.TransactionClient;
export type ConsumptionBoundary = "SERVE" | "CARRY_RECIPES" | "DEFERRED";
export type FinishedAllocation = { orderItemId: string; quantity: number };
export type StockDemand = { inventoryItemId: string; name: string; unit: InventoryUnit; quantity: number; finishedAllocations: FinishedAllocation[] };
export type ConsumptionPlan = { orderId: string; cafeId: string; branchId: string; processRecipes: boolean; demands: StockDemand[]; productsWithoutRecipe: string[]; configurationsWithIncompleteRecipe: { label: string; issues: string[] }[] };

export function provisionalConsumption(product: { id: string; stockMode: ProductStockMode }, variantId: string | null) {
  return { stockModeSnapshot: product.stockMode, stockProductIdSnapshot: product.id, stockVariantIdSnapshot: variantId };
}

export async function validateProvisionalFinishedSales(tx: Tx, scope: { cafeId: string; branchId: string }, lines: { productId: string; variantId: string | null; stockModeSnapshot: ProductStockMode }[]) {
  const finished = lines.filter(line => line.stockModeSnapshot === "FINISHED_GOOD");
  if (!finished.length) return;
  await tx.$queryRaw`SELECT "id" FROM "CafeSettings" WHERE "cafeId"=${scope.cafeId} FOR SHARE`;
  for (const line of finished) await finishedBinding(tx, scope, line.productId, line.variantId);
}

export type ScopedCart = { cafeId: string; branchId: string; inventoryEnforcementMode: "STRICT" | "ALLOW_NEGATIVE_STOCK" | "OVERRIDE_ALL"; lines: AvailabilityLine[] };
export async function resolveCartConsumption(tx: Tx, input: ScopedCart): Promise<AvailabilityVerdict> {
  const { checkCartAvailability } = await import("@/lib/stock-availability");
  return checkCartAvailability({ ...input, mode: input.inventoryEnforcementMode }, tx);
}

/** Exact binding only. This validation is used for new sales, never settlement. */
export async function finishedBinding(tx: Tx, scope: { cafeId: string; branchId: string }, productId: string, variantId: string | null) {
  const settings = await tx.cafeSettings.findUnique({ where: { cafeId: scope.cafeId } });
  if (settings?.finishedGoodsSalesEnabled !== true || settings.inventoryEnabled !== true) throw new ApiError(409, "بيع المنتجات الجاهزة غير مفعل");
  const binding = await tx.productStockBinding.findFirst({
    where: { ...scope, productId, variantId },
    include: { product: true, variant: true, branch: true, inventoryItem: true },
  });
  if (!binding || binding.product.cafeId !== scope.cafeId || !binding.product.isActive || !binding.product.isAvailable ||
      !binding.branch.isActive || binding.branch.cafeId !== scope.cafeId ||
      (variantId && (!binding.variant || binding.variant.productId !== productId || !binding.variant.isActive)) ||
      (!variantId && await tx.productVariant.count({ where: { productId, isActive: true } })) ||
      binding.unit !== "PIECE" || binding.inventoryItem.unit !== "PIECE" || binding.inventoryItem.archivedAt || !binding.inventoryItem.isActive ||
      binding.inventoryItem.cafeId !== scope.cafeId || binding.inventoryItem.branchId !== scope.branchId) {
    throw new ApiError(409, "المنتج الجاهز محتاج ربط مخزون قطعة بنفس الفرع والحجم بالضبط");
  }
  return binding.inventoryItem;
}

/** Cart resolution shares the recipe engine; finished bases never enter it. */
export async function cartLineConsumption(tx: Tx, scope: { cafeId: string; branchId: string }, line: AvailabilityLine) {
  const product = await tx.product.findFirst({ where: { id: line.productId, cafeId: scope.cafeId } });
  const mode = line.stockMode ?? product?.stockMode ?? "RECIPE";
  const finishedItem = mode === "FINISHED_GOOD" ? await finishedBinding(tx, scope, line.productId, line.variantId) : null;
  const recipe = await theoreticalConsumption({ ...line, excludeBase: mode === "FINISHED_GOOD" }, tx);
  return { recipe, finishedItem };
}

/** Call at the actual acceptance boundary, before payment/response commits. */
export async function finalizeOrderConsumption(tx: Tx, orderId: string, acceptedAt: Date) {
  const order = await tx.order.findUnique({ where: { id: orderId }, include: { items: { include: { addOns: true } } } });
  if (!order) throw new ApiError(404, "الطلب مش موجود");
  const candidates = order.items.filter(i => i.stockModeSnapshot !== null && !i.stockAcceptedAt && !i.voidedAt);
  if (!candidates.length) return; // Includes legacy pending QR: never backfill.
  const productIds = [...new Set(candidates.map(i => i.stockProductIdSnapshot).filter((id): id is string => !!id))].sort();
  if (productIds.length) await tx.$queryRaw`SELECT "id" FROM "Product" WHERE "cafeId"=${order.cafeId} AND "id" IN (${Sql.join(productIds)}) ORDER BY "id" FOR SHARE`;
  const variantIds = [...new Set(candidates.map(i => i.stockVariantIdSnapshot).filter((id): id is string => !!id))].sort();
  if (variantIds.length) await tx.$queryRaw`SELECT "id" FROM "ProductVariant" WHERE "id" IN (${Sql.join(variantIds)}) ORDER BY "id" FOR SHARE`;
  await tx.$queryRaw`SELECT "id" FROM "CafeSettings" WHERE "cafeId"=${order.cafeId} FOR SHARE`;
  await acquireInventorySharedLocks(tx, [order.branchId]);
  const acceptedFinished: AvailabilityLine[] = [];
  const finishedIds = new Set<string>();
  const preparedIds = new Set<string>();
  for (const item of candidates) {
    const product = item.productId ? await tx.product.findFirst({ where: { id: item.productId, cafeId: order.cafeId } }) : null;
    const mode = product?.stockMode ?? "RECIPE";
    if (mode === "RECIPE") preparedIds.add(item.id);
    if ((item.stockModeSnapshot === "FINISHED_GOOD" || mode === "FINISHED_GOOD") && (!product || product.id !== item.stockProductIdSnapshot ||
        (item.stockVariantIdSnapshot && item.variantId !== item.stockVariantIdSnapshot))) throw new ApiError(409, "هوية المنتج الجاهز تغيرت؛ راجع الطلب قبل الموافقة");
    const stock = mode === "FINISHED_GOOD" ? await finishedBinding(tx, order, product!.id, item.variantId) : null;
    if (stock) {
      finishedIds.add(item.id);
      if (!Number.isSafeInteger(item.quantity) || item.quantity < 1 || item.quantity > 999999999) throw new ApiError(400, "كمية القطع غير صالحة");
      await tx.$queryRaw`SELECT "id" FROM "InventoryItem" WHERE "id"=${stock.id} FOR SHARE`;
      // Archive/deactivation may have committed while the stock lock waited.
      await finishedBinding(tx, order, product!.id, item.variantId);
      acceptedFinished.push({ stockMode: "FINISHED_GOOD", productId: product!.id, variantId: item.variantId, quantity: item.quantity, addOnIds: item.addOns.flatMap(a => a.addOnId ? [a.addOnId] : []), label: item.productName });
    }
    await tx.orderItem.update({ where: { id: item.id }, data: {
      stockModeSnapshot: mode, stockAcceptedAt: acceptedAt,
      ...(stock ? { finishedStockCafeId: order.cafeId, finishedStockBranchId: order.branchId, finishedStockItemId: stock.id, finishedStockUnit: "PIECE", finishedStockQuantity: item.quantity } : {}),
    } });
  }
  // Prepared lines contribute only known demand sharing a finished stock row.
  // Their historical QR approval policy is otherwise unchanged.
  if (acceptedFinished.length) {
    const prepared = order.items.filter(item => !item.voidedAt && !finishedIds.has(item.id) && (preparedIds.has(item.id) || item.stockModeSnapshot !== "FINISHED_GOOD") && item.productId).map(item => ({ stockMode: "RECIPE" as const, sharedFinishedStockOnly: true, productId: item.productId!, variantId: item.variantId, quantity: item.quantity, addOnIds: item.addOns.flatMap(a => a.addOnId ? [a.addOnId] : []), label: item.productName }));
    const availability = await resolveCartConsumption(tx, { cafeId: order.cafeId, branchId: order.branchId, inventoryEnforcementMode: order.inventoryEnforcementMode, lines: [...acceptedFinished, ...prepared] });
    if (!availability.ok) throw new ApiError(409, availability.message ?? "مخزون المنتج الجاهز غير متاح");
  }
}

export async function hasPendingConsumption(tx: Tx, orderId: string) {
  const order = await tx.order.findUnique({ where: { id: orderId }, select: { stockDeductedAt: true, items: { where: { voidedAt: null }, select: { stockModeSnapshot: true, stockAcceptedAt: true, finishedStockDeductedAt: true } } } });
  return !!order && (!order.stockDeductedAt || order.items.some(i => i.stockModeSnapshot === "FINISHED_GOOD" && i.stockAcceptedAt && !i.finishedStockDeductedAt));
}

export async function planOrderConsumption(tx: Tx, orderId: string, boundary: ConsumptionBoundary): Promise<ConsumptionPlan> {
  const order = await tx.order.findUnique({ where: { id: orderId }, include: { items: { where: { voidedAt: null }, include: { addOns: true } } } });
  if (!order) throw new ApiError(404, "الطلب مش موجود");
  const plan: ConsumptionPlan = { orderId, cafeId: order.cafeId, branchId: order.branchId, processRecipes: !order.stockDeductedAt, demands: [], productsWithoutRecipe: [], configurationsWithIncompleteRecipe: [] };
  const demands = new Map<string, StockDemand>();
  const add = (stock: { id: string; name: string; unit: InventoryUnit }, quantity: number, allocation?: FinishedAllocation) => {
    const demand = demands.get(stock.id) ?? { inventoryItemId: stock.id, name: stock.name, unit: stock.unit, quantity: 0, finishedAllocations: [] };
    demand.quantity = round3(demand.quantity + quantity);
    if (allocation) demand.finishedAllocations.push(allocation);
    demands.set(stock.id, demand);
  };
  for (const item of order.items) {
    const finished = item.stockModeSnapshot === "FINISHED_GOOD";
    if (finished && boundary !== "CARRY_RECIPES" && !item.finishedStockDeductedAt) {
      if (!item.stockAcceptedAt || !item.finishedStockItemId || item.finishedStockQuantity !== item.quantity || item.finishedStockUnit !== "PIECE" || item.finishedStockCafeId !== order.cafeId || item.finishedStockBranchId !== order.branchId) throw new ApiError(409, "بيانات مخزون الطلب تحتاج إصلاح");
      const stock = await tx.inventoryItem.findFirst({ where: { id: item.finishedStockItemId, cafeId: order.cafeId, branchId: order.branchId, unit: "PIECE" } });
      if (!stock) throw new ApiError(409, "مخزون الطلب الأصلي غير موجود");
      add(stock, item.finishedStockQuantity!, { orderItemId: item.id, quantity: item.finishedStockQuantity! });
    }
    if (!plan.processRecipes || (!item.productId && !finished)) continue;
    const consumption = await theoreticalConsumption({ productId: item.productId ?? item.stockProductIdSnapshot!, variantId: item.variantId, addOnIds: item.addOns.map(a => a.addOnId).filter((id): id is string => !!id), quantity: item.quantity, excludeBase: finished }, tx);
    const label = item.variantName ? `${item.productName} (${item.variantName})` : item.productName;
    if (!consumption.lines.length && !finished) plan.productsWithoutRecipe.push(label);
    if (!consumption.complete) plan.configurationsWithIncompleteRecipe.push({ label, issues: consumption.issues });
    for (const line of consumption.lines) {
      const cafeStock = await tx.inventoryItem.findFirst({ where: { id: line.inventoryItemId, cafeId: order.cafeId } });
      if (!cafeStock) continue;
      const stock = await tx.inventoryItem.findFirst({ where: { cafeId: order.cafeId, branchId: order.branchId, name: cafeStock.name, unit: cafeStock.unit, archivedAt: null } });
      if (!stock) {
        if (boundary !== "DEFERRED" && order.inventoryEnforcementMode === "STRICT") throw new ApiError(400, `الخامة «${cafeStock.name}» غير متوفرة في الفرع`);
        continue;
      }
      add(stock, line.quantityInStockUnit);
    }
  }
  plan.demands = [...demands.values()].sort((a, b) => a.inventoryItemId.localeCompare(b.inventoryItemId));
  return plan;
}
