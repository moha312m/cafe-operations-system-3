import { createHash } from "node:crypto";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { ApiError } from "@/lib/api";

const boundary = z.object({ at: z.iso.datetime(), id: z.string().min(1).max(200) });
const cursorSchema = z.object({ v: z.literal(1), scope: z.string().length(64), upper: boundary, last: boundary });
type Boundary = z.infer<typeof boundary>;
type Cursor = z.infer<typeof cursorSchema>;

function before(point: Boundary, inclusive = false): Prisma.OrderWhereInput {
  return { OR: [
    { createdAt: { lt: new Date(point.at) } },
    { createdAt: new Date(point.at), id: inclusive ? { lte: point.id } : { lt: point.id } },
  ] };
}

// A cursor is a position, never authority. Each request keeps its tenant,
// branch and role predicates, and changed filters invalidate the position.
export function orderPage(params: URLSearchParams, filters: Prisma.OrderWhereInput) {
  const rawSize = params.get("pageSize") ?? "100";
  if (!/^\d+$/.test(rawSize) || Number(rawSize) < 1 || Number(rawSize) > 100) {
    throw new ApiError(400, "pageSize must be an integer from 1 to 100");
  }
  const pageSize = Number(rawSize);
  function date(key: string) {
    const raw = params.get(key);
    if (raw === null) return undefined;
    if (!z.iso.datetime({ offset: true }).safeParse(raw).success) throw new ApiError(400, `${key} must be an ISO timestamp with timezone`);
    return new Date(raw);
  }
  const from = date("from"), to = date("to");
  if (from && to && from >= to) throw new ApiError(400, "from must precede to");
  const where: Prisma.OrderWhereInput = { ...filters, ...(from || to ? { createdAt: { gte: from, lt: to } } : {}) };
  const scope = createHash("sha256").update(JSON.stringify(where)).digest("hex");
  let cursor: Cursor | undefined;
  const raw = params.get("cursor");
  if (raw !== null) {
    try {
      if (raw.length > 2000 || !/^[A-Za-z0-9_-]+$/.test(raw)) throw Error();
      cursor = cursorSchema.parse(JSON.parse(Buffer.from(raw, "base64url").toString("utf8")));
      if (cursor.scope !== scope) throw Error();
    } catch { throw new ApiError(400, "Invalid cursor for these filters and scope"); }
  }
  return {
    pageSize,
    where: cursor ? { AND: [where, before(cursor.upper, true), before(cursor.last)] } : where,
    finish<T extends { id: string; createdAt: Date }>(rows: T[]) {
      const hasMore = rows.length > pageSize;
      const orders = rows.slice(0, pageSize);
      const head = orders[0], tail = orders.at(-1);
      const nextCursor = hasMore && head && tail ? Buffer.from(JSON.stringify({
        v: 1, scope, upper: cursor?.upper ?? { at: head.createdAt.toISOString(), id: head.id },
        last: { at: tail.createdAt.toISOString(), id: tail.id },
      } satisfies Cursor)).toString("base64url") : null;
      return { orders, pageInfo: { pageSize, hasMore, nextCursor } };
    },
  };
}
