export type OrderPage<T> = { orders: T[]; pageInfo: { hasMore: boolean; nextCursor: string | null } };
export async function collectOrderPages<T extends {id:string}>(
  read: (cursor: string | null) => Promise<OrderPage<T>>,
  maxPages = 100,
  allowPartial = false,
): Promise<OrderPage<T>> {
  const orders = new Map<string, T>();
  const seen = new Set<string>();
  let cursor: string | null = null;
  for (let index = 0; index < maxPages; index++) {
    const page = await read(cursor);
    if (!page.pageInfo || page.pageInfo.hasMore !== !!page.pageInfo.nextCursor ||
        (page.pageInfo.nextCursor && seen.has(page.pageInfo.nextCursor))) {
      throw new Error("Invalid order pagination response");
    }
    for (const order of page.orders) orders.set(order.id, order);
    cursor = page.pageInfo.nextCursor;
    if (!cursor || (allowPartial && index + 1 === maxPages)) {
      return { orders: [...orders.values()], pageInfo: page.pageInfo };
    }
    seen.add(cursor);
  }
  throw new Error("Order queue page limit reached; narrow the branch filter");
}
