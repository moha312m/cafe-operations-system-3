// QR-001 — the QR menu may not be handed a number a till already took.
//
// R-POS-02B1 closed the order-number race on the staff path: it takes a
// branch-row lock, allocates under it, and retries a lost race. The public QR
// endpoint was left as a documented residual, still allocating the old way:
//
//     const last = await tx.order.aggregate({ where: { branchId },
//                                             _max: { orderNumber: true } });
//     orderNumber: (last._max.orderNumber ?? 0) + 1
//
// After B1 that residual has two shapes, and the second is the one a real
// café hits. Two customers scanning at once is the obvious race. The other is
// a customer submitting while a cashier rings up: the till now HOLDS the
// branch lock and wins every time, so the QR order is the one that collides.
// B1's P2002 mapping meant it collided into a clean 409 rather than a 500 —
// but a 409 is still a customer who did not get their order placed.
//
// Which is why the repair has to reuse the same lock rather than invent a
// second one: two paths that do not queue on the same row do not serialise
// against each other at all.
//
// These tests drive the real endpoint over HTTP. The QR route is public, so
// the customer half needs no session; the till half signs in.
//
// Every parallel request below uses its OWN table number on purpose. Sharing
// one would race `attachOrderToTableSession` as well, and that defect — the
// duplicate open TableSession — is deferred to R-POS-02B2. A test that
// tripped over both at once would not tell us which one it had caught.

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { BASE, requireServer, login, as } from "./helpers/http";
import { db, fixture, type Fixture } from "./helpers/db";

const OWNER = { email: "owner@demo.com", password: "owner1234" };
const MARKER = "PH15-QRNUM";

let fx: Fixture;

type QrResponse = {
  order?: { id: string; orderNumber: number; total: unknown; status: string };
  error?: string;
};

/** One QR submission, as an anonymous customer would send it. */
async function scan(marker: string, table: string) {
  const r = await fetch(`${BASE}/api/qr/${fx.branchId}/orders`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      customerName: "عميل اختبار",
      tableNumber: table,
      notes: marker,
      items: [{ productId: fx.productId, quantity: 1 }],
    }),
  });
  const text = await r.text();
  let body: QrResponse;
  try { body = JSON.parse(text) as QrResponse; } catch { body = {}; }
  return { status: r.status, body, text };
}

/** One staff order on the same branch, for the cross-path race. */
function ring(marker: string) {
  return as<QrResponse>(OWNER.email, "/api/orders", {
    method: "POST",
    body: JSON.stringify({
      branchId: fx.branchId,
      cafeId: fx.cafeId,
      type: "TAKEAWAY",
      collectionMode: "PENDING",
      notes: marker,
      items: [{ productId: fx.productId, quantity: 1 }],
    }),
  });
}

async function purge(marker: string) {
  const orders = await db.order.findMany({
    where: { notes: marker },
    select: { id: true, tableSessionId: true },
  });
  const ids = orders.map((o) => o.id);
  if (ids.length === 0) return;
  const sessionIds = [...new Set(orders.map((o) => o.tableSessionId).filter(Boolean))] as string[];
  await db.payment.deleteMany({ where: { orderId: { in: ids } } });
  await db.orderItem.deleteMany({ where: { orderId: { in: ids } } });
  await db.order.deleteMany({ where: { id: { in: ids } } });
  if (sessionIds.length) {
    await db.tableSession.deleteMany({ where: { id: { in: sessionIds } } });
  }
}

before(async () => {
  await requireServer();
  await login(OWNER.email, OWNER.password);
  fx = await fixture();
});

after(async () => {
  for (const s of ["A", "B", "C"]) await purge(`${MARKER}-${s}`);
  await db.$disconnect();
});

