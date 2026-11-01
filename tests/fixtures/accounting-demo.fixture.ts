// Synthetic accounting demo (not a test): fills the seeded demo café
// ("قهوة المدينة", owner@demo.com) of a DISPOSABLE database with six days of
// made-up activity and runs the shadow projection, so the accounting pages
// have something to show. Run it only through the guarded runner against a
// database created for it, e.g.:
//   TEST_DB_NAME=cafe_ops_test_acctdemo TEST_SERVER_PORT=3108 node scripts/run-tests.mjs tests/fixtures/accounting-demo.fixture.ts
// Amounts and counts are fixed; dates are relative to the day it runs.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { db } from "../helpers/db";
import { as, login, requireServer } from "../helpers/http";
import { addDays, dateStrInTz, zonedDayStart } from "@/lib/date-range";
import { projectShadowLedger } from "@/lib/accounting/shadow-projection";

after(async () => { await db.$disconnect(); });

const MARK = "accounting-demo-fixture";
const at = (date: string, hour: number) => new Date(zonedDayStart(date).getTime() + hour * 3600_000);

test("seed the synthetic accounting demo", { timeout: 600000 }, async () => {
  await requireServer();
  const owner = await db.user.findUniqueOrThrow({ where: { email: "owner@demo.com" } });
  const cafeId = owner.cafeId!;
  assert.equal(await db.order.count({ where: { cafeId, notes: MARK } }), 0, "the demo has already been seeded in this database");
  const branches = await db.branch.findMany({ where: { cafeId }, orderBy: { name: "asc" }, take: 2 });
  const cashier = await db.user.findFirstOrThrow({ where: { cafeId, role: "CASHIER" } });
  const password = readFileSync(new URL("../../prisma/seed.ts", import.meta.url), "utf8").split("\n").find((l, i, all) => all[i - 2]?.includes('"owner@demo.com"') && l.includes("hash("))!.match(/hash\("([^"]+)"\)/)![1];
  await login(owner.email, password);

  let number = 7000;
  const sale = async (branchId: string, date: string, hour: number, bill: { subtotal: number; discount?: number; service?: number; tax?: number }, pays: [number, "CASH" | "CARD" | "WALLET" | "MIXED", number][]) => {
    const total = Math.round((bill.subtotal - (bill.discount ?? 0) + (bill.service ?? 0) + (bill.tax ?? 0)) * 100) / 100;
    const o = await db.order.create({ data: { cafeId, branchId, orderNumber: ++number, type: "DINE_IN", status: "SERVED", source: "CASHIER_POS", createdById: cashier.id, createdAt: at(date, hour), servedAt: at(date, hour + 0.3), subtotal: bill.subtotal, discountAmount: bill.discount ?? 0, serviceChargeAmount: bill.service ?? 0, taxAmount: bill.tax ?? 0, total, paidAmount: total, remainingAmount: 0, paymentStatus: "PAID", notes: MARK } });
    for (const [offset, method, amount] of pays) {
      await db.payment.create({ data: { cafeId, branchId, orderId: o.id, cashierId: cashier.id, receivedById: cashier.id, amount, method, type: "COLLECTION", status: "PAID", createdAt: at(date, hour + offset), paidAt: at(date, hour + offset) } });
    }
    return o;
  };

  for (let back = 6; back >= 1; back--) {
    const date = addDays(dateStrInTz(new Date()), -back);
    for (const [i, branch] of branches.entries()) {
      await sale(branch.id, date, 9 + i, { subtotal: 120, discount: 10, service: 11, tax: 16.94 }, [[0.5, "CASH", 137.94]]);
      await sale(branch.id, date, 12 + i, { subtotal: 85 }, [[0.5, "CARD", 85]]);
      await sale(branch.id, date, 15 + i, { subtotal: 60 }, [[0.1, "WALLET", 20], [0.5, "WALLET", 40]]); // part paid before serving
    }
    if (back % 2 === 0) {
      const o = await sale(branches[0].id, date, 18, { subtotal: 50 }, [[0.5, "CASH", 50]]);
      await db.payment.create({ data: { cafeId, branchId: branches[0].id, orderId: o.id, cashierId: cashier.id, receivedById: cashier.id, amount: 15, method: "CASH", type: "REFUND", status: "PAID", createdAt: at(date, 19), paidAt: at(date, 19) } });
    }
  }
  // One event the books cannot take, so the issue queue has something real to show.
  await sale(branches[0].id, addDays(dateStrInTz(new Date()), -1), 20, { subtotal: 40 }, [[0.5, "MIXED", 40]]);

  // A purchase through the real API: received, invoiced, partly paid from the safe.
  const item = await db.inventoryItem.create({ data: { cafeId, branchId: branches[0].id, name: "بن تجريبي (demo)", unit: "KG", costPerUnit: 0, currentStock: "0" } });
  const created = await as<{ id: string }>(owner.email, "/api/purchases", { method: "POST", body: JSON.stringify({ branchId: branches[0].id, items: [{ inventoryItemId: item.id, quantity: 10, unitCost: 300 }], taxAmount: 420, payment: { amount: 1000, method: "CASH", fundingSource: "SAFE" } }) });
  assert.equal(created.status, 201, created.text);
  assert.equal((await as(owner.email, `/api/purchases/${created.body.id}/confirm`, { method: "POST", body: "{}" })).status, 200);
  const paid = await as(owner.email, `/api/purchases/${created.body.id}/payments`, { method: "POST", headers: { "Idempotency-Key": randomUUID() }, body: JSON.stringify({ amount: 1500, method: "BANK_TRANSFER", fundingSource: "BANK" }) });
  assert.equal(paid.status, 200, paid.text);

  const today = dateStrInTz(new Date());
  const report = await projectShadowLedger({ cafeId, from: zonedDayStart(addDays(today, -6)), to: zonedDayStart(addDays(today, 1)), actorId: owner.id, openMissingPeriods: true });
  console.log(`demo projection: posted ${report.posted}, exceptions ${report.exceptions.length}, warnings ${report.warnings.length}`);
  assert.ok(report.posted > 50);
});
