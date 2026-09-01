import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";
import { db, tag, teardownTaggedCafe } from "./helpers/db";
import { handoverStartBlockers } from "@/lib/handover-blockers";

const MARKER = tag("HANDOVER002");
const cafeIds: string[] = [];
let sequence = 0;

type Fixture = {
  cafeId: string;
  branchId: string;
  userId: string;
  shiftId: string;
  stockReasonId: string;
  handoverReasonId: string;
};

type FixtureSettings = {
  stockCountPolicy: "NO_SHIFT_COUNT" | "CRITICAL" | "FULL" | "HYBRID" | "CYCLE";
  handoverCountType: "CRITICAL" | "FULL";
};

async function fixture(settings: FixtureSettings = { stockCountPolicy: "NO_SHIFT_COUNT", handoverCountType: "FULL" }): Promise<Fixture> {
  sequence += 1;
  const cafe = await db.cafe.create({
    data: {
      name: `${MARKER} cafe ${sequence}`,
      slug: `${MARKER}-cafe-${sequence}`.toLowerCase(),
      settings: { create: settings },
      branches: { create: { name: `${MARKER} branch ${sequence}` } },
    },
    include: { branches: true },
  });
  cafeIds.push(cafe.id);
  const branchId = cafe.branches[0].id;
  const user = await db.user.create({
    data: {
      cafeId: cafe.id, branchId, role: "CAFE_OWNER",
      email: `${MARKER}-${sequence}@example.invalid`, name: `${MARKER} ${sequence}`,
      passwordHash: "test",
    },
  });
  const shift = await db.shift.create({
    data: { cafeId: cafe.id, branchId, cashierId: user.id, shiftNumber: sequence, openingCashAmount: 0, expectedCashAmount: 0 },
  });
  const stockReason = await db.reasonCode.create({
    data: { cafeId: cafe.id, domain: "STOCK", code: `${MARKER}-stock-${sequence}`, label: "stock" },
  });
  const handoverReason = await db.reasonCode.create({
    data: { cafeId: cafe.id, domain: "HANDOVER", code: `${MARKER}-handover-${sequence}`, label: "handover" },
  });
  return { cafeId: cafe.id, branchId, userId: user.id, shiftId: shift.id, stockReasonId: stockReason.id, handoverReasonId: handoverReason.id };
}

const blockers = (fx: Fixture, excludeHandoverId?: string | null) =>
  db.$transaction((tx) => handoverStartBlockers(tx, { cafeId: fx.cafeId, branchId: fx.branchId, excludeHandoverId }));

async function order(fx: Fixture, status: "CONFIRMED" | "PREPARING" | "READY" | "SERVED" | "CANCELLED" | "PENDING_WAITER_APPROVAL", createdAt = new Date()) {
  sequence += 1;
  return db.order.create({
    data: {
      cafeId: fx.cafeId, branchId: fx.branchId, orderNumber: sequence,
      status, subtotal: 0, total: 0, createdAt,
    },
  });
}

async function purchase(fx: Fixture, status: "DRAFT" | "CONFIRMED") {
  sequence += 1;
  return db.purchaseInvoice.create({
    data: { cafeId: fx.cafeId, branchId: fx.branchId, invoiceNumber: `${MARKER}-${sequence}`, status },
  });
}

async function countSession(fx: Fixture, status: "DRAFT" | "IN_PROGRESS" | "SUBMITTED" | "RECOUNT_REQUIRED" | "CONFIRMED" | "LOCKED", lockedByHandoverId?: string | null) {
  return db.stockCountSession.create({
    data: {
      cafeId: fx.cafeId, branchId: fx.branchId, initiatedById: fx.userId,
      type: "FULL", mode: "BLIND", scopeDerivation: "ALL_ELIGIBLE", status,
      ...(lockedByHandoverId === undefined ? {} : { lockedByHandoverId }),
    },
  });
}

async function correction(fx: Fixture, status: "PENDING_APPROVAL" | "APPROVED") {
  sequence += 1;
  const item = await db.inventoryItem.create({ data: { cafeId: fx.cafeId, branchId: fx.branchId, name: `${MARKER} item ${sequence}`, unit: "KG" } });
  const session = await countSession(fx, "CONFIRMED");
  const line = await db.stockCountLine.create({ data: { sessionId: session.id, inventoryItemId: item.id, unit: "KG" } });
  return db.stockCountCorrection.create({
    data: {
      lineId: line.id, oldCountedQuantity: 1, newCountedQuantity: 2,
      reasonCodeId: fx.stockReasonId, actorId: fx.userId, status,
      ...(status === "APPROVED" ? { approvedById: fx.userId, approvedAt: new Date() } : {}),
    },
  });
}

