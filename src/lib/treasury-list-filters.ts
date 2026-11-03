import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { addDays, zonedDayStart } from './date-range';
export const treasuryListFilters = z.object({
  page: z.coerce.number().int().min(1).max(100000).default(1),
  from: z.iso.date().optional(), to: z.iso.date().optional(),
  q: z.string().trim().max(120).optional(), code: z.string().trim().max(30).optional(),
  branchId: z.string().min(1).max(128).optional(), accountId: z.string().min(1).max(128).optional(),
  kind: z.enum(['TREASURY', 'BANK', 'WALLET']).optional(), active: z.enum(['true', 'false']).optional(),
  status: z.enum(['DRAFT', 'IN_TRANSIT', 'RECEIVED', 'CANCELLED']).optional(),
}).strict().refine(q => !q.from || !q.to || q.from <= q.to, { message: 'نهاية الفترة قبل بدايتها' });
type Filter = z.infer<typeof treasuryListFilters>;
type Actor = { cafeId: string; branchId?: string | null };
export function accountListWhere(a: Actor, q: Filter): Prisma.MoneyAccountWhereInput {
  const branchId = a.branchId || q.branchId;
  return { cafeId: a.cafeId, ...(branchId ? { branchId } : {}), ...(q.code ? { code: q.code.toUpperCase() } : {}), ...(q.kind ? { kind: q.kind } : {}), ...(q.active ? { isActive: q.active === 'true' } : {}), ...(q.q ? { OR: [{ name: { contains: q.q, mode: 'insensitive' } }, { code: { contains: q.q, mode: 'insensitive' } }] } : {}) };
}
export function transferListWhere(a: Actor, q: Filter): Prisma.MoneyTransferWhereInput {
  const AND: Prisma.MoneyTransferWhereInput[] = [];
  if (q.accountId) AND.push({ OR: [{ fromAccountId: q.accountId }, { toAccountId: q.accountId }] });
  if (!a.branchId && q.branchId) AND.push({ OR: [{ fromAccount: { branchId: q.branchId } }, { toAccount: { branchId: q.branchId } }] });
  if (q.q) AND.push({ OR: [{ fromNameSnapshot: { contains: q.q, mode: 'insensitive' } }, { toNameSnapshot: { contains: q.q, mode: 'insensitive' } }, { reference: { contains: q.q, mode: 'insensitive' } }] });
  return { cafeId: a.cafeId, ...(a.branchId ? { fromAccount: { branchId: a.branchId }, toAccount: { branchId: a.branchId } } : {}), ...(q.status ? { status: q.status } : {}), createdAt: { ...(q.from ? { gte: zonedDayStart(q.from) } : {}), ...(q.to ? { lt: zonedDayStart(addDays(q.to, 1)) } : {}) }, ...(AND.length ? { AND } : {}) };
}
