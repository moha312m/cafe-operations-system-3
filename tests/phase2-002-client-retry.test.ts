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
