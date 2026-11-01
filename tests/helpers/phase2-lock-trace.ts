import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { optionalProtectedContext } from "@/lib/protected-transaction";

/** Observe real production transaction SQL without a production test seam. */
export async function observeTransactionSql<T>(work: () => Promise<T>) {
  const original = db.$transaction;
  const sql: string[] = [];
  const traces: { entity: string; ids: string[]; mode: string }[][] = [];
  db.$transaction = new Proxy(original, { apply(target, thisArg, args) {
    if (typeof args[0] !== "function") return Reflect.apply(target, thisArg, args);
    const callback = args[0] as (tx: Prisma.TransactionClient) => Promise<unknown>;
    args[0] = async (tx: Prisma.TransactionClient) => {
      const observed = new Proxy(tx, { get(client, property) {
      const value = Reflect.get(client, property);
      if (property !== "$queryRaw" && property !== "$executeRaw") return value;
      return (...queryArgs: unknown[]) => {
        const render = (strings: readonly string[], values: unknown[]): string => strings.reduce((text, part, index) => {
          if (!index) return part;
          const value = values[index - 1] as { strings?: string[]; values?: unknown[] } | null;
          return text + (value?.strings ? render(value.strings, value.values ?? []) : "?") + part;
        }, "");
        const first = queryArgs[0] as { strings?: string[]; values?: unknown[] } | string[];
        sql.push(Array.isArray(first) ? render(first, queryArgs.slice(1)) : render(first.strings ?? [], first.values ?? []));
        return Reflect.apply(value, client, queryArgs);
      };
      } });
      try { return await callback(observed); }
      finally { const context = optionalProtectedContext(observed); if (context) traces.push(context.trace.map(lock => ({ ...lock, ids: [...lock.ids] }))); }
    };
    return Reflect.apply(target, thisArg, args);
  } });
  try { return { result: await work(), sql, traces }; }
  finally { db.$transaction = original; }
}
