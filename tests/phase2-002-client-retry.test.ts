import { test } from "node:test";
import assert from "node:assert/strict";
import { webcrypto, createHash } from "node:crypto";
import { api } from "@/lib/client";
import { clientPayloadHash } from "@/lib/client-request-key";

test("LAN retry identities match SHA-256 for UTF-8 and multiple blocks", () => {
  for (const body of ["", "abc", "عميل الكافيه", "x".repeat(64), "payload".repeat(100)]) {
    assert.equal(clientPayloadHash(body), createHash("sha256").update(body).digest("hex"));
  }
});

test("LAN HTTP clients preserve their key after losing a response", async () => {
  const cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  const originalFetch = globalThis.fetch;
  const keys: string[] = [];
  Object.defineProperty(globalThis, "crypto", { configurable: true, value: {
    getRandomValues: webcrypto.getRandomValues.bind(webcrypto),
  } });
  globalThis.fetch = async (_url, init) => {
    keys.push(new Headers(init?.headers).get("Idempotency-Key") ?? "");
    if (keys.length === 1) throw new Error("Response lost after commit");
    return Response.json({ id: "cached-order" }, { status: 201 });
  };
  try {
    const options = { method: "POST", body: { customerName: "LAN guest", items: [] } };
    await assert.rejects(api("/api/orders", options), /Response lost after commit/);
    assert.deepEqual(await api("/api/orders", options), { id: "cached-order" });
    assert.match(keys[0], /^[0-9a-f-]{36}$/);
    assert.equal(keys[1], keys[0]);
    await api("/api/orders", options);
    assert.notEqual(keys[2], keys[0], "a successfully acknowledged sale completes its retry key");
  } finally {
    globalThis.fetch = originalFetch;
    if (cryptoDescriptor) Object.defineProperty(globalThis, "crypto", cryptoDescriptor);
  }
});

test("late duplicate acknowledgment cannot erase a newer identical sale key", async () => {
  const originalFetch = globalThis.fetch;
  const requests: { key: string; resolve: (response: Response) => void }[] = [];
  globalThis.fetch = async (_url, init) => new Promise<Response>(resolve => {
    requests.push({ key: new Headers(init?.headers).get("Idempotency-Key") ?? "", resolve });
  });
  const settle = () => new Promise<void>(resolve => setImmediate(resolve));
  try {
    const options = { method: "POST", body: { customerName: "late-response-case", items: [] } };
    const first = api("/api/orders", options), duplicate = api("/api/orders", options);
    await settle(); assert.equal(requests[0].key, requests[1].key);
    requests[0].resolve(Response.json({ id: "old" }, { status: 201 })); await first;
    const newSale = api("/api/orders", options); await settle();
    assert.notEqual(requests[2].key, requests[0].key);
    requests[1].resolve(Response.json({ id: "old" }, { status: 201 })); await duplicate;
    const retryNewSale = api("/api/orders", options); await settle();
    // Capture before resolving so a failure does not leave promises hanging.
    const newKey = requests[2].key, retryKey = requests[3].key;
    requests[2].resolve(Response.json({ id: "new" }, { status: 201 }));
    requests[3].resolve(Response.json({ id: "new" }, { status: 201 }));
    await Promise.all([newSale, retryNewSale]);
    assert.equal(retryKey, newKey);
  } finally { globalThis.fetch = originalFetch; }
});

// Stock movements get the sale lifecycle: one key per operation until the
// server answers it definitively, so a retry replays instead of moving stock twice.
const INVENTORY_POSTS = [
  { path: "/api/inventory/transfer", body: { inventoryItemId: "item-1", toBranchId: "branch-2", quantity: 2 } },
  { path: "/api/inventory/item-1/movement", body: { type: "WASTE", quantity: 1, note: "spill" } },
];
const UUID = /^[0-9a-f-]{36}$/;

