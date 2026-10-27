// OPS-004 — the customer display screen.
//
// /api/display/orders feeds a screen that faces the room, so it returns
// order NUMBERS only: "being prepared" (CONFIRMED/PREPARING) and "ready"
// (newest first). It follows the bar-screen switch, because READY is set
// there, and the usual branch scoping.

import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { db, teardownTaggedCafe, purgeOrderTracesFor } from "./helpers/db";
import { countCafe, type CountCafe } from "./helpers/count";
import { as, requireServer } from "./helpers/http";

let fx: CountCafe;
const MIN = 60_000;
const ago = (ms: number) => new Date(Date.now() - ms);

type Display = { branchName: string; preparing: number[]; ready: { orderNumber: number; readyAt: string | null }[] };

let num = 0;
async function order(status: "PENDING_WAITER_APPROVAL" | "CONFIRMED" | "PREPARING" | "READY" | "SERVED" | "CANCELLED", opts: {
  createdAt?: Date; readyAt?: Date; branchId?: string;
} = {}) {
  num += 1;
  return db.order.create({
    data: {
      cafeId: fx.cafeId, branchId: opts.branchId ?? fx.branchId,
      orderNumber: 900 + num, type: "TAKEAWAY", status, source: "CASHIER_POS",
      customerName: `${fx.marker} secret-name`,
      subtotal: 77, total: 77, paidAmount: 77, remainingAmount: 0, paymentStatus: "PAID",
      createdAt: opts.createdAt, readyAt: opts.readyAt, createdById: fx.cashier.id,
    },
  });
}

const display = (email: string, query = "") => as<Display>(email, `/api/display/orders${query}`);

before(async () => {
  await requireServer();
  fx = await countCafe("OPS004");
});

after(async () => {
  await teardownTaggedCafe(fx?.cafeId, [], { disconnect: true });
});

beforeEach(async () => {
  await purgeOrderTracesFor({ cafeId: fx.cafeId }); await db.order.deleteMany({ where: { cafeId: fx.cafeId } });
  await db.cafeSettings.update({ where: { cafeId: fx.cafeId }, data: { kitchenScreenEnabled: true } });
});

describe("OPS-004 customer display feed", () => {
  test("numbers only: preparing oldest first, ready newest first; nothing else leaks", async () => {
    const confirmed = await order("CONFIRMED", { createdAt: ago(20 * MIN) });
    const preparing = await order("PREPARING", { createdAt: ago(10 * MIN) });
    const readyOld = await order("READY", { createdAt: ago(30 * MIN), readyAt: ago(5 * MIN) });
    const readyNew = await order("READY", { createdAt: ago(25 * MIN), readyAt: ago(1 * MIN) });
    await order("SERVED");
    await order("CANCELLED");
    await order("PENDING_WAITER_APPROVAL");
    await order("READY", { createdAt: ago(13 * 60 * MIN), readyAt: ago(13 * 60 * MIN) });
    await order("READY", { branchId: fx.otherBranchId, readyAt: new Date() });

    const r = await display(fx.cashier.email);
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.body.preparing, [confirmed.orderNumber, preparing.orderNumber]);
    assert.deepEqual(r.body.ready.map((o) => o.orderNumber), [readyNew.orderNumber, readyOld.orderNumber],
      "served, cancelled, awaiting approval, >12h old and the other branch are not shown");
    assert.ok(!r.text.includes("secret-name"), "no customer names on a screen facing the room");
    assert.ok(!/"total"|"items"|"customerName"/.test(r.text));
  });

  test("follows the bar-screen switch", async () => {
    await db.cafeSettings.update({ where: { cafeId: fx.cafeId }, data: { kitchenScreenEnabled: false } });
    const r = await display(fx.cashier.email);
    assert.equal(r.status, 403);
  });

  test("branch scoping: pinned staff stay on their branch; the owner picks one", async () => {
    assert.equal((await display(fx.cashier.email, `?branchId=${fx.otherBranchId}`)).status, 403);
    assert.equal((await display(fx.owner.email)).status, 400, "the owner must choose a branch");
    const owner = await display(fx.owner.email, `?branchId=${fx.otherBranchId}`);
    assert.equal(owner.status, 200, owner.text);
    assert.match(owner.body.branchName, /annex/);
    assert.equal((await display(fx.owner.email, "?branchId=nope")).status, 404);
  });

  test("the page renders for a logged-in device and the bar screen links to it", async () => {
    const page = await as(fx.cashier.email, "/display");
    assert.equal(page.status, 200);
    assert.match(page.text, /بيتحضر/);
    assert.match(page.text, /جاهز — اتفضل استلم/);
    const kitchen = readFileSync("src/app/(app)/kitchen/page.tsx", "utf8");
    assert.match(kitchen, /data-testid="open-customer-display"/);
    assert.match(kitchen, /href=\{`\/display/);
  });
});
