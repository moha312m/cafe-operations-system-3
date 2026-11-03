import { test } from "node:test";
import assert from "node:assert/strict";
import { api } from "../src/lib/client";
import { beginExpenseIntent, loadExpenseIntent, completeExpenseIntent } from "../src/lib/expense-intent";
function storage() {
  const rows = new Map<string, string>();
  return { getItem: (key: string) => rows.get(key) ?? null, setItem: (key: string, value: string) => { rows.set(key, value); }, removeItem: (key: string) => { rows.delete(key); } };
}
for (const path of ["/api/expenses", "/api/expenses/original/returns"]) test(path + " restores unresolved identity and payload after reload before accepting a new identical intent", () => {
  const store = storage(), owner = "cafe:actor";
  const body = path === "/api/expenses" ? { branchId: "b", categoryId: "c", amount: 120, description: "Cleaning" } : { amount: 20, reason: "Actual cash received" };
  const first = beginExpenseIntent(store, owner, path, body);
  // New component state after navigation/reload is reconstructed from storage.
  const recovered = loadExpenseIntent(store, owner, path)!;
  assert.equal(recovered.key, first.key);
  assert.deepEqual(recovered.body, body);
  assert.throws(() => beginExpenseIntent(store, owner, path, body));
  assert.equal(loadExpenseIntent(store, "cafe:other-actor", path), null);
  assert.equal(completeExpenseIntent(store, owner, recovered), true);
  const next = beginExpenseIntent(store, owner, path, body);
  assert.notEqual(next.key, first.key);
  assert.equal(completeExpenseIntent(store, owner, first), false, "a late prior response cannot erase the next pending action");
  assert.equal(loadExpenseIntent(store, owner, path)!.key, next.key);
});
test("cash requests fail closed when their identity and payload cannot be persisted", () => {
  const broken = { getItem: () => null, setItem: () => { throw new Error("unavailable"); }, removeItem: () => {} };
  assert.throws(() => beginExpenseIntent(broken, "c:a", "/api/expenses", { branchId: "b", categoryId: "c", amount: 1, description: "Cleaning" }));
});

for (const path of ["/api/expenses", "/api/expenses/original/returns"]) test(path + " sends the restored key, then a fresh key for the next identical cash action", async () => {
  const store = storage(), owner = "c:a", originalFetch = globalThis.fetch;
  const body = path === "/api/expenses" ? { branchId: "b", categoryId: "c", amount: 120, description: "Cleaning" } : { amount: 20, reason: "Cash returned" };
  const keys: string[] = []; let attempt = 0;
  globalThis.fetch = async (_url, init) => {
    keys.push(new Headers(init?.headers).get("Idempotency-Key") ?? ""); attempt++;
    if (attempt === 1) throw new Error("response lost after commit");
    return Response.json({ id: "receipt" });
  };
  try {
    const first = beginExpenseIntent(store, owner, path, body);
    await assert.rejects(api(path, { method: "POST", body: first.body, idempotencyKey: first.key }));
    const restored = loadExpenseIntent(store, owner, path)!;
    await api(path, { method: "POST", body: restored.body, idempotencyKey: restored.key });
    assert.equal(completeExpenseIntent(store, owner, restored), true);
    const next = beginExpenseIntent(store, owner, path, body);
    await api(path, { method: "POST", body: next.body, idempotencyKey: next.key });
    assert.deepEqual(keys, [first.key, first.key, next.key]);
    assert.notEqual(first.key, next.key);
  } finally { globalThis.fetch = originalFetch; }
});
