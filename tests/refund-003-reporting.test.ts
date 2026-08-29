// REFUND-003 — reporting must distinguish what was sold from what moved.
//
// Reports derived "sales" from Payment rows and filtered them by
// `status: "PAID"`, which swept up reversals and made a refund read as
// negative sales for whoever processed it. Sales recognition and money
// movement are different questions and need different sources:
//
//   Gross Sales  — canonical: Order.status = SERVED, dated Order.createdAt,
//                  valued Order.total. Unchanged by this work; a refunded
//                  order still sold, so it still counts.
//   Refunds      — sum of Payment.type = REFUND.
//   Net Sales    — Gross Sales - Refunds.
//   Collections  — sum of Payment.type = COLLECTION. Never Net Sales.
//
// Accounting is by transaction period: a refund belongs to the day it was
// issued, never to the day of the sale it reverses. A day can therefore show
// negative Net Sales, and that is correct rather than a bug to smooth over.
//
// Assertions are deltas around each scenario so they hold whatever else the
// café happens to contain.

import { test, after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { db, fixture, sessionFor, cleanup } from "./helpers/db";
import { requireServer, login, as } from "./helpers/http";

const OWNER = "owner@demo.com";

after(async () => { await db.$disconnect(); });
before(async () => {
  await requireServer();
  await login(OWNER, "owner1234");
});

type Figures = {
  grossSales: number;
  refunds: number;
  netSales: number;
  collections: number;
};

const localDay = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

async function daily(date: Date): Promise<Figures> {
  const r = await as<{ financials?: Figures }>(OWNER, `/api/reports/daily?date=${localDay(date)}`);
  assert.equal(r.status, 200, `daily report failed: ${r.text.slice(0, 160)}`);
  const f = r.body.financials;
  assert.ok(f, "daily report must expose a financials block (gross/refunds/net/collections)");
  return f;
}

async function dashboardToday(): Promise<Figures> {
  const r = await as<{ financials?: Figures }>(OWNER, "/api/dashboard?range=today");
  assert.equal(r.status, 200, `dashboard failed: ${r.text.slice(0, 160)}`);
  const f = r.body.financials;
  assert.ok(f, "dashboard must expose the same financials block as the daily report");
  return f;
}

const delta = (a: Figures, b: Figures): Figures => ({
  grossSales: Math.round((b.grossSales - a.grossSales) * 100) / 100,
  refunds: Math.round((b.refunds - a.refunds) * 100) / 100,
  netSales: Math.round((b.netSales - a.netSales) * 100) / 100,
  collections: Math.round((b.collections - a.collections) * 100) / 100,
});

/** A recognised sale: SERVED order plus its collection, both dated `when`. */
async function seedSale(
  marker: string,
  amount: number,
  when: Date,
  opts: { method?: "CASH" | "CARD"; sellerEmail?: string } = {}
) {
  const fx = await fixture();
  const seller = await sessionFor(opts.sellerEmail ?? "cashier@demo.com");
  const product = await db.product.findUniqueOrThrow({ where: { id: fx.productId } });
  const last = await db.order.aggregate({
    where: { branchId: fx.branchId }, _max: { orderNumber: true },
  });
  const order = await db.order.create({
    data: {
      cafeId: fx.cafeId, branchId: fx.branchId,
      orderNumber: (last._max.orderNumber ?? 0) + 1,
      type: "TAKEAWAY", status: "SERVED", source: "CASHIER_POS",
      customerName: marker,
      subtotal: amount, taxAmount: 0, discountAmount: 0, serviceChargeAmount: 0,
      total: amount, paidAmount: amount, remainingAmount: 0, paymentStatus: "PAID",
      createdById: seller.id, createdAt: when,
      items: { create: [{ productId: product.id, productName: product.name, unitPrice: amount, quantity: 1, lineTotal: amount }] },
    },
  });
  const payment = await db.payment.create({
    data: {
      cafeId: fx.cafeId, branchId: fx.branchId, orderId: order.id,
      cashierId: seller.id, receivedById: seller.id,
      amount, method: opts.method ?? "CASH", type: "COLLECTION", status: "PAID",
      createdAt: when, paidAt: when,
    },
  });
  return { fx, order, payment, seller };
}

/** A refund transaction dated `when`, processed by `actorEmail`. */
async function seedRefund(
  original: { id: string; cafeId: string; branchId: string | null; orderId: string; method: "CASH" | "CARD" },
  amount: number,
  when: Date,
  actorEmail = "manager@demo.com"
) {
  const actor = await sessionFor(actorEmail);
  return db.payment.create({
    data: {
      cafeId: original.cafeId, branchId: original.branchId, orderId: original.orderId,
      cashierId: actor.id, receivedById: actor.id,
      amount, method: original.method, type: "REFUND", status: "PAID",
      reversalOfPaymentId: original.id, createdAt: when, paidAt: when,
    },
  });
}

async function purge(marker: string) {
  const orders = await db.order.findMany({
    where: { customerName: { startsWith: marker } }, select: { id: true },
  });
  const ids = orders.map((o) => o.id);
  if (!ids.length) return;
  await db.payment.deleteMany({ where: { orderId: { in: ids }, reversalOfPaymentId: { not: null } } });
  await db.payment.deleteMany({ where: { orderId: { in: ids } } });
  await cleanup(marker);
}

describe("REFUND-003 reporting definitions", () => {
  test("A: a paid sale with no refund", async () => {
    const marker = "PH15-R003-A";
    await purge(marker);
    const now = new Date();
    const before = await daily(now);
    await seedSale(marker, 120, now);
    try {
      const d = delta(before, await daily(now));
      assert.equal(d.grossSales, 120, "the sale must be recognised in full");
      assert.equal(d.refunds, 0);
      assert.equal(d.netSales, 120);
      assert.equal(d.collections, 120, "Collections is money received, not Net Sales");
    } finally {
      await purge(marker);
    }
  });

  test("B: sale and full refund in the same period", async () => {
    const marker = "PH15-R003-B";
    await purge(marker);
    const now = new Date();
    const before = await daily(now);
    const sale = await seedSale(marker, 120, now);
    await seedRefund(
      { ...sale.payment, method: "CASH", branchId: sale.fx.branchId },
      120, now
    );
    try {
      const d = delta(before, await daily(now));
      assert.equal(d.grossSales, 120, "the sale still happened — Gross must not shrink");
      assert.equal(d.refunds, 120);
      assert.equal(d.netSales, 0);
      assert.equal(
        d.collections, 120,
        "Collections records the money received; the refund is its own figure"
      );
    } finally {
      await purge(marker);
    }
  });

  test("C: sold yesterday, refunded today — the refund belongs to today", async () => {
    const marker = "PH15-R003-C";
    await purge(marker);
    const now = new Date();
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    const beforeY = await daily(yesterday);
    const beforeT = await daily(now);
    const sale = await seedSale(marker, 120, yesterday);
    await seedRefund(
      { ...sale.payment, method: "CASH", branchId: sale.fx.branchId },
      120, now
    );
    try {
      const dY = delta(beforeY, await daily(yesterday));
      assert.equal(dY.grossSales, 120, "yesterday keeps the sale it made");
      assert.equal(dY.refunds, 0, "the refund must not be backdated into the sale's day");
      assert.equal(dY.netSales, 120);
      assert.equal(dY.collections, 120);

      const dT = delta(beforeT, await daily(now));
      assert.equal(dT.grossSales, 0, "no sale was recognised today");
      assert.equal(dT.refunds, 120);
      assert.equal(
        dT.netSales, -120,
        "a day that only returned money legitimately shows negative Net Sales"
      );
      assert.equal(dT.collections, 0, "nothing was collected today");
    } finally {
      await purge(marker);
    }
  });

  test("E: a card refund does not reduce cash figures", async () => {
    const marker = "PH15-R003-E";
    await purge(marker);
    const now = new Date();
    // Measured as a delta so an unrelated cash refund elsewhere in the day
    // cannot decide this assertion.
    const readMethods = async () => {
      const r = await as<{ financials?: { cashRefunds?: number; cardRefunds?: number } }>(
        OWNER, `/api/reports/daily?date=${localDay(now)}`
      );
      const f = r.body.financials!;
      assert.ok(
        typeof f.cashRefunds === "number" && typeof f.cardRefunds === "number",
        "reporting must preserve payment method for refunds"
      );
      return { cash: f.cashRefunds!, card: f.cardRefunds! };
    };
    const beforeM = await readMethods();
    const sale = await seedSale(marker, 120, now, { method: "CARD" });
    await seedRefund(
      { ...sale.payment, method: "CARD", branchId: sale.fx.branchId },
      120, now
    );
    try {
      const afterM = await readMethods();
      assert.equal(
        afterM.cash - beforeM.cash, 0,
        "a card refund must never appear as cash leaving the drawer"
      );
      assert.equal(
        afterM.card - beforeM.card, 120,
        "the card refund must be reported against card"
      );
    } finally {
      await purge(marker);
    }
  });

  test("F: a refund never shows as negative sales for whoever processed it", async () => {
    const marker = "PH15-R003-F";
    await purge(marker);
    const now = new Date();
    const sale = await seedSale(marker, 120, now, { sellerEmail: "cashier@demo.com" });
    // A different employee authorises the refund.
    await seedRefund(
      { ...sale.payment, method: "CASH", branchId: sale.fx.branchId },
      120, now, "manager@demo.com"
    );
    try {
      const r = await as<{ salesByStaff?: { name: string; grossSales: number; refunds: number; netSales: number }[] }>(
        OWNER, `/api/reports/daily?date=${localDay(now)}`
      );
      const rows = r.body.salesByStaff;
      assert.ok(rows, "the daily report must attribute sales to the employee who sold");

      for (const row of rows) {
        assert.ok(
          row.grossSales >= 0,
          `${row.name} shows negative gross sales (${row.grossSales}) — a refund was ` +
            `attributed as a sale to whoever processed it`
        );
      }

      const manager = rows.find((x) => x.name.includes("المدير"));
      if (manager) {
        assert.equal(
          manager.grossSales, 0,
          "the refunding employee sold nothing and must not be credited or debited a sale"
        );
      }
    } finally {
      await purge(marker);
    }
  });

  test("G: a fully refunded order still counts in historical Gross Sales", async () => {
    const marker = "PH15-R003-G";
    await purge(marker);
    const now = new Date();
    const before = await daily(now);
    const sale = await seedSale(marker, 120, now);
    await seedRefund(
      { ...sale.payment, method: "CASH", branchId: sale.fx.branchId },
      120, now
    );
    // Settlement is closed out exactly as Commit A leaves it.
    await db.order.update({
      where: { id: sale.order.id },
      data: { paidAmount: 0, remainingAmount: 0, paymentStatus: "REFUNDED" },
    });
    try {
      const d = delta(before, await daily(now));
      assert.equal(
        d.grossSales, 120,
        "a refunded order must not vanish from the sales it originally made"
      );
      assert.equal(d.netSales, 0);
    } finally {
      await purge(marker);
    }
  });

  test("D+J: shift totals reconcile by type and method", async () => {
    const marker = "PH15-R003-J";
    await purge(marker);
    const fx = await fixture();
    const cashier = await sessionFor("cashier@demo.com");
    await db.payment.updateMany({
      where: { shift: { branchId: fx.branchId, cashierId: cashier.id, status: "OPEN" } },
      data: { shiftId: null },
    });
    await db.shift.deleteMany({
      where: { branchId: fx.branchId, cashierId: cashier.id, status: "OPEN" },
    });
    const last = await db.shift.aggregate({
      where: { branchId: fx.branchId }, _max: { shiftNumber: true },
    });
    const shift = await db.shift.create({
      data: {
        cafeId: fx.cafeId, branchId: fx.branchId, cashierId: cashier.id,
        shiftNumber: (last._max.shiftNumber ?? 0) + 1,
        openingCashAmount: 200, expectedCashAmount: 200,
      },
    });

    try {
      const now = new Date();
      // A cash sale and a card sale, then a refund of each.
      const cashSale = await seedSale(marker + "-cash", 100, now, { method: "CASH" });
      const cardSale = await seedSale(marker + "-card", 60, now, { method: "CARD" });
      await db.payment.updateMany({
        where: { id: { in: [cashSale.payment.id, cardSale.payment.id] } },
        data: { shiftId: shift.id },
      });
      const cashRefund = await seedRefund(
        { ...cashSale.payment, method: "CASH", branchId: fx.branchId }, 100, now
      );
      const cardRefund = await seedRefund(
        { ...cardSale.payment, method: "CARD", branchId: fx.branchId }, 60, now
      );
      await db.payment.updateMany({
        where: { id: { in: [cashRefund.id, cardRefund.id] } },
        data: { shiftId: shift.id },
      });

      const { recomputeShiftTotals } = await import("@/lib/shifts");
      await recomputeShiftTotals(shift.id);
      const s = await db.shift.findUniqueOrThrow({ where: { id: shift.id } });

      assert.equal(Number(s.totalCashSales), 0, "cash sale less cash refund nets to zero");
      assert.equal(Number(s.totalCardSales), 0, "card sale less card refund nets to zero");
      assert.equal(Number(s.totalRefunds), 160, "both refunds must be disclosed");
      assert.equal(
        Number(s.expectedCashAmount), 200,
        "the drawer is back at its opening float — and the CARD refund never touched it"
      );
    } finally {
      await purge(marker + "-cash");
      await purge(marker + "-card");
      await purge(marker);
      await db.payment.deleteMany({ where: { shiftId: shift.id } });
      await db.shift.deleteMany({ where: { id: shift.id } });
    }
  });

  test("H+I: dashboard and daily report agree for the same day", async () => {
    const marker = "PH15-R003-HI";
    await purge(marker);
    const now = new Date();
    const sale = await seedSale(marker, 75, now);
    await seedRefund(
      { ...sale.payment, method: "CASH", branchId: sale.fx.branchId },
      75, now
    );
    try {
      const d = await daily(now);
      const dash = await dashboardToday();
      assert.deepEqual(
        { g: dash.grossSales, r: dash.refunds, n: dash.netSales, c: dash.collections },
        { g: d.grossSales, r: d.refunds, n: d.netSales, c: d.collections },
        "the two screens must not disagree about the same day"
      );
      assert.equal(
        Math.round((d.grossSales - d.refunds) * 100) / 100, d.netSales,
        "Net Sales must reconcile as Gross - Refunds"
      );
    } finally {
      await purge(marker);
    }
  });
});
