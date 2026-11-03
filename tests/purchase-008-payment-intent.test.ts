import { test } from "node:test";
import assert from "node:assert/strict";
import {
  beginPaymentIntent, completePaymentIntent, loadPaymentIntent, paymentIntentOwner, paymentIntentPath, paymentIntentSurvives, purchasePaymentBody,
} from "@/lib/purchase-payment-intent";

// A supplier payment the browser could not confirm must survive reload as one
// identity and one exact payload, scoped to the actor, café, branch and invoice.

class Store {
  data = new Map<string, string>();
  failGet = false; failSet = false; dropWrites = false;
  getItem(k: string) { if (this.failGet) throw new Error("storage read blocked"); return this.data.get(k) ?? null; }
  setItem(k: string, v: string) { if (this.failSet) throw new Error("storage write blocked"); if (!this.dropWrites) this.data.set(k, v); }
  removeItem(k: string) { this.data.delete(k); }
}
const owner = paymentIntentOwner({ id: "user-1", cafeId: "cafe-1", branchId: "branch-1" });
const path = paymentIntentPath("invoice-1");
const body = { amount: 70, method: "CASH", fundingSource: "DRAWER", note: "ACC01B" } as const;

test("a begun payment reloads with the exact key and body", () => {
  const store = new Store();
  const intent = beginPaymentIntent(store, owner, path, body);
  assert.equal(intent.path, "/api/purchases/invoice-1/payments");
  assert.match(intent.key, /^[0-9a-f-]{36}$/);
  const reloaded = loadPaymentIntent(store, owner, path);
  assert.deepEqual(reloaded, intent);
  assert.throws(() => beginPaymentIntent(store, owner, path, { ...body, amount: 60 }), /استعد نتيجة الدفعة السابقة/);
});

test("completion removes only the matching key, never a different pending payment", () => {
  const store = new Store();
  const first = beginPaymentIntent(store, owner, path, body);
  assert.equal(completePaymentIntent(store, owner, { ...first, key: "00000000-0000-4000-8000-000000000000" }), false);
  assert.deepEqual(loadPaymentIntent(store, owner, path), first, "a stale completion leaves the pending payment");
  assert.equal(completePaymentIntent(store, owner, first), true);
  assert.equal(loadPaymentIntent(store, owner, path), null);
  const second = beginPaymentIntent(store, owner, path, body);
  assert.notEqual(second.key, first.key, "a new intentional payment gets a new key");
});

test("actor, café, branch and invoice each isolate pending payments", () => {
  const store = new Store();
  const intent = beginPaymentIntent(store, owner, path, body);
  for (const other of [
    paymentIntentOwner({ id: "user-2", cafeId: "cafe-1", branchId: "branch-1" }),
    paymentIntentOwner({ id: "user-1", cafeId: "cafe-2", branchId: "branch-1" }),
    paymentIntentOwner({ id: "user-1", cafeId: "cafe-1", branchId: "branch-2" }),
    paymentIntentOwner({ id: "user-1", cafeId: "cafe-1", branchId: null }),
  ]) {
    assert.equal(loadPaymentIntent(store, other, path), null, other);
    // Another actor's completion attempt cannot remove this actor's request.
    assert.equal(completePaymentIntent(store, other, intent), false);
  }
  assert.equal(loadPaymentIntent(store, owner, paymentIntentPath("invoice-2")), null);
  assert.deepEqual(loadPaymentIntent(store, owner, path), intent);
});

test("unavailable or unverifiable storage refuses a new payment before any request", () => {
  for (const configure of [(s: Store) => { s.failSet = true; }, (s: Store) => { s.dropWrites = true; }, (s: Store) => { s.failGet = true; }]) {
    const store = new Store();
    configure(store);
    assert.throws(() => beginPaymentIntent(store, owner, path, body), /لم تُرسل أي دفعة/, "a clear Arabic reason, not the raw browser error");
    store.failGet = false;
    assert.equal(store.data.size, 0, "nothing half-written");
  }
});

test("a corrupt or foreign envelope blocks new payments instead of being guessed", () => {
  const store = new Store();
  beginPaymentIntent(store, owner, path, body);
  const [key] = [...store.data.keys()];
  for (const raw of ["{", JSON.stringify({ version: 2 }), JSON.stringify({ version: 1, path: "/api/purchases/invoice-9/payments", key: "8a8f3d1e-5c1b-4b8e-9a4b-1c2d3e4f5a6b", body })]) {
    store.data.set(key, raw);
    assert.throws(() => loadPaymentIntent(store, owner, path), /تعذر استعادة الدفعة السابقة بأمان/);
    assert.throws(() => beginPaymentIntent(store, owner, path, body));
  }
});

test("only the payment route and a valid existing payment body are accepted", () => {
  const store = new Store();
  assert.throws(() => beginPaymentIntent(store, owner, "/api/expenses", body), /مسار الدفعة غير صالح/);
  assert.throws(() => paymentIntentPath("../x"), /مسار الدفعة غير صالح/);
  for (const amount of [0, -1, 1.005, 0.001, 10000000000, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(purchasePaymentBody.safeParse({ ...body, amount }).success, false, String(amount));
  }
  assert.equal(purchasePaymentBody.safeParse({ ...body, amount: 9999999999.99 }).success, true);
  assert.equal(purchasePaymentBody.safeParse({ ...body, amount: 0.01 }).success, true);
  assert.equal(purchasePaymentBody.safeParse({ ...body, fundingSource: "TREASURY" }).success, false);
  assert.equal(purchasePaymentBody.safeParse({ ...body, note: "x".repeat(301) }).success, false);
  // Older clients may omit the funding source; that contract stays optional.
  const legacy = purchasePaymentBody.safeParse({ amount: 5, method: "CASH" });
  assert.equal(legacy.success, true);
  assert.equal(store.data.size, 0);
});

test("uncertain or unseeable outcomes keep the pending payment; a definite refusal releases it", () => {
  for (const status of [null, 500, 502, 409, 401, 403, 404]) assert.equal(paymentIntentSurvives(status), true, String(status));
  for (const status of [400, 422]) assert.equal(paymentIntentSurvives(status), false, String(status));
});
