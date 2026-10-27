// OPS-001 — open orders before a close, forgotten orders, and serving in bulk.
//
//   • The close dialog asks /api/orders/open-summary what is still open at
//     the branch BEFORE the drawer is counted, instead of the closer finding
//     out from a refusal.
//   • An order left unserved, or served and unpaid, past the owner's
//     `staleOrderAlertHours` is flagged with the action that resolves it.
//     Activity resets the clock: an old order that was just made ready is
//     not forgotten.
//   • The bar screen's "serve all" goes through the ordinary status route one
//     order at a time, so no rule is bypassed in bulk.

import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { db, teardownTaggedCafe, purgeOrderTracesFor } from "./helpers/db";
import { countCafe, type CountCafe } from "./helpers/count";
import { as, requireServer } from "./helpers/http";

let fx: CountCafe;
const HOUR = 3_600_000;
const ago = (ms: number) => new Date(Date.now() - ms);

type Summary = {
  staleHours: number;
  carryOpenOrdersOnHandover: boolean;
  open: { total: number; byStatus: Record<string, number>; refs: string[] };
  stale: Array<{ orderNumber: number; status: string; actions: string[]; remaining: number }>;
  staleCount: number;
};

async function order(data: {
  status: "PENDING_WAITER_APPROVAL" | "CONFIRMED" | "PREPARING" | "READY" | "SERVED" | "CANCELLED";
  createdAt?: Date;
  readyAt?: Date;
  servedAt?: Date;
  paid?: boolean;
  branchId?: string;
}) {
  const branchId = data.branchId ?? fx.branchId;
  const last = await db.order.aggregate({ where: { branchId }, _max: { orderNumber: true } });
  return db.order.create({
    data: {
      cafeId: fx.cafeId, branchId,
      orderNumber: (last._max.orderNumber ?? 0) + 1,
      type: "DINE_IN", status: data.status, source: "CASHIER_POS",
      customerName: fx.marker,
      subtotal: 40, total: 40,
      paidAmount: data.paid ? 40 : 0,
      remainingAmount: data.paid ? 0 : 40,
      paymentStatus: data.paid ? "PAID" : "UNPAID",
      createdAt: data.createdAt,
      readyAt: data.readyAt,
      servedAt: data.servedAt,
      createdById: fx.cashier.id,
    },
  });
}

const summary = (email: string, query = "") => as<Summary>(email, `/api/orders/open-summary${query}`);

before(async () => {
  await requireServer();
  fx = await countCafe("OPS001");
});

after(async () => {
  await teardownTaggedCafe(fx?.cafeId, [], { disconnect: true });
});

beforeEach(async () => {
  await purgeOrderTracesFor({ cafeId: fx.cafeId }); await db.order.deleteMany({ where: { cafeId: fx.cafeId } });
  await db.auditLog.deleteMany({ where: { cafeId: fx.cafeId } });
  await db.cafeSettings.update({ where: { cafeId: fx.cafeId }, data: { staleOrderAlertHours: 2, carryOpenOrdersOnHandover: false } });
});

describe("OPS-001 open-orders summary", () => {
  test("counts what blocks a handover, by status, with order numbers", async () => {
    const a = await order({ status: "READY" });
    const b = await order({ status: "CONFIRMED" });
    await order({ status: "PENDING_WAITER_APPROVAL" });
    await order({ status: "SERVED", paid: true, servedAt: new Date() });
    await order({ status: "CANCELLED" });
    await order({ status: "READY", branchId: fx.otherBranchId });

    const r = await summary(fx.cashier.email);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.open.total, 3, "served, cancelled and the other branch do not count");
    assert.deepEqual(r.body.open.byStatus, { READY: 1, CONFIRMED: 1, PENDING_WAITER_APPROVAL: 1 });
    assert.deepEqual(r.body.open.refs.slice(0, 2), [`#${a.orderNumber}`, `#${b.orderNumber}`]);
    assert.equal(r.body.carryOpenOrdersOnHandover, false);
  });

  test("branch-pinned staff cannot ask about another branch; the owner may pick one", async () => {
    await order({ status: "READY", branchId: fx.otherBranchId });
    const cross = await summary(fx.cashier.email, `?branchId=${fx.otherBranchId}`);
    assert.equal(cross.status, 403);
    const owner = await summary(fx.owner.email, `?branchId=${fx.otherBranchId}`);
    assert.equal(owner.status, 200, owner.text);
    assert.equal(owner.body.open.total, 1);
    const foreign = await summary(fx.owner.email, "?branchId=not-a-branch");
    assert.equal(foreign.status, 404);
  });

  test("reading the summary writes nothing", async () => {
    await order({ status: "READY", createdAt: ago(5 * HOUR), readyAt: ago(5 * HOUR) });
    const before_ = await db.order.findMany({ where: { cafeId: fx.cafeId }, orderBy: { id: "asc" } });
    await summary(fx.manager.email);
    const after_ = await db.order.findMany({ where: { cafeId: fx.cafeId }, orderBy: { id: "asc" } });
    assert.deepEqual(after_, before_);
    assert.equal(await db.auditLog.count({ where: { cafeId: fx.cafeId } }), 0);
  });
});

