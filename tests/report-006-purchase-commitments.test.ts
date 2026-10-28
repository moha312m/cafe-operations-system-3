import { test, after } from "node:test";
import assert from "node:assert/strict";
import { db, teardownTaggedCafe } from "./helpers/db";
import { countCafe, countItem, COUNT_PASSWORD } from "./helpers/count";
import { as, login, requireServer } from "./helpers/http";
import { dateStrInTz } from "@/lib/date-range";

after(async () => { await db.$disconnect(); });

type Purchases = {
  total: number; invoiceCount: number; supplierPayments: number; unpaidTotal: number;
  unpaidAsOf: string; draftCount: number; draftTotal: number;
};

// A draft is a commitment, not a purchase or a debt: it has added no stock
// and can still be edited or cancelled. The daily report keeps recognized
// purchases (confirmed) and the supplier balance apart from drafts.
test("daily report counts confirmed purchases only and lists drafts as commitments", { timeout: 30000 }, async () => {
  await requireServer();
  const fx = await countCafe("REPORT006");
  try {
    await login(fx.owner.email, COUNT_PASSWORD);
    const item = await countItem(fx, "milk", { stock: 5 });
    const create = async (total: number) => {
      const r = await as<{ id: string }>(fx.owner.email, "/api/purchases", {
        method: "POST", body: JSON.stringify({ branchId: fx.branchId, items: [{ inventoryItemId: item.id, quantity: 1, unitCost: total }] }),
      });
      assert.equal(r.status, 201, r.text);
      return r.body.id;
    };
    const confirmed = await create(100);
    assert.equal((await as(fx.owner.email, `/api/purchases/${confirmed}/confirm`, { method: "POST", body: "{}" })).status, 200);
    const paid = await as(fx.owner.email, `/api/purchases/${confirmed}/payments`, {
      method: "POST", headers: { "Idempotency-Key": crypto.randomUUID() }, body: JSON.stringify({ amount: 40, method: "CASH" }),
    });
    assert.equal(paid.status, 200, paid.text);
    await create(50); // stays a draft
    const cancelled = await create(30);
    await db.purchaseInvoice.update({ where: { id: cancelled }, data: { status: "CANCELLED", cancelledAt: new Date() } });

    const date = dateStrInTz(new Date());
    const report = await as<{ purchases: Purchases }>(fx.owner.email, `/api/reports/daily?date=${date}&branchId=${fx.branchId}`);
    assert.equal(report.status, 200, report.text);
    const p = report.body.purchases;
    assert.equal(p.total, 100, "only the confirmed invoice is a recognized purchase");
    assert.equal(p.invoiceCount, 1);
    assert.equal(p.unpaidTotal, 60, "a draft is not owed to the supplier");
    assert.equal(p.supplierPayments, 40);
    assert.equal(p.draftCount, 1);
    assert.equal(p.draftTotal, 50);
    assert.ok(!Number.isNaN(Date.parse(p.unpaidAsOf)), "the supplier balance is labelled as a current balance");
  } finally {
    await teardownTaggedCafe(fx.cafeId);
  }
});
