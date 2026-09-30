import { Prisma } from "@prisma/client";
import { ApiError } from "@/lib/api";
import { auditInTransaction } from "@/lib/audit";

const INVENTORY_LOCK_SEED = BigInt(1313035600);

type ActiveFreeze = { freezeId: string; handoverId: string };

type BranchInventoryMemo = {
  key?: bigint;
  sharedLockHeld: boolean;
  exclusiveLockHeld: boolean;
  freezeKnown: boolean;
  freeze: ActiveFreeze | null;
};

type TransactionInventoryMemo = {
  branches: Map<string, BranchInventoryMemo>;
  sharedKeys: Set<string>;
  exclusiveKeys: Set<string>;
  highestAcquiredKey?: bigint;
};

// This is an optimization only. PostgreSQL advisory transaction locks remain
// the correctness mechanism; object identity prevents sharing across requests.
const INVENTORY_TX_MEMO = new WeakMap<object, TransactionInventoryMemo>();

function transactionMemo(tx: Prisma.TransactionClient): TransactionInventoryMemo {
  const identity = tx as unknown as object;
  let memo = INVENTORY_TX_MEMO.get(identity);
  if (!memo) {
    memo = { branches: new Map(), sharedKeys: new Set(), exclusiveKeys: new Set() };
    INVENTORY_TX_MEMO.set(identity, memo);
  }
  return memo;
}

function branchMemo(tx: Prisma.TransactionClient, branchId: string): BranchInventoryMemo {
  const memo = transactionMemo(tx);
  let branch = memo.branches.get(branchId);
  if (!branch) {
    branch = { sharedLockHeld: false, exclusiveLockHeld: false, freezeKnown: false, freeze: null };
    memo.branches.set(branchId, branch);
  }
  return branch;
}

function lockProtectionHeld(branch: BranchInventoryMemo): boolean {
  return branch.sharedLockHeld || branch.exclusiveLockHeld;
}

function rememberFreeze(tx: Prisma.TransactionClient, branchId: string, freeze: ActiveFreeze | null) {
  const branch = branchMemo(tx, branchId);
  branch.freezeKnown = true;
  branch.freeze = freeze;
}

function invalidateFreeze(tx: Prisma.TransactionClient, branchId: string) {
  const branch = branchMemo(tx, branchId);
  branch.freezeKnown = false;
  branch.freeze = null;
}

function assertLockOrder(memo: TransactionInventoryMemo, keys: bigint[]) {
  const firstNewKey = keys[0];
  if (firstNewKey !== undefined && memo.highestAcquiredKey !== undefined && firstNewKey < memo.highestAcquiredKey) {
    throw new Error("Inventory advisory lock order violation: cannot acquire a lower key after a higher key");
  }
}

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
  const branch = branchMemo(tx, branchId);
  if (branch.key !== undefined) return branch.key;
  const rows = await tx.$queryRaw<{ key: bigint }[]>`
    SELECT hashtextextended(${branchId}::text, ${INVENTORY_LOCK_SEED}::bigint) AS key
  `;
  if (rows.length !== 1) throw new Error("PostgreSQL did not derive an inventory branch lock key");
  branch.key = rows[0].key;
  return branch.key;
}

export async function acquireInventorySharedLocks(
  tx: Prisma.TransactionClient,
  branchIds: string[]
): Promise<{ keys: bigint[] }> {
  if (branchIds.length === 0) throw new Error("At least one validated branch id is required");

  const uniqueBranchIds = [...new Set(branchIds)];
  const keysByText = new Map<string, { key: bigint; branchIds: string[] }>();
  for (const branchId of uniqueBranchIds) {
    const key = await inventoryBranchLockKey(tx, branchId);
    const text = key.toString();
    const existing = keysByText.get(text);
    if (existing) existing.branchIds.push(branchId);
    else keysByText.set(text, { key, branchIds: [branchId] });
  }
  const entries = [...keysByText.values()].sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  const memo = transactionMemo(tx);
  const newEntries = entries.filter(({ key }) => !memo.sharedKeys.has(key.toString()) && !memo.exclusiveKeys.has(key.toString()));
  assertLockOrder(memo, newEntries.map(({ key }) => key));
  for (const { key } of newEntries) {
    await tx.$queryRaw<{ locked: string }[]>`
      SELECT pg_advisory_xact_lock_shared(${key}::bigint)::text AS locked
    `;
    memo.sharedKeys.add(key.toString());
    memo.highestAcquiredKey = memo.highestAcquiredKey === undefined || key > memo.highestAcquiredKey
      ? key
      : memo.highestAcquiredKey;
  }
  for (const { key, branchIds: protectedBranches } of entries) {
    const keyText = key.toString();
    for (const branchId of protectedBranches) {
      const branch = branchMemo(tx, branchId);
      if (memo.exclusiveKeys.has(keyText)) branch.exclusiveLockHeld = true;
      else if (memo.sharedKeys.has(keyText)) branch.sharedLockHeld = true;
    }
  }
  return { keys: entries.map(({ key }) => key) };
}

export async function acquireInventoryExclusiveLock(
  tx: Prisma.TransactionClient,
  branchId: string
): Promise<{ key: bigint }> {
  const key = await inventoryBranchLockKey(tx, branchId);
  const memo = transactionMemo(tx);
  const keyText = key.toString();
  if (memo.exclusiveKeys.has(keyText)) {
    branchMemo(tx, branchId).exclusiveLockHeld = true;
    return { key };
  }
  assertLockOrder(memo, memo.sharedKeys.has(keyText) ? [] : [key]);
  await tx.$queryRaw<{ locked: string }[]>`
    SELECT pg_advisory_xact_lock(${key}::bigint)::text AS locked
  `;
  memo.exclusiveKeys.add(keyText);
  memo.highestAcquiredKey = memo.highestAcquiredKey === undefined || key > memo.highestAcquiredKey
    ? key
    : memo.highestAcquiredKey;
  branchMemo(tx, branchId).exclusiveLockHeld = true;
  return { key };
}

export async function activeFreezeFor(
  tx: Prisma.TransactionClient,
  branchId: string
): Promise<{ freezeId: string; handoverId: string } | null> {
  const branch = branchMemo(tx, branchId);
  if (lockProtectionHeld(branch) && branch.freezeKnown) return branch.freeze;
  const freeze = await tx.inventoryFreeze.findFirst({
    where: { branchId, releasedAt: null },
    select: { id: true, handoverId: true },
  });
  const result = freeze ? { freezeId: freeze.id, handoverId: freeze.handoverId } : null;
  if (lockProtectionHeld(branch)) rememberFreeze(tx, branchId, result);
  return result;
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
    rememberFreeze(tx, args.branchId, { freezeId: sameHandover.id, handoverId: args.handoverId });
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
    rememberFreeze(tx, args.branchId, { freezeId: freeze.id, handoverId: args.handoverId });
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
  if (freeze.releasedAt) {
    invalidateFreeze(tx, freeze.branchId);
    return { released: false };
  }

  const releasedAt = new Date();
  await tx.inventoryFreeze.update({
    where: { id: freeze.id }, data: { releasedAt, releasedById: args.actorId },
  });
  invalidateFreeze(tx, freeze.branchId);
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
