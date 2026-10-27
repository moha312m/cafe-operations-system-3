import { db } from "@/lib/db";
import type { Prisma } from "@prisma/client";
import { auditInTransaction } from "@/lib/audit";

export type TransactionScope = { cafeId?: string; branchId?: string };
export type LockTrace = { entity: string; ids: string[]; mode: string };
type RefusalEntry = Parameters<typeof auditInTransaction>[1];
export type ProtectedContext = {
  scope: TransactionScope;
  held: Map<string, Set<string>>;
  highestRank: number;
  trace: LockTrace[];
  refusals: RefusalEntry[];
};
const contexts = new WeakMap<object, ProtectedContext>();

export async function initializeProtectedTransaction(tx: Prisma.TransactionClient, scope: TransactionScope = {}) {
  if (contexts.has(tx)) return contexts.get(tx)!;
  await tx.$executeRaw`SET LOCAL lock_timeout = '2s'`;
  await tx.$executeRaw`SET LOCAL statement_timeout = '5s'`;
  const context: ProtectedContext = { scope, held: new Map(), highestRank: 0, trace: [], refusals: [] };
  contexts.set(tx, context);
  return context;
}

export function protectedContext(tx: Prisma.TransactionClient): ProtectedContext {
  const context = contexts.get(tx);
  if (!context) throw new Error("Protected transaction must be initialized before business work");
  return context;
}

/** Shared stock helpers also serve transactions outside Phase 2. */
export function optionalProtectedContext(tx: Prisma.TransactionClient): ProtectedContext | undefined {
  return contexts.get(tx);
}

/** Evidence is held in memory until the business transaction has rolled back. */
export function queueRefusalAudit(tx: Prisma.TransactionClient, entry: RefusalEntry) {
  protectedContext(tx).refusals.push(entry);
}

export async function protectedTransaction<T>(
  work: (tx: Prisma.TransactionClient) => Promise<T>,
  scope: TransactionScope = {},
): Promise<T> {
  let refusals: RefusalEntry[] = [];
  let callbackFailed = false;
  try {
    return await db.$transaction(async (tx) => {
      const context = await initializeProtectedTransaction(tx, scope);
      refusals = context.refusals;
      try { return await work(tx); } catch (error) { callbackFailed = true; throw error; }
    }, { maxWait: 10_000, timeout: 30_000 });
  } catch (error) {
    // This runs after Prisma has left the business transaction. Never replace
    // its original failure with a logging failure or expose SQL internals.
    if (callbackFailed && refusals.length) {
      try {
        await db.$transaction(async (tx) => {
          await initializeProtectedTransaction(tx);
          for (const entry of refusals) await auditInTransaction(tx, entry);
        }, { maxWait: 3_000, timeout: 10_000 });
      } catch { console.error("Refusal audit persistence failed after business rollback"); }
    }
    throw error;
  }
}