async function handover(
  fx: Fixture,
  status: "DRAFT" | "OUTGOING_SUBMITTED" | "INCOMING_REVIEW" | "REJECTED" | "ACCEPTED" | "MANAGER_EXCEPTION" | "COMPLETED",
) {
  return db.handoverSession.create({
    data: {
      cafeId: fx.cafeId, branchId: fx.branchId, outgoingShiftId: fx.shiftId, outgoingUserId: fx.userId, status,
      ...(status === "REJECTED" ? { rejectedAt: new Date(), rejectionReasonCodeId: fx.handoverReasonId } : {}),
      ...(status === "MANAGER_EXCEPTION" ? { exceptionAt: new Date(), exceptionById: fx.userId } : {}),
      ...(status === "COMPLETED" ? { completedAt: new Date() } : {}),
    },
  });
}

after(() => teardownTaggedCafe(cafeIds, [], { disconnect: true }));

describe("HANDOVER-002 authoritative handover start blockers", () => {
  test("a quiet valid branch has no blockers", async () => {
    const fx = await fixture();
    assert.deepEqual(await blockers(fx), []);
  });

  test("future stock-consuming order statuses block while served and cancelled orders do not", async () => {
    for (const status of ["CONFIRMED", "PREPARING", "READY"] as const) {
      const fx = await fixture();
      const row = await order(fx, status);
      const [blocker] = await blockers(fx);
      assert.equal(blocker.code, "UNSERVED_ORDERS");
      assert.equal(blocker.count, 1);
      assert.deepEqual(blocker.ids, [row.id]);
    }
    for (const status of ["SERVED", "CANCELLED"] as const) {
      const fx = await fixture();
      await order(fx, status);
      assert.deepEqual(await blockers(fx), []);
    }
  });

  test("waiter approval orders are separately blocked and never counted as unserved", async () => {
    const fx = await fixture();
    const pending = await order(fx, "PENDING_WAITER_APPROVAL");
    const result = await blockers(fx);
    assert.deepEqual(result.map((blocker) => blocker.code), ["PENDING_APPROVAL_ORDERS"]);
    assert.equal(result[0].count, 1);
    assert.deepEqual(result[0].ids, [pending.id]);
  });

  test("only draft purchases block", async () => {
    const fx = await fixture();
    const draft = await purchase(fx, "DRAFT");
    await purchase(fx, "CONFIRMED");
    const result = await blockers(fx);
    assert.deepEqual(result.map((blocker) => blocker.code), ["DRAFT_PURCHASE_INVOICES"]);
    assert.equal(result[0].count, 1);
    assert.deepEqual(result[0].ids, [draft.id]);
  });

  test("only pending count corrections block", async () => {
    const fx = await fixture();
    const pending = await correction(fx, "PENDING_APPROVAL");
    await correction(fx, "APPROVED");
    const result = await blockers(fx);
    assert.deepEqual(result.map((blocker) => blocker.code), ["PENDING_CORRECTIONS"]);
    assert.equal(result[0].count, 1);
    assert.deepEqual(result[0].ids, [pending.id]);
  });

  test("every active count status blocks, but terminal counts do not", async () => {
    for (const status of ["DRAFT", "IN_PROGRESS", "SUBMITTED", "RECOUNT_REQUIRED"] as const) {
      const fx = await fixture();
      const row = await countSession(fx, status);
      const [blocker] = await blockers(fx);
      assert.equal(blocker.code, "FOREIGN_ACTIVE_COUNT");
      assert.deepEqual(blocker.ids, [row.id]);
    }
    for (const status of ["CONFIRMED", "LOCKED"] as const) {
      const fx = await fixture();
      await countSession(fx, status);
      assert.deepEqual(await blockers(fx), []);
    }
  });

  test("active count ownership uses only lockedByHandoverId and null ownership is foreign", async () => {
    const fx = await fixture();
    const current = await handover(fx, "DRAFT");
    await countSession(fx, "DRAFT", current.id);
    assert.deepEqual(await blockers(fx, current.id), []);

    const foreign = await fixture();
    const unowned = await countSession(foreign, "DRAFT", null);
    const [blocker] = await blockers(foreign);
    assert.equal(blocker.code, "FOREIGN_ACTIVE_COUNT");
    assert.deepEqual(blocker.ids, [unowned.id]);
  });

  test("every active handover status blocks and exact exclusion suppresses only itself", async () => {
    for (const status of ["DRAFT", "OUTGOING_SUBMITTED", "INCOMING_REVIEW", "REJECTED"] as const) {
      const fx = await fixture();
      const row = await handover(fx, status);
      const [blocker] = await blockers(fx);
      assert.equal(blocker.code, "EXISTING_ACTIVE_HANDOVER");
      assert.deepEqual(blocker.ids, [row.id]);
      assert.deepEqual(await blockers(fx, row.id), []);
    }
  });

  test("accepted, manager-exception, and completed handovers are terminal", async () => {
    for (const status of ["ACCEPTED", "MANAGER_EXCEPTION", "COMPLETED"] as const) {
      const fx = await fixture();
      await handover(fx, status);
      assert.deepEqual(await blockers(fx), []);
    }
  });

  test("configuration errors map to one blocker with SH-8 error-code ids", async () => {
    const fx = await fixture({ stockCountPolicy: "HYBRID", handoverCountType: "CRITICAL" });
    const selected = await blockers(fx);
    assert.deepEqual(selected.map((blocker) => blocker.code), ["HANDOVER_CONFIG_ERROR"]);
    assert.deepEqual(selected[0].ids, ["SELECTED_WITH_NO_ITEMS"]);
    assert.equal(selected[0].count, 1);

    await db.branch.update({ where: { id: fx.branchId }, data: { stockCountPolicyOverride: "CYCLE" } });
    const multiple = await blockers(fx);
    assert.deepEqual(multiple[0].ids, ["CYCLE_POLICY_UNSUPPORTED", "SELECTED_WITH_NO_ITEMS"]);
    assert.equal(multiple[0].count, 2);
  });

  test("all applicable categories return together in the prescribed order", async () => {
    const fx = await fixture({ stockCountPolicy: "NO_SHIFT_COUNT", handoverCountType: "CRITICAL" });
    await order(fx, "CONFIRMED");
    await order(fx, "PENDING_WAITER_APPROVAL");
    await purchase(fx, "DRAFT");
    await correction(fx, "PENDING_APPROVAL");
    await countSession(fx, "DRAFT");
    await handover(fx, "DRAFT");
    const result = await blockers(fx);
    assert.deepEqual(result.map((blocker) => blocker.code), [
      "UNSERVED_ORDERS", "PENDING_APPROVAL_ORDERS", "DRAFT_PURCHASE_INVOICES",
      "PENDING_CORRECTIONS", "FOREIGN_ACTIVE_COUNT", "EXISTING_ACTIVE_HANDOVER",
      "HANDOVER_CONFIG_ERROR",
    ]);
  });

  test("branch and cafe noise never affects counts or ids", async () => {
    const fx = await fixture();
    const otherBranch = await db.branch.create({ data: { cafeId: fx.cafeId, name: `${MARKER} sibling ${sequence}` } });
    const otherCafe = await fixture();
    await db.order.create({ data: { cafeId: fx.cafeId, branchId: otherBranch.id, orderNumber: sequence + 10000, status: "CONFIRMED", subtotal: 0, total: 0 } });
    await db.purchaseInvoice.create({ data: { cafeId: fx.cafeId, branchId: otherBranch.id, invoiceNumber: `${MARKER}-sibling-${sequence}`, status: "DRAFT" } });
    await countSession({ ...fx, branchId: otherBranch.id }, "DRAFT");
    await handover({ ...fx, branchId: otherBranch.id }, "DRAFT");
    await correction({ ...fx, branchId: otherBranch.id }, "PENDING_APPROVAL");
    await order(otherCafe, "CONFIRMED");
    assert.deepEqual(await blockers(fx), []);
  });

  test("row blockers report exact totals, cap ids at 20, and order samples deterministically", async () => {
    const fx = await fixture();
    const expected: string[] = [];
    for (let index = 0; index < 25; index += 1) {
      const row = await order(fx, "CONFIRMED", new Date(Date.UTC(2020, 0, 1, 0, 0, index)));
      expected.push(row.id);
    }
    const [first] = await blockers(fx);
    const [second] = await blockers(fx);
    assert.equal(first.count, 25);
    assert.equal(first.ids.length, 20);
    assert.deepEqual(first.ids, expected.slice(0, 20));
    assert.deepEqual(second.ids, first.ids);
  });

  test("the supplied transaction sees uncommitted blockers and the full call emits no write SQL", async () => {
    const fx = await fixture();
    const visibility = await db.$transaction(async (tx) => {
      const row = await tx.order.create({ data: { cafeId: fx.cafeId, branchId: fx.branchId, orderNumber: sequence + 20000, status: "CONFIRMED", subtotal: 0, total: 0 } });
      const result = await handoverStartBlockers(tx, { cafeId: fx.cafeId, branchId: fx.branchId });
      return result[0]?.ids.includes(row.id) ?? false;
    });
    assert.equal(visibility, true);

    const queries: string[] = [];
    const client = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL, log: [{ emit: "event", level: "query" }] });
    client.$on("query", (event) => queries.push(event.query));
    try {
      await client.$transaction((tx) => handoverStartBlockers(tx, { cafeId: fx.cafeId, branchId: fx.branchId }));
      assert.equal(queries.some((sql) => /\b(?:INSERT|UPDATE|DELETE|TRUNCATE)\b/i.test(sql)), false);
    } finally {
      await client.$disconnect();
    }
  });
});
