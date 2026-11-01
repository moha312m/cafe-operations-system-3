// SEC-008 — the public QR order endpoint needs no login, so it must bound
// both how often one origin may submit and how much text one order may carry.
//
// Every request here aims at a branch id that does not exist and carries its
// own forwarded address, so nothing is written and no other suite shares the
// throttle key. The throttle is consulted before the body is parsed, which is
// why an invalid body still counts.

import { before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { BASE, requireServer } from "./helpers/http";

before(requireServer);

const post = (branchId: string, origin: string, body: unknown) =>
  fetch(`${BASE}/api/qr/${branchId}/orders`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": randomUUID(), "x-forwarded-for": origin },
    body: JSON.stringify(body),
  });

const order = (notes: string) => ({
  customerName: "SEC008 guest",
  notes,
  items: [{ productId: "sec008-missing", quantity: 1 }],
});

describe("SEC-008 public QR order limits", () => {
  test("one origin gets sixty submissions per branch, then a 429 with Retry-After", async () => {
    const branchId = `sec008-${randomUUID()}`;
    const origin = `203.0.113.${Math.floor(Math.random() * 200) + 1}`;
    for (let i = 0; i < 60; i++) {
      const res = await post(branchId, origin, {});
      assert.notEqual(res.status, 429, `submission ${i + 1} must not be throttled`);
      await res.arrayBuffer();
    }
    const limited = await post(branchId, origin, {});
    assert.equal(limited.status, 429, await limited.text());
    assert.ok(Number(limited.headers.get("retry-after")) > 0, "a throttled answer says when to retry");

    // The key is the (branch, origin) pair: another table on another address
    // is unaffected.
    const other = await post(branchId, "198.51.100.7", {});
    assert.notEqual(other.status, 429);
  });

  test("an order note over 500 characters is refused before any branch lookup", async () => {
    const branchId = `sec008-${randomUUID()}`;
    const tooLong = await post(branchId, "192.0.2.10", order("x".repeat(501)));
    assert.equal(tooLong.status, 400);
    assert.match(await tooLong.text(), /النص طويل جدًا/);

    const fits = await post(branchId, "192.0.2.11", order("x".repeat(500)));
    assert.doesNotMatch(await fits.text(), /النص طويل جدًا/);
  });
});
