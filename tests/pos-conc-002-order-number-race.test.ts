// POS-CONC-002 (R-POS-02B1) — two tills may not be handed the same number.
//
// `POST /api/orders` allocates the next order number by aggregating the
// branch's current maximum and adding one:
//
//     const last = await tx.order.aggregate({ where: { branchId },
//                                             _max: { orderNumber: true } });
//     orderNumber: (last._max.orderNumber ?? 0) + 1
//
// The aggregate takes no lock. Under PostgreSQL's default READ COMMITTED —
// and no isolation level is configured anywhere in this repository — two
// tills ringing up at the same moment both read the same maximum and both
// ask for the same number. `Order @@unique([branchId, orderNumber])` is
// already in the schema, so the database refuses the second one; what it
// raises is a Prisma P2002, which `handleApiError` did not recognise. The
// cashier's screen therefore said "حصل خطأ غير متوقع" (HTTP 500) for a
// perfectly ordinary collision, and the sale was simply lost.
//
// This suite races the real route over HTTP, because the defect lives in
// what the server hands the till. No browser is driven.

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { requireServer, login, as } from "./helpers/http";
import { db, fixture, type Fixture } from "./helpers/db";

const OWNER = { email: "owner@demo.com", password: "owner1234" };
const MARKER = "PH15-ORDNUM";

let fx: Fixture;

type OrderResponse = { order?: { id: string; orderNumber: number }; error?: string };

/** One takeaway order, billed later: no shift gate, no table session. */
function place(marker: string) {
  return as<OrderResponse>(OWNER.email, "/api/orders", {
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
  const orders = await db.order.findMany({ where: { notes: marker }, select: { id: true } });
  const ids = orders.map((o) => o.id);
  if (ids.length === 0) return;
  await db.payment.deleteMany({ where: { orderId: { in: ids } } });
  await db.orderItem.deleteMany({ where: { orderId: { in: ids } } });
  await db.order.deleteMany({ where: { id: { in: ids } } });
}

before(async () => {
  await requireServer();
  await login(OWNER.email, OWNER.password);
  fx = await fixture();
});

after(async () => {
  await purge(`${MARKER}-A`);
  await purge(`${MARKER}-B`);
  await db.$disconnect();
});

describe("POS-CONC-002 concurrent tills get distinct order numbers", () => {
  test("eight parallel orders in one branch: no 500, all numbers distinct", async () => {
    const marker = `${MARKER}-A`;
    try {
      const results = await Promise.all(Array.from({ length: 8 }, () => place(marker)));

      // The cashier must never be shown an unexpected-error page for a
      // collision the database was designed to catch.
      const crashed = results.filter((r) => r.status >= 500);
      assert.equal(
        crashed.length,
        0,
        `a lost race surfaced as a server error: ${crashed
          .map((r) => `${r.status} ${r.body.error ?? r.text.slice(0, 80)}`)
          .join(" | ")}`
      );

      // Every attempt must actually have produced a sale — the retry is
      // supposed to take the next free number, not give up.
      const failed = results.filter((r) => r.status !== 200 && r.status !== 201);
      assert.equal(
        failed.length,
        0,
        `orders were refused instead of retried: ${failed
          .map((r) => `${r.status} ${r.body.error ?? ""}`)
          .join(" | ")}`
      );

      const numbers = results.map((r) => r.body.order!.orderNumber);
      assert.equal(
        new Set(numbers).size,
        numbers.length,
        `two orders share a number: ${numbers.join(", ")}`
      );
    } finally {
      await purge(marker);
    }
  });

  test("the numbers the database kept are unique for the branch", async () => {
    // The assertion above reads what the API returned. This one reads what
    // was actually committed, so a route that answered 200 while writing a
    // duplicate could not pass.
    const marker = `${MARKER}-B`;
    try {
      await Promise.all(Array.from({ length: 6 }, () => place(marker)));
      const rows = await db.order.findMany({
        where: { notes: marker },
        select: { orderNumber: true },
      });
      const nums = rows.map((r) => r.orderNumber);
      assert.ok(nums.length > 0, "no orders were created at all");
      assert.equal(new Set(nums).size, nums.length, `committed duplicates: ${nums.join(", ")}`);
    } finally {
      await purge(marker);
    }
  });
});
