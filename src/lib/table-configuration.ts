import type { Prisma } from '@prisma/client';
import { ApiError, resolveReadScope } from '@/lib/api';
import type { SessionUser } from '@/lib/auth';
import { lockBranchAllocator } from '@/lib/transaction-locks';

type ConfiguredTable = { cafeId: string; branchId: string; tableNumber: string };
type Change = { tableNumber?: string; isActive?: boolean; archived?: boolean };

export async function loadConfiguredTable(session: SessionUser, id: string, client: Prisma.TransactionClient) {
  // Branchless staff must be refused before any table lookup. Explicit
  // edit grants do not turn a missing assignment into cafe-wide access.
  const scope = resolveReadScope(session);
  const table = await client.cafeTable.findUnique({ where: { id } });
  if (!table) throw new ApiError(404, 'الترابيزة غير موجودة');
  if (scope.cafeId && table.cafeId !== scope.cafeId) throw new ApiError(403, 'ليس لديك صلاحية لإدارة الترابيزات');
  if (scope.branchId && table.branchId !== scope.branchId) throw new ApiError(403, 'الترابيزة تبع فرع تاني');
  return table;
}

/** Config changes and every session opening/transfer share the existing
 * Branch parent lock (rank 1.5), before Orders/Payments/TableSessions.
 * Row locks on an OPEN session alone cannot protect the vacant-table gap. */
export async function assertTableConfigurationChange(tx: Prisma.TransactionClient, table: ConfiguredTable, change: Change) {
  await lockBranchAllocator(tx, table.branchId);
  const sensitive = (change.tableNumber !== undefined && change.tableNumber !== table.tableNumber)
    || change.isActive === false || change.archived === true;
  if (!sensitive) return;
  const occupied = await tx.tableSession.findFirst({
    where: { cafeId: table.cafeId, branchId: table.branchId, tableNumber: table.tableNumber, status: 'OPEN' },
    select: { id: true },
  });
  if (occupied) throw new ApiError(409, 'لا يمكن تغيير رقم الترابيزة أو إيقافها أو أرشفتها أثناء وجود جلسة مفتوحة');
}

export async function assertTableAvailable(tx: Prisma.TransactionClient, cafeId: string, branchId: string, tableNumber: string) {
  await lockBranchAllocator(tx, branchId);
  const table = await tx.cafeTable.findUnique({ where: { branchId_tableNumber: { branchId, tableNumber } } });
  // Preserve existing custom/legacy table-number support. A configured table
  // remains known after archive, and can never be reopened via direct input.
  if (table && (table.cafeId !== cafeId || !table.isActive || table.archivedAt)) {
    throw new ApiError(409, 'الترابيزة غير متاحة — اختار ترابيزة نشطة');
  }
}