describe("OPS-001 forgotten orders", () => {
  test("flags old orders with the action that resolves each, and ignores fresh activity", async () => {
    const confirmed = await order({ status: "CONFIRMED", createdAt: ago(3 * HOUR) });
    const ready = await order({ status: "READY", createdAt: ago(4 * HOUR), readyAt: ago(3 * HOUR) });
    await order({ status: "READY", createdAt: ago(4 * HOUR), readyAt: ago(10 * 60_000) });
    const servedUnpaid = await order({ status: "SERVED", createdAt: ago(5 * HOUR), servedAt: ago(3 * HOUR) });
    await order({ status: "SERVED", paid: true, createdAt: ago(5 * HOUR), servedAt: ago(3 * HOUR) });
    const pending = await order({ status: "PENDING_WAITER_APPROVAL", createdAt: ago(3 * HOUR) });
    const paidPreparing = await order({ status: "PREPARING", paid: true, createdAt: ago(3 * HOUR) });
    await order({ status: "CONFIRMED", createdAt: ago(30 * 60_000) });

    const r = await summary(fx.manager.email);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.staleHours, 2);
    const byNumber = new Map(r.body.stale.map((o) => [o.orderNumber, o]));
    assert.equal(r.body.staleCount, 5);
    assert.deepEqual(byNumber.get(confirmed.orderNumber)?.actions, ["CANCEL", "COLLECT"]);
    assert.deepEqual(byNumber.get(ready.orderNumber)?.actions, ["SERVE", "COLLECT"]);
    assert.deepEqual(byNumber.get(servedUnpaid.orderNumber)?.actions, ["COLLECT"]);
    assert.deepEqual(byNumber.get(pending.orderNumber)?.actions, ["APPROVE"]);
    assert.deepEqual(byNumber.get(paidPreparing.orderNumber)?.actions, [], "collected money cannot be cancelled away");
    assert.equal(byNumber.get(servedUnpaid.orderNumber)?.remaining, 40);
  });

  test("0 hours turns the alert off", async () => {
    await db.cafeSettings.update({ where: { cafeId: fx.cafeId }, data: { staleOrderAlertHours: 0 } });
    await order({ status: "CONFIRMED", createdAt: ago(30 * HOUR) });
    const r = await summary(fx.manager.email);
    assert.equal(r.body.staleCount, 0);
    assert.deepEqual(r.body.stale, []);
    assert.equal(r.body.open.total, 1, "the open count is unaffected");
  });

  test("the threshold is the owner's: audited, validated, refused to a cashier, bounded in the database", async () => {
    const denied = await as(fx.cashier.email, "/api/cafe/handover-policy", {
      method: "PATCH", body: JSON.stringify({ staleOrderAlertHours: 5 }),
    });
    assert.equal(denied.status, 403);

    for (const bad of [49, -1, 1.5, "3"]) {
      const r = await as(fx.owner.email, "/api/cafe/handover-policy", {
        method: "PATCH", body: JSON.stringify({ staleOrderAlertHours: bad }),
      });
      assert.equal(r.status, 400, `value ${String(bad)} must be refused`);
    }
    const empty = await as(fx.owner.email, "/api/cafe/handover-policy", { method: "PATCH", body: "{}" });
    assert.equal(empty.status, 400);

    const ok = await as<{ staleOrderAlertHours: number }>(fx.owner.email, "/api/cafe/handover-policy", {
      method: "PATCH", body: JSON.stringify({ staleOrderAlertHours: 5 }),
    });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.body.staleOrderAlertHours, 5);
    const audit = await db.auditLog.findFirstOrThrow({
      where: { cafeId: fx.cafeId, action: "STALE_ORDER_ALERT_HOURS_CHANGED" },
    });
    assert.deepEqual(
      [(audit.details as { oldValue: number }).oldValue, (audit.details as { newValue: number }).newValue],
      [2, 5],
    );
    assert.equal(
      await db.auditLog.count({ where: { cafeId: fx.cafeId, action: "HANDOVER_CARRY_OPEN_ORDERS_CHANGED" } }),
      0,
      "only the field that changed is audited",
    );

    await assert.rejects(
      db.cafeSettings.update({ where: { cafeId: fx.cafeId }, data: { staleOrderAlertHours: 49 } }),
      /staleOrderAlertHours_range|check constraint/i,
    );
  });
});

describe("OPS-001 the screens use these, through the ordinary routes", () => {
  const read = (f: string) => readFileSync(f, "utf8");

  test("the close dialog reads the open orders before the count", () => {
    const code = read("src/components/pos/shift-controls.tsx");
    assert.match(code, /\/api\/orders\/open-summary\?branchId=/);
    assert.match(code, /data-testid="close-open-orders-notice"/);
  });

  test("the banner is shown to owners and branch managers and acts via the status route", () => {
    const shell = read("src/components/app-shell.tsx");
    assert.match(shell, /<StaleOrdersBanner/);
    assert.match(shell, /user\.role === "CAFE_OWNER" \|\| user\.role === "BRANCH_MANAGER"\) && can\("orders:read"\)/);
    const banner = read("src/components/stale-orders-banner.tsx");
    assert.match(banner, /\/api\/orders\/\$\{order\.id\}\/status/);
    assert.match(banner, /window\.confirm/, "cancelling asks first");
  });

  test("serve-all serves one order at a time through the status route and skips orders that must be paid first", () => {
    const code = read("src/app/(app)/kitchen/page.tsx");
    assert.match(code, /data-testid="serve-all-ready"/);
    assert.match(code, /for \(const order of list\)[\s\S]{0,200}\/api\/orders\/\$\{order\.id\}\/status/);
    assert.match(code, /colOrders\.filter\(\(o\) => !serveBlockedFor\(o\)\)/);
  });

  test("the migration is additive and bounded", () => {
    const dir = readdirSync("prisma/migrations").find((d) => d.endsWith("_stale_order_alert_hours"));
    assert.ok(dir);
    const sql = read(`prisma/migrations/${dir}/migration.sql`);
    assert.match(sql, /"staleOrderAlertHours" INTEGER NOT NULL DEFAULT 2/);
    assert.match(sql, /BETWEEN 0 AND 48/);
    assert.ok(!/DROP |UPDATE "|_disposable_test_database/i.test(sql));
  });
});
