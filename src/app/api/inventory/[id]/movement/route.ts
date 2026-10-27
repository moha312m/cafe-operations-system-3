import { protectedTransaction } from "@/lib/protected-transaction";
import { withIdempotency, authenticatedRequestScope, requestFingerprint } from "@/lib/idempotency";
import { recordFinishedGoodsReturn } from "@/lib/finished-goods-returns";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireKey, handleApiError, ApiError, resolveReadScope } from "@/lib/api";
import { audit } from "@/lib/audit";
import { round2, signedDelta, TXN_AUDIT_ACTION } from "@/lib/inventory";
import { applyStockMutation } from "@/lib/ledger";
import { publicInventoryItem } from "@/lib/public-shape";
import { round3 } from "@/lib/costing";
import { findScopedItem } from "@/lib/inventory-scope";

type Params = { params: Promise<{ id: string }> };

// Manual stock movements. TRANSFER_IN/OUT are excluded here — those only
// happen through /api/inventory/transfer so both branches stay in sync.
const movementSchema = z.object({
  orderItemId: z.string().optional(),
  type: z.enum(["PURCHASE", "USAGE", "WASTE", "ADJUSTMENT", "RETURN"]),
  quantity: z.number({ message: "الكمية يجب أن تكون رقم" }),
  unitCost: z.number().min(0).optional(),
  note: z.string().max(500).optional(),
});

export async function POST(request: NextRequest, { params }: Params) {
  try {
    const { id } = await params;
    const data = movementSchema.parse(await request.json());
    const linkedReturn = data.type === "RETURN" && !!data.orderItemId;
    let session = await requireKey(linkedReturn ? "inventory.finished_returns" : "inventory.transactions");
    if (data.type === "RETURN" && data.orderItemId) {
      if (data.unitCost !== undefined) throw new ApiError(400, "تكلفة المرتجع من الاستهلاك الأصلي فقط");
      const candidate = await db.orderItem.findFirst({ where: { id: data.orderItemId, finishedStockItemId: id, order: resolveReadScope(session) }, select: { orderId: true } });
      if (!candidate) throw new ApiError(404, "صنف الطلب مش موجود في نطاقك");
      const operation = "POST /api/inventory/finished-return:" + candidate.orderId;
      const response = await withIdempotency(request, tx => authenticatedRequestScope(tx, session, operation, { kind: "order", id: candidate.orderId }), data, async tx => {
        const idempotencyScope = await authenticatedRequestScope(tx, session, operation, { kind: "order", id: candidate.orderId });
        const receipt = await recordFinishedGoodsReturn(tx, { actorSessionUser: session, orderItemId: data.orderItemId!, inventoryItemId: id, quantity: data.quantity, reason: data.note ?? "", idempotencyScope, idempotencyKey: request.headers.get("Idempotency-Key")!.trim(), requestHash: requestFingerprint(data) });
        return NextResponse.json({ receipt });
      }, { scope: resolveReadScope(session), authorize: async () => { session = await requireKey("inventory.finished_returns"); } });
      if (response.headers.get("Idempotency-Replayed") === "true") {
        const payload = await response.json();
        return NextResponse.json({ ...payload, receipt: { ...payload.receipt, replayed: true } }, { status: response.status, headers: response.headers });
      }
      return response;
    }
    if (data.orderItemId) throw new ApiError(400, "ربط الطلب متاح للمرتجع المادي فقط");
    const item = await findScopedItem(id, session);

    // ADJUSTMENT may be ±; everything else must be a positive amount.
    if (data.type !== "ADJUSTMENT" && data.quantity <= 0) {
      throw new ApiError(400, "الكمية لازم تكون أكبر من صفر");
    }
    if (data.type === "ADJUSTMENT" && data.quantity === 0) {
      throw new ApiError(400, "التسوية لازم تكون بقيمة موجبة أو سالبة");
    }

    const delta = round3(signedDelta(data.type, data.quantity));
    const current = Number(item.currentStock);
    const newStock = round3(current + delta);
    if (newStock < 0) {
      throw new ApiError(400, "لا توجد كمية كافية في المخزون");
    }

    // Value the movement: purchases use the entered cost (or current),
    // consumption (usage/waste) is valued at the item's cost so waste
    // reports are meaningful. Adjustments/returns follow any given cost.
    const unitCost =
      data.unitCost ??
      (data.type === "PURCHASE" || data.type === "USAGE" || data.type === "WASTE"
        ? Number(item.costPerUnit)
        : undefined);
    const totalCost =
      unitCost !== undefined ? round2(Math.abs(delta) * unitCost) : null;

    // Interactive form, not the array form this route used to use: an array
    // `$transaction` cannot hold `SELECT … FOR UPDATE` across statements, so
    // it could never satisfy the ledger contract.
    const updated = await protectedTransaction(async (tx) => {
      if (data.type === "RETURN" && (await tx.productStockBinding.count({ where: { inventoryItemId: id } }) || await tx.orderItem.count({ where: { finishedStockItemId: id } }))) throw new ApiError(409, "مرتجع المنتج الجاهز لازم يرتبط بصنف الطلب الأصلي؛ رد الأموال لا يعيد المخزون");
      await applyStockMutation(tx, {
        inventoryItemId: id,
        cafeId: item.cafeId,
        branchId: item.branchId,
        type: data.type,
        quantity: delta,
        unitCost: unitCost ?? null,
        totalCost,
        note: data.note || null,
        createdById: session.id,
        // A purchase refreshes the reference cost per unit.
        newCostPerUnit:
          data.type === "PURCHASE" && data.unitCost !== undefined ? data.unitCost : null,
        insufficientMessage: "لا توجد كمية كافية في المخزون",
      });
      return tx.inventoryItem.findUniqueOrThrow({ where: { id } });
    }, { cafeId: item.cafeId, branchId: item.branchId });

    await audit({
      cafeId: item.cafeId,
      userId: session.id,
      action: TXN_AUDIT_ACTION[data.type],
      entity: "InventoryItem",
      entityId: id,
      details: {
        name: item.name,
        branchId: item.branchId,
        type: data.type,
        quantity: delta,
        oldStock: current,
        newStock,
      },
    });

    return NextResponse.json({ item: publicInventoryItem(updated) });
  } catch (error) {
    return handleApiError(error);
  }
}

