import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireKey, handleApiError, ApiError, requireFeature } from "@/lib/api";
import { auditInTransaction } from "@/lib/audit";
import { resolvePermissions } from "@/lib/perms/effective";
import { protectedTransaction } from "@/lib/protected-transaction";
import { lockBranchAllocator } from "@/lib/transaction-locks";
import { assertTableConfigurationChange, loadConfiguredTable as loadScoped } from "@/lib/table-configuration";

type Params = { params: Promise<{ id: string }> };

const patchSchema = z.object({
  tableNumber: z.string().trim().min(1).max(20).optional(),
  displayName: z.string().trim().max(60).nullable().optional(),
  area: z.string().trim().max(60).nullable().optional(),
  seatsCount: z.number().int().min(0).max(100).nullable().optional(),
  sortOrder: z.number().int().optional(),
  isActive: z.boolean().optional(),
  archived: z.boolean().optional(), // true = archive, false = restore
});

// PATCH /api/tables/config/[id] — edit / activate / deactivate / archive.
export async function PATCH(request: NextRequest, { params }: Params) {
  try {
    const session = await requireKey("tables.edit");
    await requireFeature(session, "enableTables");
    const { id } = await params;
    const candidate = await loadScoped(session, id, db);
    const data = patchSchema.parse(await request.json());
    const { keys } = await resolvePermissions(session);

    return await protectedTransaction(async (tx) => {
    await lockBranchAllocator(tx, candidate.branchId);
    const table = await loadScoped(session, id, tx);

    // Deactivating or archiving needs the sensitive tables.archive key.
    const wantsToggle =
      (data.isActive !== undefined && data.isActive !== table.isActive) ||
      data.archived !== undefined;
    if (wantsToggle) {
      if (!keys.has("tables.archive")) throw new ApiError(403, "ليس لديك صلاحية لإدارة الترابيزات");
    }
    await assertTableConfigurationChange(tx, table, data);

    // Renaming the number must stay unique per branch.
    if (data.tableNumber && data.tableNumber !== table.tableNumber) {
      const clash = await tx.cafeTable.findUnique({
        where: { branchId_tableNumber: { branchId: table.branchId, tableNumber: data.tableNumber } },
      });
      if (clash) throw new ApiError(409, "رقم الترابيزة موجود بالفعل في هذا الفرع");
    }

    const update: Record<string, unknown> = {};
    if (data.tableNumber !== undefined) update.tableNumber = data.tableNumber;
    if (data.displayName !== undefined) update.displayName = data.displayName || null;
    if (data.area !== undefined) update.area = data.area || null;
    if (data.seatsCount !== undefined) update.seatsCount = data.seatsCount;
    if (data.sortOrder !== undefined) update.sortOrder = data.sortOrder;
    if (data.isActive !== undefined) update.isActive = data.isActive;
    if (data.archived === true) { update.archivedAt = new Date(); update.isActive = false; }
    else if (data.archived === false) { update.archivedAt = null; }

    const updated = await tx.cafeTable.update({ where: { id }, data: update });

    const base = { cafeId: table.cafeId, userId: session.id, entity: "CafeTable", entityId: id };
    const who = { branchId: table.branchId, tableId: id, tableNumber: updated.tableNumber };
    if (data.archived === true) await auditInTransaction(tx, { ...base, action: "TABLE_ARCHIVED", details: who });
    else if (data.archived === false) await auditInTransaction(tx, { ...base, action: "TABLE_REACTIVATED", details: who });
    else if (data.isActive === false && table.isActive) await auditInTransaction(tx, { ...base, action: "TABLE_DEACTIVATED", details: who });
    else if (data.isActive === true && !table.isActive) await auditInTransaction(tx, { ...base, action: "TABLE_REACTIVATED", details: who });
    else await auditInTransaction(tx, { ...base, action: "TABLE_UPDATED", details: { ...who, oldValue: table.tableNumber, newValue: updated.tableNumber } });

    return NextResponse.json({ ok: true });
    }, { cafeId: candidate.cafeId, branchId: candidate.branchId });
  } catch (error) {
    return handleApiError(error);
  }
}
