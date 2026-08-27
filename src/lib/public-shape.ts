// What an inventory row looks like once it leaves the server.
//
// `InventoryItem.ledgerVersion` and `InventoryTransaction.itemVersion` are
// internal concurrency machinery: the item-local cursor that makes a count
// point meaningful (src/lib/ledger.ts). They are deliberately NOT hidden at
// the Prisma client, because the services that maintain the invariant — the
// guarded writer, the count point, the rebase replay — must be able to read
// them. The line is drawn at the HTTP boundary instead:
//
//   database / internal service   ledgerVersion and itemVersion available
//   HTTP response                 both absent
//
// Two reasons they must not travel. They are BigInt, and `JSON.stringify`
// throws on BigInt, so a route that returned the row whole would 500 — three
// did. And they are not part of any API contract: a client has no use for a
// counter whose meaning depends on holding a row lock, and publishing one
// invites somebody to reason about it without that lock.
//
// The fix is a mapper rather than a `select` at each call site because these
// routes return rows assembled elsewhere (the recipe resolver, the guarded
// writer's re-read); redacting on the way out keeps one rule in one place
// and leaves the internal shapes untouched.

/**
 * Drop one key from an object without naming a variable for the value.
 *
 * The obvious `const { x: _drop, ...rest }` reads well but leaves an unused
 * binding, which the project's lint config reports — and this milestone is
 * held to "no new lint findings". Deleting from a shallow copy says the same
 * thing with nothing left over.
 */
function without<T extends object, K extends keyof T>(source: T, key: K): Omit<T, K> {
  const copy = { ...source };
  delete copy[key];
  return copy;
}

/** An inventory item as the API presents it: no internal version counter. */
export function publicInventoryItem<T extends { ledgerVersion?: unknown }>(
  item: T
): Omit<T, "ledgerVersion"> {
  return without(item, "ledgerVersion");
}

/** A ledger row as the API presents it: no internal version stamp. */
export function publicInventoryTransaction<T extends { itemVersion?: unknown }>(
  txn: T
): Omit<T, "itemVersion"> {
  return without(txn, "itemVersion");
}

/**
 * A recipe item carries a whole `inventoryItem`, so the redaction has to
 * reach one level down — the field would otherwise ride out nested inside a
 * response that looks like it is about recipes.
 */
export function publicRecipeItem<
  T extends { inventoryItem: { ledgerVersion?: unknown } },
>(recipeItem: T): Omit<T, "inventoryItem"> & {
  inventoryItem: Omit<T["inventoryItem"], "ledgerVersion">;
} {
  return { ...recipeItem, inventoryItem: publicInventoryItem(recipeItem.inventoryItem) };
}

export function publicRecipeItems<
  T extends { inventoryItem: { ledgerVersion?: unknown } },
>(items: T[]) {
  return items.map(publicRecipeItem);
}