describe("QR-001 concurrent QR submissions get distinct order numbers", () => {
  test("six parallel scans: no 500, none refused, all numbers distinct", async () => {
    const marker = `${MARKER}-A`;
    try {
      const results = await Promise.all(
        Array.from({ length: 6 }, (_, i) => scan(marker, `QR-A${i + 1}`))
      );

      const crashed = results.filter((r) => r.status >= 500);
      assert.equal(
        crashed.length,
        0,
        `a QR customer was shown a server error: ${crashed
          .map((r) => `${r.status} ${r.body.error ?? r.text.slice(0, 80)}`)
          .join(" | ")}`
      );

      const refused = results.filter((r) => r.status !== 201 && r.status !== 200);
      assert.equal(
        refused.length,
        0,
        `orders were refused instead of retried: ${refused
          .map((r) => `${r.status} ${r.body.error ?? ""}`)
          .join(" | ")}`
      );

      const numbers = results.map((r) => r.body.order!.orderNumber);
      assert.equal(
        new Set(numbers).size,
        numbers.length,
        `two QR orders share a number: ${numbers.join(", ")}`
      );
    } finally {
      await purge(marker);
    }
  });

  test("a QR customer and a till racing: both get their own number", async () => {
    // The cross-path case. Before the repair the till held the branch lock
    // and the scan lost, every time.
    const marker = `${MARKER}-B`;
    try {
      const results = await Promise.all([
        scan(marker, "QR-B1"),
        ring(marker),
        scan(marker, "QR-B2"),
        ring(marker),
        scan(marker, "QR-B3"),
      ]);

      const bad = results.filter((r) => r.status !== 201 && r.status !== 200);
      assert.equal(
        bad.length,
        0,
        `a path lost the cross-race: ${bad
          .map((r) => `${r.status} ${r.body.error ?? ""}`)
          .join(" | ")}`
      );

      // Read what was committed, not just what was answered: a route that
      // replied 201 while writing a duplicate could not pass this.
      const rows = await db.order.findMany({
        where: { notes: marker },
        select: { orderNumber: true, source: true },
      });
      assert.equal(rows.length, 5, `expected five orders, found ${rows.length}`);
      const nums = rows.map((r) => r.orderNumber);
      assert.equal(
        new Set(nums).size,
        nums.length,
        `QR and POS collided on a number: ${nums.join(", ")}`
      );
      // Both paths really did take part — otherwise the race proves nothing.
      assert.ok(rows.some((r) => r.source === "QR_MENU"), "no QR order was created");
      assert.ok(rows.some((r) => r.source !== "QR_MENU"), "no staff order was created");
    } finally {
      await purge(marker);
    }
  });

  test("the happy path is unchanged: approval queue, priced by the server", async () => {
    // The lock and the retry must not alter what a QR order IS.
    const marker = `${MARKER}-C`;
    try {
      const res = await scan(marker, "QR-C1");
      assert.equal(res.status, 201, `QR submission answered ${res.status}: ${res.text.slice(0, 120)}`);
      assert.equal(
        res.body.order!.status,
        "PENDING_WAITER_APPROVAL",
        "a QR order must still land in the approval queue, never straight at the kitchen"
      );

      const row = await db.order.findUniqueOrThrow({
        where: { id: res.body.order!.id },
        include: { items: true },
      });
      assert.equal(row.source, "QR_MENU");
      assert.equal(row.createdById, null, "a QR order is placed by the customer, not a user");
      assert.equal(row.paymentStatus, "PENDING_COLLECTION");
      assert.equal(row.items.length, 1);
      // Price comes from the menu, never from the request — the endpoint is
      // public, so this is the one that matters.
      assert.equal(
        Number(row.items[0].unitPrice),
        fx.unitPrice,
        "the server must price a QR order from its own menu"
      );
      assert.ok(Number(row.total) > 0, "a QR order must carry a total");
    } finally {
      await purge(marker);
    }
  });

  test("a conflict is never shown to a customer as a raw database error", async () => {
    // Whatever happens under contention, the wording belongs to the café.
    const marker = `${MARKER}-A`;
    try {
      const results = await Promise.all(
        Array.from({ length: 4 }, (_, i) => scan(marker, `QR-D${i + 1}`))
      );
      for (const r of results) {
        assert.doesNotMatch(
          r.text,
          /P2002|Unique constraint|prisma/i,
          "a database error reached the customer"
        );
        assert.doesNotMatch(
          r.text,
          /حصل خطأ غير متوقع/,
          "a known conflict was reported as an unexpected error"
        );
      }
    } finally {
      await purge(marker);
    }
  });
});
