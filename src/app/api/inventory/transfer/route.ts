import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import {
  requireKey,
  resolveCafeId,
  handleApiError,
  ApiError,
} from "@/lib/api";
import type { SessionUser } from "@/lib/auth";
import { auditInTransaction } from "@/lib/audit";
import { round2 } from "@/lib/inventory";
import { round3 } from "@/lib/costing";
import { applyStockMutation, lockItemForUpdate } from "@/lib/ledger";
import { acquireInventorySharedLocks } from "@/lib/inventory-freeze";
import { withIdempotency, requestScope } from "@/lib/idempotency";
import { lockBranchAllocator } from "@/lib/transaction-locks";

const transferSchema = z.object({
  inventoryItemId: z.string(), // the source-branch item being transferred
  toBranchId: z.string(),
  quantity: z.number().positive("الكمية لازم تكون أكبر من صفر"),
  note: z.string().max(500).optional(),
  cafeId: z.string().optional(),
});
type TransferInput = z.infer<typeof transferSchema>;

const CHANGED = "حالة المخزون اتغيرت — جرّب العملية تاني بنفس المفتاح";

// Who may move this item where. Runs on the request and again inside every
// idempotent phase, so a replay is re-authorized against the current account.
async function transferTarget(session: SessionUser, data: TransferInput) {
  const cafeId = resolveCafeId(session, data.cafeId);
  const source = await db.inventoryItem.findUnique({
    where: { id: data.inventoryItemId },
  });
  if (!source || source.cafeId !== cafeId) {
    throw new ApiError(404, "الخامة مش موجودة");
  }
  // Branch-pinned staff may only send FROM their own branch.
  if (session.branchId && source.branchId !== session.branchId) {
    throw new ApiError(403, "ليس لديك صلاحية على فرع تاني");
  }
  if (data.toBranchId === source.branchId) {
    throw new ApiError(400, "الفرع المستلم لازم يكون مختلف عن المصدر");
  }
  const toBranch = await db.branch.findFirst({
    where: { id: data.toBranchId, cafeId },
  });
  if (!toBranch) throw new ApiError(400, "الفرع المستلم مش موجود");
  return { cafeId, source, toBranch };
}

// Transfer stock from the item's branch to another branch of the same
// cafe. Creates TRANSFER_OUT (source) + TRANSFER_IN (destination) and
// keeps both item balances in sync. The destination item is matched by
// (name, unit) or created if missing. Both halves, the audit row and the
// stored response commit in one transaction under the Idempotency-Key.
export async function POST(request: NextRequest) {
  try {
    let session = await requireKey("inventory.transactions");
    const data = transferSchema.parse(await request.json());
    const { cafeId, source, toBranch } = await transferTarget(session, data);
    const qty = round3(data.quantity);
    const operation = "POST /api/inventory/transfer:" + source.id;
    const scope = async () => {
      const target = await transferTarget(session, data);
      return requestScope({ ...session, cafeId: target.cafeId, branchId: target.source.branchId }, operation);
    };
    const effective = { cafeId, inventoryItemId: source.id, toBranchId: toBranch.id, quantity: qty, note: data.note ?? null };

    // The transaction is café-scoped only: the destination item lives in
    // another branch, so a source-branch row predicate would hide it.
    return await withIdempotency(request, scope, effective, async (tx) => {
      // Discovery identifies the destination row only; every decision below
      // uses reads taken after the locks.
      const match = { cafeId, branchId: toBranch.id, name: source.name, unit: source.unit, archivedAt: null };
      let destId = (await tx.inventoryItem.findFirst({ where: match, select: { id: true } }))?.id;
      if (!destId) {
        // Two first transfers into a branch must not both create its item.
        await lockBranchAllocator(tx, toBranch.id);
        destId = (await tx.inventoryItem.findFirst({ where: match, select: { id: true } }))?.id;
      }
      await acquireInventorySharedLocks(tx, [source.branchId, toBranch.id]);
      const created = !destId;
      if (!destId) {
        destId = (await tx.inventoryItem.create({
          data: {
            cafeId,
            branchId: toBranch.id,
            name: source.name,
            category: source.category,
            unit: source.unit,
            currentStock: 0,
            minimumStock: source.minimumStock,
            costPerUnit: source.costPerUnit,
            supplierName: source.supplierName,
          },
          select: { id: true },
        })).id;
      }
      // Both rows, one order: opposite-direction transfers cannot deadlock.
      for (const id of [source.id, destId].sort()) await lockItemForUpdate(tx, id);
      const from = await tx.inventoryItem.findUniqueOrThrow({ where: { id: source.id } });
      const dest = await tx.inventoryItem.findUniqueOrThrow({ where: { id: destId } });
      if (
        from.cafeId !== cafeId || from.branchId !== source.branchId ||
        from.name !== source.name || from.unit !== source.unit ||
        dest.branchId !== toBranch.id || dest.name !== source.name || dest.unit !== source.unit ||
        dest.archivedAt !== null || (created && !from.costPerUnit.equals(source.costPerUnit))
      ) {
        throw new ApiError(409, CHANGED);
      }
      if (Number(from.currentStock) < qty) {
        throw new ApiError(400, "لا توجد كمية كافية للتحويل");
      }

      const unitCost = Number(from.costPerUnit);
      const totalCost = round2(qty * unitCost);
      // Source: decrement + TRANSFER_OUT, under the source item's lock.
      const out = await applyStockMutation(tx, {
        inventoryItemId: source.id,
        cafeId,
        branchId: source.branchId,
        type: "TRANSFER_OUT",
        quantity: -qty,
        unitCost,
        totalCost,
        note: `تحويل لفرع ${toBranch.name}${data.note ? ` — ${data.note}` : ""}`,
        createdById: session.id,
        insufficientMessage: "لا توجد كمية كافية للتحويل",
      });
      const fromName =
        (await tx.branch.findUnique({ where: { id: source.branchId } }))?.name ?? "";
      const into = await applyStockMutation(tx, {
        inventoryItemId: destId,
        cafeId,
        branchId: toBranch.id,
        type: "TRANSFER_IN",
        quantity: qty,
        unitCost,
        totalCost,
        note: `تحويل من فرع ${fromName}${data.note ? ` — ${data.note}` : ""}`,
        createdById: session.id,
      });

      await auditInTransaction(tx, {
        cafeId,
        userId: session.id,
        action: "INVENTORY_TRANSFERRED",
        entity: "InventoryItem",
        entityId: source.id,
        details: {
          name: source.name,
          quantity: qty,
          fromBranchId: source.branchId,
          toBranchId: toBranch.id,
          destinationItemId: destId,
          destinationCreated: created,
          unitCost,
          totalCost,
          sourceStockBefore: out.stockBefore,
          sourceStockAfter: out.stockAfter,
          destinationStockBefore: into.stockBefore,
          destinationStockAfter: into.stockAfter,
        },
      });

      return NextResponse.json({ ok: true });
    }, { scope: { cafeId }, authorize: async () => { session = await requireKey("inventory.transactions"); } });
  } catch (error) {
    return handleApiError(error);
  }
}
