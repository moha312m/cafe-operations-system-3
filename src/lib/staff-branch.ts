import type { Prisma, Role } from "@prisma/client";
import { db } from "@/lib/db";

export type TemporaryBranchStatus = "PENDING" | "ACTIVE" | "EXPIRED_FINISHING" | "CANCELLED_FINISHING";
export type StaffBranchAccount = {
 id: string; cafeId: string | null; role: Role; branchId: string | null;
 temporaryBranchId: string | null; temporaryBranchUntil: Date | null;
 temporaryBranchStartedAt: Date | null; temporaryBranchCancelledAt: Date | null;
};
export type StaffBranchResolution = {
 branchId: string | null; homeBranchId: string | null;
 temporaryBranchId: string | null; temporaryBranchUntil: string | null;
 temporaryBranchStatus: TemporaryBranchStatus | null;
};
export const staffBranchSelect = {
 id: true, cafeId: true, role: true, branchId: true, temporaryBranchId: true,
 temporaryBranchUntil: true, temporaryBranchStartedAt: true, temporaryBranchCancelledAt: true,
} as const;
export const clearTemporaryBranch = {
 temporaryBranchId: null, temporaryBranchUntil: null,
 temporaryBranchStartedAt: null, temporaryBranchCancelledAt: null,
} as const;
export const isBranchStaff = (role: Role) => role !== "CAFE_OWNER" && role !== "SUPER_ADMIN";

// A closed drawer may still own open stock custody. Only active participants
// count, and every query stays inside this account's cafe, across all its branches.
export async function hasStaffBranchResponsibilities(tx: Prisma.TransactionClient, account: Pick<StaffBranchAccount, "id" | "cafeId">): Promise<boolean> {
 if (!account.cafeId) return false;
 const shift = await tx.shift.findFirst({ where: { cafeId: account.cafeId, cashierId: account.id, status: "OPEN" }, select: { id: true } });
 if (shift) return true;
 return !!await tx.custodyPeriod.findFirst({ where: {
  cafeId: account.cafeId, status: "OPEN", holderType: "USER",
  OR: [ { participants: { some: { userId: account.id, leftAt: null } } },
   { responsibleShift: { cafeId: account.cafeId, cashierId: account.id } } ],
 }, select: { id: true } });
}

// Read-only projection for the owner's staff list: inspecting staff must never
// start/cancel/finish an assignment or write audit rows.
export async function projectStaffBranch(tx: Prisma.TransactionClient, account: StaffBranchAccount, now = new Date()): Promise<StaffBranchResolution> {
 const base: StaffBranchResolution = { branchId: account.branchId, homeBranchId: account.branchId,
  temporaryBranchId: null, temporaryBranchUntil: null, temporaryBranchStatus: null };
 if (!isBranchStaff(account.role) || !account.branchId || !account.temporaryBranchId || !account.temporaryBranchUntil) return base;
 const ended = !!account.temporaryBranchCancelledAt || account.temporaryBranchUntil <= now;
 const holds = await hasStaffBranchResponsibilities(tx, account);
 if (ended && (!account.temporaryBranchStartedAt || !holds)) return base;
 return { ...base,
  branchId: account.temporaryBranchStartedAt || !holds ? account.temporaryBranchId : account.branchId,
  temporaryBranchId: account.temporaryBranchId,
  temporaryBranchUntil: account.temporaryBranchUntil.toISOString(),
  temporaryBranchStatus: ended
   ? account.temporaryBranchCancelledAt ? "CANCELLED_FINISHING" : "EXPIRED_FINISHING"
   : account.temporaryBranchStartedAt || !holds ? "ACTIVE" : "PENDING",
 };
}

// Shared lock order: User first, then the caller may lock Branch. NO KEY UPDATE
// permits ordinary FK KEY SHARE locks (shifts/audit/ledger) without deadlocking.
export async function resolveStaffBranchInTransaction(tx: Prisma.TransactionClient, userId: string): Promise<StaffBranchResolution | null> {
 await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${userId} FOR NO KEY UPDATE`;
 const account = await tx.user.findUnique({ where: { id: userId }, select: staffBranchSelect });
 if (!account) return null;
 const resolution = await projectStaffBranch(tx, account);
 if (account.temporaryBranchId && !resolution.temporaryBranchId) {
  await tx.user.update({ where: { id: userId }, data: clearTemporaryBranch });
 } else if (resolution.temporaryBranchStatus === "ACTIVE" && !account.temporaryBranchStartedAt) {
  await tx.user.update({ where: { id: userId }, data: { temporaryBranchStartedAt: new Date() } });
 }
 return resolution;
}

export async function resolveStaffBranch(userId: string): Promise<StaffBranchResolution | null> {
 return db.$transaction((tx) => resolveStaffBranchInTransaction(tx, userId));
}