test("inventory transfers and movements keep one key through lost, 5xx and 409 answers, then rotate", async () => {
  const originalFetch = globalThis.fetch;
  const answers: (() => Response)[] = [];
  const keys: string[] = [];
  globalThis.fetch = async (_url, init) => {
    keys.push(new Headers(init?.headers).get("Idempotency-Key") ?? "");
    return answers.shift()!();
  };
  try {
    for (const { path, body } of INVENTORY_POSTS) {
      keys.length = 0;
      const options = { method: "POST", body };
      answers.push(
        () => { throw new Error("Response lost after commit"); },
        () => Response.json({ error: "temporarily unavailable" }, { status: 503 }),
        () => Response.json({ error: "still in progress" }, { status: 409 }),
        () => Response.json({ ok: true }),
        () => Response.json({ error: "invalid quantity" }, { status: 400 }),
        () => Response.json({ ok: true }),
      );
      await assert.rejects(api(path, options), /Response lost after commit/);
      await assert.rejects(api(path, options), /temporarily unavailable/);
      await assert.rejects(api(path, options), /still in progress/);
      assert.deepEqual(await api(path, options), { ok: true });
      await assert.rejects(api(path, options), /invalid quantity/);
      await api(path, options);
      assert.match(keys[0], UUID, path);
      assert.deepEqual(keys.slice(1, 4), [keys[0], keys[0], keys[0]], `${path}: one operation keeps one key`);
      assert.match(keys[4], UUID, path);
      assert.notEqual(keys[4], keys[0], `${path}: an acknowledged movement completes its key`);
      assert.notEqual(keys[5], keys[4], `${path}: a definitive refusal completes its key too`);
    }
  } finally { globalThis.fetch = originalFetch; }
});

test("overlapping inventory submissions share a key; a late duplicate answer cannot clear a newer one", async () => {
  const originalFetch = globalThis.fetch;
  const settle = () => new Promise<void>(resolve => setImmediate(resolve));
  try {
    for (const { path, body } of INVENTORY_POSTS) {
      const requests: { key: string; resolve: (response: Response) => void }[] = [];
      globalThis.fetch = async (_url, init) => new Promise<Response>(resolve => {
        requests.push({ key: new Headers(init?.headers).get("Idempotency-Key") ?? "", resolve });
      });
      const options = { method: "POST", body };
      const first = api(path, options), duplicate = api(path, options);
      await settle();
      assert.match(requests[0].key, UUID, path);
      assert.equal(requests[1].key, requests[0].key, `${path}: a double submit is one operation`);
      requests[0].resolve(Response.json({ ok: true })); await first;
      const next = api(path, options); await settle();
      assert.notEqual(requests[2].key, requests[0].key, `${path}: the next identical movement is new`);
      requests[1].resolve(Response.json({ ok: true })); await duplicate;
      const retryNext = api(path, options); await settle();
      const newKey = requests[2].key, retryKey = requests[3].key;
      requests[2].resolve(Response.json({ ok: true }));
      requests[3].resolve(Response.json({ ok: true }));
      await Promise.all([next, retryNext]);
      assert.equal(retryKey, newKey, `${path}: the late answer left the newer key alone`);
    }
  } finally { globalThis.fetch = originalFetch; }
});

test("sales, supplier payments and linked returns stay protected; reads and other inventory writes stay plain", async () => {
  const originalFetch = globalThis.fetch;
  const seen: (string | null)[] = [];
  globalThis.fetch = async (_url, init) => {
    seen.push(new Headers(init?.headers).get("Idempotency-Key"));
    return Response.json({});
  };
  try {
    await api("/api/orders", { method: "POST", body: { items: [] } });
    await api("/api/purchases/p-1/payments", { method: "POST", body: { amount: 5, method: "CASH" } });
    await api("/api/inventory/item-1/movement", { method: "POST", body: { type: "RETURN", orderItemId: "line-1", quantity: 1 } });
    await api("/api/inventory/item-1/movement", { method: "POST", body: { type: "ADJUSTMENT", quantity: -1 } });
    await api("/api/inventory/transfer", { method: "POST", body: { inventoryItemId: "item-1", toBranchId: "b-2", quantity: 1 } });
    await api("/api/inventory/item-1/movement", { method: "POST", body: { type: "WASTE", quantity: 1 }, idempotencyKey: "caller-chosen-key" });
    await api("/api/inventory/item-1/movement");
    await api("/api/inventory/item-1", { method: "PATCH", body: { name: "renamed" } });
    await api("/api/inventory", { method: "POST", body: { name: "new item" } });
    await api("/api/purchases", { method: "POST", body: { items: [] } });
    assert.deepEqual(seen.map((key) => key === null ? "plain" : key === "caller-chosen-key" ? "explicit" : UUID.test(key) ? "keyed" : key), [
      "keyed", "keyed", "keyed", "keyed", "keyed", "explicit", "plain", "plain", "plain", "plain",
    ]);
  } finally { globalThis.fetch = originalFetch; }
});
