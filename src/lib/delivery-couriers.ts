import type { Prisma } from "@prisma/client";
import { projectStaffBranch, staffBranchSelect } from "@/lib/staff-branch";

function courierScope(cafeId: string, branchId: string): Prisma.UserWhereInput {
  return {
    cafeId, isDeliveryCourier: true, isActive: true, archivedAt: null,
    role: { notIn: ["CAFE_OWNER", "SUPER_ADMIN"] },
    OR: [{ branchId }, { temporaryBranchId: branchId }],
  };
}

export async function listDeliveryCouriers(
  client: Prisma.TransactionClient,
  cafeId: string,
  branchId: string,
) {
  const staff = await client.user.findMany({
    where: courierScope(cafeId, branchId),
    select: { ...staffBranchSelect, name: true, phone: true },
    orderBy: [{ name: "asc" }, { id: "asc" }],
  });
  const now = new Date();
  const scoped = await Promise.all(staff.map(async (user) =>
    (await projectStaffBranch(client, user, now)).branchId === branchId
      ? { id: user.id, name: user.name, phone: user.phone }
      : null,
  ));
  return scoped.filter(courier => courier !== null);
}

export async function isAvailableDeliveryCourier(
  tx: Prisma.TransactionClient,
  cafeId: string,
  branchId: string,
  id: string,
) {
  // Lock the staff row before the branch allocator, matching staff edits.
  const [locked] = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "User"
    WHERE "id" = ${id} AND "cafeId" = ${cafeId}
      AND ("branchId" = ${branchId} OR "temporaryBranchId" = ${branchId})
    FOR SHARE
  `;
  if (!locked) return false;
  const courier = await tx.user.findFirst({
    where: { ...courierScope(cafeId, branchId), id },
    select: staffBranchSelect,
  });
  return courier !== null && (await projectStaffBranch(tx, courier)).branchId === branchId;
}
