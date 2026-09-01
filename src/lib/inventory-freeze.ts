import { Prisma } from "@prisma/client";
import { ApiError } from "@/lib/api";
import { auditInTransaction } from "@/lib/audit";

const INVENTORY_LOCK_SEED = BigInt(1313035600);

export class InventoryFrozenError extends ApiError {
  constructor() {
    super(409, "Inventory is temporarily frozen while a stock handover is in progress");
    this.name = "InventoryFrozenError";
  }
}

export async function inventoryBranchLockKey(
  tx: Prisma.TransactionClient,
  branchId: string
): Promise<bigint> {
  const rows = await tx.$queryRaw<{ key: bigint }[]>`
    SELECT hashtextextended(${branchId}::text, ${INVENTORY_LOCK_SEED}::bigint) AS key
  `;
  if (rows.length !== 1) throw new Error("PostgreSQL did not derive an inventory branch lock key");
  return rows[0].key;
}

export async function acquireInventorySharedLocks(
  tx: Prisma.TransactionClient,
  branchIds: string[]
): Promise<{ keys: bigint[] }> {
  if (branchIds.length === 0) throw new Error("At least one validated branch id is required");

  const keysByText = new Map<string, bigint>();
  for (const branchId of new Set(branchIds)) {
    const key = await inventoryBranchLockKey(tx, branchId);
    keysByText.set(key.toString(), key);
  }
  const keys = [...keysByText.values()].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  for (const key of keys) {
    await tx.$queryRaw<{ locked: string }[]>`
      SELECT pg_advisory_xact_lock_shared(${key}::bigint)::text AS locked
    `;
  }
  return { keys };
}

export async function acquireInventoryExclusiveLock(
  tx: Prisma.TransactionClient,
  branchId: string
): Promise<{ key: bigint }> {
  const key = await inventoryBranchLockKey(tx, branchId);
  await tx.$queryRaw<{ locked: string }[]>`
    SELECT pg_advisory_xact_lock(${key}::bigint)::text AS locked
  `;
  return { key };
}

export async function activeFreezeFor(
  tx: Prisma.TransactionClient,
  branchId: string
): Promise<{ freezeId: string; handoverId: string } | null> {
  const freeze = await tx.inventoryFreeze.findFirst({
    where: { branchId, releasedAt: null },
    select: { id: true, handoverId: true },
  });
  return freeze ? { freezeId: freeze.id, handoverId: freeze.handoverId } : null;
}

type AcquireArgs = {
  cafeId: string;
  branchId: string;
  handoverId: string;
  startedById: string;
};

async function validateAcquireIntegrity(tx: Prisma.TransactionClient, args: AcquireArgs) {
  const branch = await tx.branch.findFirst({
    where: { id: args.branchId, cafeId: args.cafeId }, select: { id: true },
  });
  if (!branch) throw new ApiError(409, "Handover does not match the inventory branch");

  const handover = await tx.handoverSession.findFirst({
    where: { id: args.handoverId, cafeId: args.cafeId, branchId: args.branchId },
    select: { id: true },
  });
  if (!handover) throw new ApiError(409, "Handover does not match the inventory branch");

  const actor = await tx.user.findUnique({
    where: { id: args.startedById }, select: { cafeId: true, role: true },
  });
  if (!actor || (actor.role !== "SUPER_ADMIN" && actor.cafeId !== args.cafeId)) {
    throw new ApiError(403, "Actor does not belong to this cafe");
  }
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

export async function acquireInventoryFreeze(
  tx: Prisma.TransactionClient,
  args: AcquireArgs
): Promise<{ freezeId: string; alreadyHeld: boolean }> {
  // Minimum tenant reads precede the advisory lock; lifecycle decisions do not.
  await validateAcquireIntegrity(tx, args);
  await acquireInventoryExclusiveLock(tx, args.branchId);
  await validateAcquireIntegrity(tx, args);

  const sameHandover = await tx.inventoryFreeze.findUnique({
    where: { handoverId: args.handoverId }, select: { id: true, releasedAt: true },
  });
  if (sameHandover) {
    if (sameHandover.releasedAt) {
      throw new ApiError(409, "This handover's inventory freeze was already released");
    }
    return { freezeId: sameHandover.id, alreadyHeld: true };
  }

  const active = await activeFreezeFor(tx, args.branchId);
  if (active) throw new ApiError(409, "This branch already has an active inventory freeze");

  const startedAt = new Date();
  try {
    const freeze = await tx.inventoryFreeze.create({
      data: { ...args, startedAt },
      select: { id: true },
    });
    await auditInTransaction(tx, {
      cafeId: args.cafeId,
      userId: args.startedById,
      action: "INVENTORY_FROZEN",
      entity: "InventoryFreeze",
      entityId: freeze.id,
      details: {
        branchId: args.branchId,
        handoverId: args.handoverId,
        startedAt: startedAt.toISOString(),
      },
    });
    return { freezeId: freeze.id, alreadyHeld: false };
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    // PostgreSQL has already aborted this transaction after the constraint
    // violation, so do not attempt a second query here. Normal idempotency and
    // branch conflicts are decided above while holding EXCLUSIVE; this is only
    // the defensive database-constraint fallback.
    throw new ApiError(409, "This branch already has an active inventory freeze");
  }
}

export async function releaseInventoryFreeze(
  tx: Prisma.TransactionClient,
  args: { handoverId: string; actorId: string }
): Promise<{ released: boolean }> {
  const preliminary = await tx.inventoryFreeze.findUnique({
    where: { handoverId: args.handoverId },
    select: { id: true, cafeId: true, branchId: true },
  });
  if (!preliminary) throw new ApiError(404, "Inventory freeze not found");

  const actor = await tx.user.findUnique({
    where: { id: args.actorId }, select: { cafeId: true, role: true },
  });
  if (!actor || (actor.role !== "SUPER_ADMIN" && actor.cafeId !== preliminary.cafeId)) {
    throw new ApiError(403, "Actor does not belong to this cafe");
  }

  await acquireInventoryExclusiveLock(tx, preliminary.branchId);
  const freeze = await tx.inventoryFreeze.findUniqueOrThrow({
    where: { handoverId: args.handoverId },
    select: { id: true, cafeId: true, branchId: true, releasedAt: true },
  });
  if (freeze.releasedAt) return { released: false };

  const releasedAt = new Date();
  await tx.inventoryFreeze.update({
    where: { id: freeze.id }, data: { releasedAt, releasedById: args.actorId },
  });
  await auditInTransaction(tx, {
    cafeId: freeze.cafeId,
    userId: args.actorId,
    action: "INVENTORY_FREEZE_RELEASED",
    entity: "InventoryFreeze",
    entityId: freeze.id,
    details: {
      branchId: freeze.branchId,
      handoverId: args.handoverId,
      releasedAt: releasedAt.toISOString(),
    },
  });
  return { released: true };
}