// Read-only physical-return eligibility and durable receipt history, including archived stock.
export async function GET(request: NextRequest, { params }: Params) {
  try {
    const session = await requireKey("inventory.finished_returns");
    const { id } = await params;
    const scope = resolveReadScope(session);
    const item = await db.inventoryItem.findFirst({ where: { id, ...scope } });
    if (!item) throw new ApiError(404, "المخزون مش موجود في نطاقك");
    const orderNumber = Number(request.nextUrl.searchParams.get("orderNumber"));
    const lines = await db.orderItem.findMany({ where: { finishedStockItemId: id, stockModeSnapshot: "FINISHED_GOOD", stockAcceptedAt: { not: null }, voidedAt: null, kitchenStatus: "SERVED", order: { ...scope, status: "SERVED", ...(orderNumber > 0 ? { orderNumber } : {}) } }, orderBy: { order: { createdAt: "desc" } }, take: 100, include: { order: { select: { orderNumber: true } }, finishedGoodsReturns: { orderBy: { receivedAt: "desc" }, include: { inventoryTransaction: { select: { unitCost: true, totalCost: true } } } } } });
    const linked = !!(await db.productStockBinding.count({ where: { inventoryItemId: id } }) || await db.orderItem.count({ where: { finishedStockItemId: id } }));
    return NextResponse.json({ linked, lines: lines.map(line => ({ orderItemId: line.id, orderNumber: line.order.orderNumber, productName: line.productName, quantity: line.finishedStockQuantity, eligibleQuantity: (line.finishedStockQuantity ?? 0) - line.finishedGoodsReturns.reduce((sum, r) => sum + r.quantity, 0), receipts: line.finishedGoodsReturns.map(r => ({ receiptId: r.id, quantity: r.quantity, status: r.appliedAt ? "APPLIED" : "PENDING", valuation: !r.appliedAt ? "PENDING" : r.inventoryTransaction?.unitCost === null ? "UNVALUED" : "VALUED", totalCost: r.inventoryTransaction?.totalCost ?? null })) })) });
  } catch (error) { return handleApiError(error); }
}
