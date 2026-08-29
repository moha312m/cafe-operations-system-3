import { db } from "@/lib/db";
import type { Prisma } from "@prisma/client";

// Fire-and-forget audit trail. Failures are logged but never block the
// action being audited.
//
// That default is right for the ordinary case: losing a log line is worse
// than losing the action it describes, so `audit` swallows. It is NOT right
// for every case — see `auditInTransaction` below, for writes whose audit
// row is part of the evidence rather than a note about it.
export async function audit(entry: {
  cafeId?: string | null;
  userId?: string | null;
  action: string; // "order.create", "auth.login", ...
  entity: string;
  entityId?: string | null;
  details?: Prisma.InputJsonValue;
}) {
  try {
    await db.auditLog.create({
      data: {
        cafeId: entry.cafeId ?? null,
        userId: entry.userId ?? null,
        action: entry.action,
        entity: entry.entity,
        entityId: entry.entityId ?? null,
        details: entry.details,
      },
    });
  } catch (e) {
    console.error("audit log failed", e);
  }
}

/**
 * An audit row that is part of the write it describes.
 *
 * Same table, opposite failure policy, and the difference is deliberate.
 * `audit` above swallows because a logging failure must not destroy a real
 * action. This one throws, because for an accountability-sensitive mutation
 * the audit row IS part of the action: a COUNT_REBASE that moved a shelf and
 * left no record of who moved it or what arithmetic produced it is not a
 * successful write with a missing note — it is stock changing for reasons
 * nobody can reconstruct.
 *
 * Takes the caller's transaction client so the row commits or rolls back
 * with the mutation, rather than in a second transaction that could succeed
 * or fail independently of it.
 */
export async function auditInTransaction(
  tx: Prisma.TransactionClient,
  entry: {
    cafeId?: string | null;
    userId?: string | null;
    action: string;
    entity: string;
    entityId?: string | null;
    details?: Prisma.InputJsonValue;
  }
) {
  await tx.auditLog.create({
    data: {
      cafeId: entry.cafeId ?? null,
      userId: entry.userId ?? null,
      action: entry.action,
      entity: entry.entity,
      entityId: entry.entityId ?? null,
      details: entry.details,
    },
  });
}
