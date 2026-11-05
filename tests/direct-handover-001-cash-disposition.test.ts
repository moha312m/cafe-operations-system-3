// DIRECT-HANDOVER-001 — owner-approved simplified direct shift handover and explicit
// closing-cash disposition.
//
// Everything runs through the normal entry points (HTTP routes, and the service the
// routes call for the races), against the disposable database only. The proofs:
//
//   * the closing allocation reconciles exactly to the COUNTED cash, in every shape;
//   * a declared delivery is a declaration until the NAMED recipient confirms it from
//     their own account, and pending confirmation never blocks the next shift;
//   * the incoming employee's single action opens exactly the retained amount, writes no
//     count, no per-line signature and no cash verification;
//   * double acceptance, a stale review, a lost response and a second recipient are
//     all refused or replayed without writing twice;
//   * the legacy per-line / independent-count flow and historical handovers are unchanged.

import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcryptjs";
import { db, tag, teardownTaggedCafe, purgeOrderTracesFor } from "./helpers/db";
import { countCafe, countItem, COUNT_PASSWORD, type CountCafe } from "./helpers/count";
import { as as rawAs, login, requireServer } from "./helpers/http";

// The direct-handover mutations are fenced by `withIdempotency`, which reads the per-attempt key from
// the `Idempotency-Key` header. Cases below still name their key as `idempotencyKey`; this moves it to
// the header (generating one when a case named none), so every case keeps its exact meaning.
const IDEMPOTENT_ROUTE = /^\/api\/(shifts\/[^/]+\/cash-disposition|handovers\/[^/]+\/(direct|issues)|handover-issues\/[^/]+\/resolve|cash-deliveries\/[^/]+\/(confirm|dispute|resolve))$/;
function as<T = Record<string, unknown>>(email: string, path: string, init: RequestInit = {}) {
  if (init.method !== "POST" || !IDEMPOTENT_ROUTE.test(path) || typeof init.body !== "string" || (init.headers as Record<string, string> | undefined)?.["Idempotency-Key"]) return rawAs<T>(email, path, init);
  const { idempotencyKey, ...rest } = JSON.parse(init.body) as { idempotencyKey?: string };
  return rawAs<T>(email, path, { ...init, body: JSON.stringify(rest), headers: { ...(init.headers as Record<string, string> | undefined), "Idempotency-Key": idempotencyKey ?? `auto-${crypto.randomUUID()}` } });
}

const MARKER = tag("DIRECT001");
const GRANTS_FULL = { handoverSubmit: true, handoverException: true };

type CashCloseLib = typeof import("@/lib/cash-close");
const cashCloseLib = (): Promise<CashCloseLib> => import("@/lib/cash-close");
type CustodyLib = typeof import("@/lib/custody");
const custodyLib = (): Promise<CustodyLib> => import("@/lib/custody");
type DispositionLib = typeof import("@/lib/cash-disposition");
const dispositionLib = (): Promise<DispositionLib> => import("@/lib/cash-disposition");

let fx: CountCafe;
let other: CountCafe;
let incoming: { id: string; email: string };
let incoming2: { id: string; email: string };
let annexManager: { id: string; email: string };
const items: { id: string; name: string }[] = [];
let keySeq = 0;
const key = (label: string) => `${MARKER}-${label}-${++keySeq}`;

async function configureBranch() {
  await db.cafeSettings.update({
    where: { cafeId: fx.cafeId },
    data: { stockCountPolicy: "HYBRID", handoverCountType: "CRITICAL", periodicFullCountSchedule: "MANUAL_ONLY", periodicFullCountWeekday: null, varianceBlocksHandover: false, varianceHardBlockAmount: null },
  });
  await db.branch.update({ where: { id: fx.branchId }, data: { stockCountPolicyOverride: null, handoverCountTypeOverride: null, periodicFullCountScheduleOverride: null, periodicFullCountWeekdayOverride: null } });
  await db.branchOpeningSettings.deleteMany({ where: { branchId: fx.branchId } });
}

async function restoreItems() {
  for (const item of items) {
    await db.inventoryItem.update({ where: { id: item.id }, data: { unit: "KG", isCritical: true, isActive: true, archivedAt: null, currentStock: "10", costPerUnit: 450 } });
  }
}

/** The new tables are append-only evidence guarded by triggers; fixtures disable them inside one transaction, exactly as purgeCafe does. */
async function purgeDisposition(branchId: string) {
  await db.$transaction(async (tx) => {
    const guards: [string, string][] = [
      ["CashDeliveryDeclaration", "CashDeliveryDeclaration_immutable_guard"],
      ["ShiftCashDisposition", "ShiftCashDisposition_immutable_guard"],
      ["HandoverIssue", "HandoverIssue_immutable_guard"],
    ];
    for (const [t, g] of guards) await tx.$executeRawUnsafe(`ALTER TABLE "${t}" DISABLE TRIGGER "${g}"`);
    await tx.$executeRawUnsafe(`DELETE FROM "HandoverIssue" WHERE "branchId" = $1`, branchId);
    await tx.$executeRawUnsafe(`DELETE FROM "CashDeliveryDeclaration" WHERE "branchId" = $1`, branchId);
    await tx.$executeRawUnsafe(`DELETE FROM "ShiftCashDisposition" WHERE "branchId" = $1`, branchId);
    for (const [t, g] of guards) await tx.$executeRawUnsafe(`ALTER TABLE "${t}" ENABLE TRIGGER "${g}"`);
  });
}

async function resetBranch(branchId: string) {
  await purgeDisposition(branchId);
  await db.handoverStockAcknowledgement.deleteMany({ where: { handover: { branchId } } });
  await db.handoverStockBoundary.deleteMany({ where: { handover: { branchId } } });
  await db.handoverRequiredItem.updateMany({ where: { handover: { branchId } }, data: { satisfiedByLineId: null } });
  await db.handoverSession.updateMany({ where: { branchId }, data: { stockCountSessionId: null, acceptedStockCountSessionId: null } });
  await db.shift.updateMany({ where: { branchId }, data: { cashVarianceCaseId: null } });
  await db.stockVarianceSpanCustody.deleteMany({ where: { span: { varianceCase: { branchId } } } });
  await db.stockVarianceSpan.deleteMany({ where: { varianceCase: { branchId } } });
  await db.varianceCase.deleteMany({ where: { branchId } });
  await db.stockCountSession.updateMany({ where: { branchId }, data: { lockedByHandoverId: null, handoverId: null, accountabilityContext: "NONE" } });
  await db.stockCountRebase.deleteMany({ where: { session: { branchId } } });
  await db.stockCountSession.deleteMany({ where: { branchId } });
  await db.inventoryFreeze.deleteMany({ where: { branchId } });
  await db.openingException.deleteMany({ where: { branchId } });
  await db.handoverCarriedOrder.deleteMany({ where: { branchId } });
  await db.shiftMaterialsDecision.deleteMany({ where: { branchId } });
  await db.handoverSession.deleteMany({ where: { branchId } });
  await db.tenderReconciliation.deleteMany({ where: { branchId } });
  await db.payment.deleteMany({ where: { branchId } });
  await db.inventoryTransaction.deleteMany({ where: { branchId } });
  await purgeOrderTracesFor({ branchId });
  await db.order.deleteMany({ where: { branchId } });
  await db.shiftPlaceReceipt.deleteMany({ where: { branchId } });
  await db.shiftCustody.deleteMany({ where: { shift: { branchId } } });
  await db.custodyParticipant.deleteMany({ where: { custodyPeriod: { branchId } } });
  await db.custodyPeriod.updateMany({ where: { branchId }, data: { previousPeriodId: null } });
  await db.custodyPeriod.deleteMany({ where: { branchId } });
  await db.shift.deleteMany({ where: { branchId } });
}

async function openOperationalShift(userId: string, openingCash = 100, branchId = fx.branchId) {
  const last = await db.shift.aggregate({ where: { branchId }, _max: { shiftNumber: true } });
  const shift = await db.shift.create({
    data: { cafeId: fx.cafeId, branchId, cashierId: userId, shiftNumber: (last._max.shiftNumber ?? 0) + 1, openingCashAmount: openingCash, expectedCashAmount: openingCash },
  });
  const { ensureCustodyForShift } = await custodyLib();
  await db.$transaction((tx) => ensureCustodyForShift(tx, { cafeId: fx.cafeId, branchId, shiftId: shift.id, userId, openingCashAmount: openingCash }));
  return shift;
}

type Delivery = { destination: "OWNER" | "MANAGER"; recipientId: string; amount: number | string; reference?: string };
const postDisposition = (email: string, shiftId: string, body: { deliveries: Delivery[]; retainedAmount: number | string; note?: string; idempotencyKey?: string }) =>
  as<{ disposition?: { id: string; fingerprint: string; retainedAmount: number; deliveredAmount: number; countedCash: number; expectedCash: number; cashDifference: number; deliveries: { id: string; status: string; amount: number }[] }; alreadyRecorded?: boolean; error?: string }>(
    email, `/api/shifts/${shiftId}/cash-disposition`, { method: "POST", body: JSON.stringify({ idempotencyKey: key("disp"), ...body }) },
  );
const post = <T = Record<string, unknown>>(email: string, body: unknown) => as<T>(email, "/api/handovers", { method: "POST", body: JSON.stringify(body) });

type Closed = { handoverId: string; shiftId: string; sessionId: string | null };

/**
 * The outgoing journey: close the money (counted cash differs from expected on purpose),
 * state the cash disposition, count the materials and finish. `disposition: null` stops
 * before the disposition so refusals can be exercised.
 */
async function outgoingJourney(opts: { actual?: number; disposition?: { deliveries: Delivery[]; retainedAmount: number } | null; finish?: boolean } = {}): Promise<Closed> {
  await resetBranch(fx.branchId);
  const shift = await openOperationalShift(fx.cashier.id, 100);
  const { closeShiftWithSettlement } = await cashCloseLib();
  const closed = await closeShiftWithSettlement({
    shiftId: shift.id, actualCash: opts.actual ?? 3000, actorId: fx.cashier.id, closedByManager: false,
    handoverTarget: "SHIFT_TO_SHIFT", grants: GRANTS_FULL, reason: "فرق متعمد في الفكسشر",
  });
  assert.ok(closed.handoverId, `no handover (status ${closed.status})`);
  if (opts.disposition) {
    const r = await postDisposition(fx.cashier.email, shift.id, opts.disposition);
    assert.equal(r.status, 201, r.text);
  }
  let sessionId: string | null = null;
  if (opts.finish !== false) {
    const started = await post<{ countSession: { id: string } }>(fx.cashier.email, { action: "start_count", handoverId: closed.handoverId });
    assert.equal(started.status, 200, started.text);
    sessionId = started.body.countSession.id;
    const lines = await db.stockCountLine.findMany({ where: { sessionId }, select: { id: true } });
    for (const line of lines) {
      const r = await as(fx.cashier.email, `/api/stock-counts/${sessionId}/lines/${line.id}`, { method: "PATCH", body: JSON.stringify({ countedQuantity: 10 }) });
      assert.ok(r.status < 300, r.text);
    }
    const fin = await post<{ status?: string }>(fx.cashier.email, { action: "finish_outgoing", handoverId: closed.handoverId });
    assert.equal(fin.status, 200, fin.text);
    assert.equal(fin.body.status, "OUTGOING_SUBMITTED");
  }
  return { handoverId: closed.handoverId!, shiftId: shift.id, sessionId };
}

type Summary = { reviewVersion: string; status: string; incoming: { state: string; shiftId?: string }; stock: { disclosed: boolean; lines: { name: string; quantity: number | null }[] }; cash: { retained: number | null; delivered: number | null; counted: number | null; expected: number | null; difference: number | null; deliveries: { id: string; status: string; amount: number; recipientName: string }[] }; can: { acknowledge: boolean }; acknowledgement: { mode: string; independentVerification: boolean } | null; blockers: string[]; error?: string };
const summaryOf = (email: string, handoverId: string) => as<Summary>(email, `/api/handovers/${handoverId}/direct`);
const acceptDirect = (email: string, handoverId: string, reviewVersion: string, idempotencyKey = key("accept")) =>
  as<{ status?: string; incomingShiftId?: string; alreadyAccepted?: boolean; error?: string }>(email, `/api/handovers/${handoverId}/direct`, { method: "POST", body: JSON.stringify({ reviewVersion, idempotencyKey }) });

async function incomingOpensShift(email = incoming.email) {
  const r = await as<{ shift?: { id: string; custodyGateReason: string | null } }>(email, "/api/shifts", { method: "POST", body: JSON.stringify({ openingCashAmount: 0 }) });
  assert.ok(r.status === 201 || r.status === 200, r.text);
  return r.body.shift!;
}

const statusIs = (status: number) => (error: unknown) => (error as { status?: number }).status === status;

before(async () => {
  await requireServer();
  fx = await countCafe("DIRECT001");
  other = await countCafe("DIRECT001X");
  for (const k of ["alpha", "bravo"]) {
    const created = await countItem(fx, k, { stock: 10, isCritical: true });
    items.push({ id: created.id, name: created.name });
  }
  const hash = await bcrypt.hash(COUNT_PASSWORD, 10);
  const mk = async (suffix: string, role: "CASHIER" | "BRANCH_MANAGER", branchId: string) => {
    const u = await db.user.create({ data: { email: `${fx.marker.toLowerCase()}-${suffix}@example.invalid`, name: `${fx.marker}-${suffix}`, passwordHash: hash, role, cafeId: fx.cafeId, branchId }, select: { id: true, email: true } });
    await login(u.email, COUNT_PASSWORD);
    return u;
  };
  incoming = await mk("incoming", "CASHIER", fx.branchId);
  incoming2 = await mk("incoming2", "CASHIER", fx.branchId);
  annexManager = await mk("annexmgr", "BRANCH_MANAGER", fx.otherBranchId);
});

beforeEach(async () => {
  await configureBranch();
  await restoreItems();
});

after(async () => {
  await teardownTaggedCafe(
    [fx?.cafeId, other?.cafeId].filter((id): id is string => Boolean(id)),
    [() => resetBranch(fx.branchId), () => resetBranch(fx.otherBranchId), () => resetBranch(other.branchId), () => resetBranch(other.otherBranchId)],
    { disconnect: true },
  );
});

// ═════════════════════════ allocation arithmetic ═════════════════════════

describe("closing allocation reconciles exactly to the counted cash", () => {
  test("pure arithmetic: split, all retained, all delivered, zero, precision", async () => {
    const { planAllocation } = await dispositionLib();
    const d = (amount: number | string): Delivery => ({ destination: "OWNER", recipientId: "u", amount });
    assert.deepEqual(planAllocation(3000, [d(2500)], 500).retained, 500);
    assert.equal(planAllocation(3000, [], 3000).delivered, 0);
    assert.equal(planAllocation(3000, [d(3000)], 0).retained, 0);
    assert.equal(planAllocation(0, [], 0).counted, 0);
    assert.equal(planAllocation("0.10", [d("0.10")], "0").delivered, 0.1);
    // cents do not drift: 0.1 + 0.2 == 0.3 exactly
    assert.equal(planAllocation("0.30", [d("0.10"), { ...d("0.20"), reference: "b" }], 0).delivered, 0.3);
    for (const [counted, deliveries, retained] of [
      [3000, [d(2500)], 499.99], [3000, [d(2500)], 500.01], [3000, [d(2500.005)], 499.995],
      [3000, [d(-1)], 3001], [3000, [d(0)], 3000], [3000, [], -0.01], [3000, [d("abc")], 0],
    ] as const) {
      assert.throws(() => planAllocation(counted, [...deliveries], retained), statusIs(400), JSON.stringify([counted, deliveries, retained]));
    }
  });

  test("scenario 1: EGP 3,000 counted, 2,500 declared to the owner, 500 retained", async () => {
    const h = await outgoingJourney({ actual: 3000, disposition: { deliveries: [{ destination: "OWNER", recipientId: fx.owner.id, amount: 2500, reference: "كشف-1" }], retainedAmount: 500 } });
    const row = await db.shiftCashDisposition.findUniqueOrThrow({ where: { shiftId: h.shiftId }, include: { deliveries: true } });
    assert.equal(Number(row.countedCash), 3000);
    assert.equal(Number(row.expectedCash), 100, "expected cash is the shift's own figure");
    assert.equal(Number(row.cashDifference), 2900, "the counted-vs-expected difference is recorded separately");
    assert.equal(Number(row.deliveredAmount), 2500);
    assert.equal(Number(row.retainedAmount), 500);
    assert.equal(row.handoverId, h.handoverId);
    assert.equal(row.deliveries.length, 1);
    assert.equal(row.deliveries[0].status, "DECLARED");
    assert.equal(row.deliveries[0].recipientId, fx.owner.id);
    assert.equal(row.deliveries[0].declaredById, fx.cashier.id);
    assert.equal(row.deliveries[0].confirmedById, null);
    assert.ok(await db.auditLog.findFirst({ where: { entityId: row.id, action: "SHIFT_CASH_DISPOSITION_RECORDED" } }));
    assert.ok(await db.auditLog.findFirst({ where: { entityId: row.deliveries[0].id, action: "CASH_DELIVERY_DECLARED" } }));
    // The close's own discrepancy is untouched.
    const shift = await db.shift.findUniqueOrThrow({ where: { id: h.shiftId } });
    assert.equal(Number(shift.cashDifference), 2900);
    assert.ok(shift.cashVarianceCaseId, "the existing cash variance case stays");
  });

  test("invalid allocations are refused over HTTP and write nothing", async () => {
    const h = await outgoingJourney({ actual: 3000, disposition: null, finish: false });
    const bad: [string, { deliveries: Delivery[]; retainedAmount: number | string }][] = [
      ["short", { deliveries: [{ destination: "OWNER", recipientId: fx.owner.id, amount: 2500 }], retainedAmount: 499.99 }],
      ["over", { deliveries: [{ destination: "OWNER", recipientId: fx.owner.id, amount: 2500 }], retainedAmount: 500.01 }],
      ["three decimals", { deliveries: [{ destination: "OWNER", recipientId: fx.owner.id, amount: "2500.005" }], retainedAmount: "499.995" }],
      ["negative", { deliveries: [{ destination: "OWNER", recipientId: fx.owner.id, amount: -100 }], retainedAmount: 3100 }],
      ["unknown recipient", { deliveries: [{ destination: "OWNER", recipientId: "nobody", amount: 3000 }], retainedAmount: 0 }],
      ["cashier as recipient", { deliveries: [{ destination: "MANAGER", recipientId: incoming.id, amount: 3000 }], retainedAmount: 0 }],
      ["self as recipient", { deliveries: [{ destination: "MANAGER", recipientId: fx.cashier.id, amount: 3000 }], retainedAmount: 0 }],
      ["manager declared as owner", { deliveries: [{ destination: "OWNER", recipientId: fx.manager.id, amount: 3000 }], retainedAmount: 0 }],
      ["owner declared as manager", { deliveries: [{ destination: "MANAGER", recipientId: fx.owner.id, amount: 3000 }], retainedAmount: 0 }],
      ["another branch's manager", { deliveries: [{ destination: "MANAGER", recipientId: annexManager.id, amount: 3000 }], retainedAmount: 0 }],
      ["another café's owner", { deliveries: [{ destination: "OWNER", recipientId: other.owner.id, amount: 3000 }], retainedAmount: 0 }],
    ];
    for (const [label, body] of bad) {
      const r = await postDisposition(fx.cashier.email, h.shiftId, body);
      assert.equal(r.status, 400, `${label}: ${r.status} ${r.text}`);
    }
    assert.equal(await db.shiftCashDisposition.count({ where: { shiftId: h.shiftId } }), 0);
    // Client-supplied server figures are refused by name, not ignored.
    const smuggled = await as(fx.cashier.email, `/api/shifts/${h.shiftId}/cash-disposition`, { method: "POST", body: JSON.stringify({ deliveries: [], retainedAmount: 3000, countedCash: 1, idempotencyKey: key("smuggle") }) });
    assert.equal(smuggled.status, 400);
  });

  test("an open shift cannot declare a disposition; a foreign cashier cannot declare for it", async () => {
    await resetBranch(fx.branchId);
    const open = await openOperationalShift(fx.cashier.id, 100);
    const early = await postDisposition(fx.cashier.email, open.id, { deliveries: [], retainedAmount: 100 });
    assert.equal(early.status, 409, early.text);
    const h = await outgoingJourney({ disposition: null, finish: false });
    const foreign = await postDisposition(incoming.email, h.shiftId, { deliveries: [], retainedAmount: 3000 });
    assert.equal(foreign.status, 403, foreign.text);
    const crossTenant = await postDisposition(other.cashier.email, h.shiftId, { deliveries: [], retainedAmount: 3000 });
    assert.equal(crossTenant.status, 404, crossTenant.text);
  });

  test("written once: same allocation replays, a different one is refused and the record is unchanged", async () => {
    const h = await outgoingJourney({ disposition: null, finish: false });
    const body = { deliveries: [{ destination: "OWNER" as const, recipientId: fx.owner.id, amount: 2500 }], retainedAmount: 500 };
    const first = await postDisposition(fx.cashier.email, h.shiftId, { ...body, idempotencyKey: key("a") });
    assert.equal(first.status, 201, first.text);
    const lostResponseRetry = await postDisposition(fx.cashier.email, h.shiftId, { ...body, idempotencyKey: key("a-retry") });
    assert.equal(lostResponseRetry.status, 200, lostResponseRetry.text);
    assert.equal(lostResponseRetry.body.alreadyRecorded, true);
    assert.equal(lostResponseRetry.body.disposition!.id, first.body.disposition!.id);
    const changed = await postDisposition(fx.cashier.email, h.shiftId, { deliveries: [], retainedAmount: 3000 });
    assert.equal(changed.status, 409, "a stale form must not replace what the next shift opens with");
    assert.equal(await db.cashDeliveryDeclaration.count({ where: { shiftId: h.shiftId } }), 1);
    assert.equal(await db.auditLog.count({ where: { entityId: first.body.disposition!.id, action: "SHIFT_CASH_DISPOSITION_RECORDED" } }), 1);
  });

  test("the database refuses a rewritten or deleted disposition", async () => {
    const h = await outgoingJourney({ disposition: { deliveries: [{ destination: "OWNER", recipientId: fx.owner.id, amount: 100 }], retainedAmount: 2900 }, finish: false });
    await assert.rejects(() => db.shiftCashDisposition.update({ where: { shiftId: h.shiftId }, data: { retainedAmount: 3000, deliveredAmount: 0 } }));
    await assert.rejects(() => db.cashDeliveryDeclaration.updateMany({ where: { shiftId: h.shiftId }, data: { amount: 1 } }));
    await assert.rejects(() => db.cashDeliveryDeclaration.deleteMany({ where: { shiftId: h.shiftId } }));
    await assert.rejects(() => db.$executeRawUnsafe(`UPDATE "ShiftCashDisposition" SET "retainedAmount" = 1 WHERE "shiftId" = $1`, h.shiftId));
  });
});

// ═══════════════════ scenarios 1–4 through the single action ═══════════════════

describe("incoming employee: one action opens exactly the retained amount", () => {
  test("scenario 1 end to end: accept once, start with EGP 500, delivery still pending, nothing counted or signed", async () => {
    const h = await outgoingJourney({ actual: 3000, disposition: { deliveries: [{ destination: "OWNER", recipientId: fx.owner.id, amount: 2500 }], retainedAmount: 500 } });
    const before = await summaryOf(incoming.email, h.handoverId);
    assert.equal(before.status, 200, before.text);
    assert.equal(before.body.incoming.state, "NONE", "the viewer has no shift yet");
    assert.equal(before.body.can.acknowledge, true);
    assert.equal(before.body.stock.disclosed, true, "the approved direct flow shows the quantities being transferred");
    assert.equal(before.body.stock.lines.length, 2);
    assert.equal(before.body.cash.retained, 500);
    assert.equal(before.body.cash.deliveries[0].status, "DECLARED");
    assert.equal(before.body.cash.counted, null, "the incoming employee has no report access, so no counted/expected figure");

    // The UI's first move when the viewer has no shift: open one (gated, holds nothing yet).
    const shift = await incomingOpensShift();
    assert.equal(shift.custodyGateReason, "AWAITING_CUSTODY_TRANSFER");
    const waiting = await summaryOf(incoming.email, h.handoverId);
    assert.equal(waiting.body.incoming.state, "WAITING");

    const res = await acceptDirect(incoming.email, h.handoverId, waiting.body.reviewVersion);
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.status, "COMPLETED");
    assert.equal(res.body.incomingShiftId, shift.id, "the waiting shift is completed, no second shift is created");
    assert.equal(await db.shift.count({ where: { branchId: fx.branchId, cashierId: incoming.id } }), 1);

    const opened = await db.shift.findUniqueOrThrow({ where: { id: shift.id } });
    assert.equal(opened.custodyGateReason, null);
    assert.equal(Number(opened.openingCashAmount), 500, "the next shift starts with the retained amount");
    assert.equal(Number(opened.expectedCashAmount), 500);
    const handover = await db.handoverSession.findUniqueOrThrow({ where: { id: h.handoverId } });
    assert.equal(handover.status, "COMPLETED");
    assert.equal(handover.directAcknowledgedById, incoming.id);
    assert.ok(handover.directAcknowledgedAt);
    assert.equal(handover.cashVerifiedAt, null, "an acknowledgement is not a cash verification");
    assert.equal(handover.cashVerifiedById, null);
    assert.equal(handover.countedOpeningCash, null);
    assert.equal(Number(handover.proposedOpeningCash), 500);
    assert.equal(await db.handoverStockAcknowledgement.count({ where: { handoverId: h.handoverId } }), 0, "no per-line signatures are manufactured");
    const cash = await db.custodyPeriod.findFirstOrThrow({ where: { branchId: fx.branchId, scope: "CASH", status: "OPEN" } });
    assert.equal(Number(cash.openingCashAmount), 500);
    assert.equal((await db.shift.findUniqueOrThrow({ where: { id: h.shiftId } })).status, "CLOSED");
    const audit = await db.auditLog.findFirstOrThrow({ where: { entityId: h.handoverId, action: "HANDOVER_ACCEPTED" } });
    const details = audit.details as { acceptanceMode?: string; independentVerification?: boolean; retainedDrawerCash?: number };
    assert.equal(details.acceptanceMode, "DIRECT_ACKNOWLEDGEMENT");
    assert.equal(details.independentVerification, false);
    assert.equal(details.retainedDrawerCash, 500);

    // Pending recipient confirmation did not block the shift and is still visible, separate from the opening.
    const delivery = await db.cashDeliveryDeclaration.findFirstOrThrow({ where: { shiftId: h.shiftId } });
    assert.equal(delivery.status, "DECLARED");
    const after = await summaryOf(incoming.email, h.handoverId);
    assert.equal(after.body.acknowledgement?.mode, "DIRECT_ACKNOWLEDGEMENT");
    assert.equal(after.body.acknowledgement?.independentVerification, false);
    assert.equal(after.body.cash.deliveries[0].status, "DECLARED");
  });

  test("scenario 2: all cash retained", async () => {
    const h = await outgoingJourney({ actual: 1200, disposition: { deliveries: [], retainedAmount: 1200 } });
    await incomingOpensShift();
    const s = await summaryOf(incoming.email, h.handoverId);
    const r = await acceptDirect(incoming.email, h.handoverId, s.body.reviewVersion);
    assert.equal(r.status, 200, r.text);
    const opened = await db.shift.findFirstOrThrow({ where: { cashierId: incoming.id, branchId: fx.branchId } });
    assert.equal(Number(opened.openingCashAmount), 1200);
    assert.equal(await db.cashDeliveryDeclaration.count({ where: { shiftId: h.shiftId } }), 0);
  });

  test("scenario 3: all cash delivered to the manager; the opening drawer is explicitly zero", async () => {
    const h = await outgoingJourney({ actual: 800, disposition: { deliveries: [{ destination: "MANAGER", recipientId: fx.manager.id, amount: 800 }], retainedAmount: 0 } });
    await incomingOpensShift();
    const s = await summaryOf(incoming.email, h.handoverId);
    assert.equal(s.body.cash.retained, 0);
    const r = await acceptDirect(incoming.email, h.handoverId, s.body.reviewVersion);
    assert.equal(r.status, 200, r.text);
    const opened = await db.shift.findFirstOrThrow({ where: { cashierId: incoming.id, branchId: fx.branchId } });
    assert.equal(Number(opened.openingCashAmount), 0);
    assert.equal(Number(opened.expectedCashAmount), 0);
    assert.equal((await db.cashDeliveryDeclaration.findFirstOrThrow({ where: { shiftId: h.shiftId } })).status, "DECLARED");
  });

  test("scenario 4: zero cash — electronic totals are not cash allocations", async () => {
    const h = await outgoingJourney({ actual: 0, disposition: null, finish: false });
    const view = await as<{ shift: { electronic: { card: number; wallet: number }; countedCash: number } }>(fx.cashier.email, `/api/shifts/${h.shiftId}/cash-disposition`);
    assert.equal(view.status, 200, view.text);
    assert.equal(view.body.shift.countedCash, 0);
    assert.ok("electronic" in view.body.shift, "card / wallet (InstaPay) are reported as payment reconciliation, beside the allocation");
    // A cash delivery cannot be backed by electronic money.
    const tooMuch = await postDisposition(fx.cashier.email, h.shiftId, { deliveries: [{ destination: "OWNER", recipientId: fx.owner.id, amount: 1 }], retainedAmount: 0 });
    assert.equal(tooMuch.status, 400);
    const ok = await postDisposition(fx.cashier.email, h.shiftId, { deliveries: [], retainedAmount: 0 });
    assert.equal(ok.status, 201, ok.text);
    assert.equal(ok.body.disposition!.deliveredAmount, 0);
  });

  test("the incoming employee cannot accept before a disposition exists, or before the outgoing side submitted", async () => {
    const h = await outgoingJourney({ actual: 500, disposition: null });
    await incomingOpensShift();
    const s = await summaryOf(incoming.email, h.handoverId);
    assert.equal(s.body.can.acknowledge, false);
    assert.ok(s.body.blockers.some((b) => b.includes("مصير النقدية")), JSON.stringify(s.body.blockers));
    const r = await acceptDirect(incoming.email, h.handoverId, s.body.reviewVersion);
    assert.equal(r.status, 409, r.text);
    assert.equal((await db.handoverSession.findUniqueOrThrow({ where: { id: h.handoverId } })).status, "OUTGOING_SUBMITTED");
    const draft = await outgoingJourney({ actual: 500, disposition: { deliveries: [], retainedAmount: 500 }, finish: false });
    const early = await summaryOf(incoming.email, draft.handoverId);
    assert.equal(early.body.stock.disclosed, false, "a handover still being counted discloses nothing");
    assert.equal(early.body.can.acknowledge, false);
  });
});

// ═══════════════════════ transactional safety ═══════════════════════

describe("replay, races and stale reviews", () => {
  test("lost-response retry with the same key replays; a different key is refused as a second acceptance", async () => {
    const h = await outgoingJourney({ actual: 600, disposition: { deliveries: [], retainedAmount: 600 } });
    await incomingOpensShift();
    const s = await summaryOf(incoming.email, h.handoverId);
    const k = key("lost");
    const first = await acceptDirect(incoming.email, h.handoverId, s.body.reviewVersion, k);
    assert.equal(first.status, 200, first.text);
    const retry = await acceptDirect(incoming.email, h.handoverId, s.body.reviewVersion, k);
    assert.equal(retry.status, 200, retry.text);
    // The idempotent route replays the exact stored response of the first attempt.
    assert.equal(retry.headers.get("Idempotency-Replayed"), "true");
    assert.deepEqual(retry.body, first.body);
    const second = await acceptDirect(incoming.email, h.handoverId, s.body.reviewVersion, key("other"));
    assert.equal(second.status, 409, second.text);
    assert.equal(await db.auditLog.count({ where: { entityId: h.handoverId, action: "HANDOVER_ACCEPTED" } }), 1);
  });

  test("concurrent double press: exactly one acceptance is written", async () => {
    const h = await outgoingJourney({ actual: 700, disposition: { deliveries: [{ destination: "OWNER", recipientId: fx.owner.id, amount: 200 }], retainedAmount: 500 } });
    await incomingOpensShift();
    const s = await summaryOf(incoming.email, h.handoverId);
    const results = await Promise.all([
      acceptDirect(incoming.email, h.handoverId, s.body.reviewVersion, key("race-a")),
      acceptDirect(incoming.email, h.handoverId, s.body.reviewVersion, key("race-b")),
      acceptDirect(incoming.email, h.handoverId, s.body.reviewVersion, key("race-c")),
    ]);
    assert.equal(results.filter((r) => r.status === 200).length, 1, results.map((r) => `${r.status}:${r.text}`).join(" | "));
    assert.ok(results.every((r) => r.status === 200 || r.status === 409), "losers get a 409, never a 500");
    assert.equal(await db.auditLog.count({ where: { entityId: h.handoverId, action: "HANDOVER_ACCEPTED" } }), 1);
    assert.equal(await db.custodyPeriod.count({ where: { branchId: fx.branchId, scope: "CASH", status: "OPEN" } }), 1);
    assert.equal(Number((await db.shift.findFirstOrThrow({ where: { cashierId: incoming.id, branchId: fx.branchId } })).openingCashAmount), 500);
  });

  test("two incoming employees waiting: ambiguity is refused with who is waiting, and nobody is accepted", async () => {
    const h = await outgoingJourney({ actual: 400, disposition: { deliveries: [], retainedAmount: 400 } });
    await incomingOpensShift(incoming.email);
    await incomingOpensShift(incoming2.email);
    const s = await summaryOf(incoming.email, h.handoverId);
    assert.equal(s.body.incoming.state, "AMBIGUOUS");
    assert.equal(s.body.can.acknowledge, false);
    const r = await acceptDirect(incoming.email, h.handoverId, s.body.reviewVersion);
    assert.equal(r.status, 409, r.text);
    assert.match(r.body.error ?? r.text, /incoming/);
    assert.equal((await db.handoverSession.findUniqueOrThrow({ where: { id: h.handoverId } })).status, "OUTGOING_SUBMITTED");
  });

  test("stale review: a handover that changed after it was reviewed requires a refresh", async () => {
    const h = await outgoingJourney({ actual: 900, disposition: { deliveries: [], retainedAmount: 900 } });
    await incomingOpensShift();
    const s = await summaryOf(incoming.email, h.handoverId);
    // A carried order appears after the incoming employee looked.
    const last = await db.order.aggregate({ where: { branchId: fx.branchId }, _max: { orderNumber: true } });
    const order = await db.order.create({
      data: { cafeId: fx.cafeId, branchId: fx.branchId, orderNumber: (last._max.orderNumber ?? 0) + 1, type: "DINE_IN", status: "CONFIRMED", source: "CASHIER_POS", customerName: fx.marker, subtotal: 20, total: 20, remainingAmount: 20, paymentStatus: "UNPAID", createdById: fx.cashier.id },
    });
    await db.handoverCarriedOrder.create({ data: { cafeId: fx.cafeId, branchId: fx.branchId, shiftId: h.shiftId, handoverId: h.handoverId, orderId: order.id, orderNumber: order.orderNumber, statusAtHandover: "CONFIRMED", paymentStatusAtHandover: "UNPAID", remainingAtHandover: 20, stockDeductedAtHandover: false } });
    const stale = await acceptDirect(incoming.email, h.handoverId, s.body.reviewVersion);
    assert.equal(stale.status, 409, stale.text);
    assert.match(stale.body.error ?? stale.text, /اتغير/);
    const fresh = await summaryOf(incoming.email, h.handoverId);
    assert.notEqual(fresh.body.reviewVersion, s.body.reviewVersion);
    const ok = await acceptDirect(incoming.email, h.handoverId, fresh.body.reviewVersion);
    assert.equal(ok.status, 200, ok.text);
    const carried = await db.handoverCarriedOrder.count({ where: { handoverId: h.handoverId } });
    assert.equal(carried, 1, "the carried order stays attached to the handover");
    const garbage = await outgoingJourney({ actual: 900, disposition: { deliveries: [], retainedAmount: 900 } });
    await incomingOpensShift();
    const bad = await acceptDirect(incoming.email, garbage.handoverId, "0".repeat(64));
    assert.equal(bad.status, 409, bad.text);
    assert.equal((await db.handoverSession.findUniqueOrThrow({ where: { id: garbage.handoverId } })).status, "OUTGOING_SUBMITTED");
  });

  test("only the employee whose shift is waiting may acknowledge; another café sees nothing", async () => {
    const h = await outgoingJourney({ actual: 300, disposition: { deliveries: [], retainedAmount: 300 } });
    await incomingOpensShift(incoming.email);
    const s = await summaryOf(incoming.email, h.handoverId);
    const intruder = await acceptDirect(incoming2.email, h.handoverId, s.body.reviewVersion);
    assert.equal(intruder.status, 409, "incoming2 has no shift: they must open their own, and it would then be ambiguous");
    const foreign = await summaryOf(other.cashier.email, h.handoverId);
    assert.equal(foreign.status, 404, foreign.text);
    const foreignAccept = await acceptDirect(other.cashier.email, h.handoverId, s.body.reviewVersion);
    assert.ok([403, 404].includes(foreignAccept.status), foreignAccept.text);
    const notAnAccepter = await acceptDirect(fx.waiter.email, h.handoverId, s.body.reviewVersion);
    assert.equal(notAnAccepter.status, 403);
    assert.equal((await db.handoverSession.findUniqueOrThrow({ where: { id: h.handoverId } })).status, "OUTGOING_SUBMITTED");
  });

  test("an audit failure rolls the whole acceptance back", async () => {
    const h = await outgoingJourney({ actual: 350, disposition: { deliveries: [], retainedAmount: 350 } });
    const shift = await incomingOpensShift();
    const s = await summaryOf(incoming.email, h.handoverId);
    // A trigger that rejects the acceptance audit row stands in for a failing audit write.
    await db.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION direct001_fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."action" = 'HANDOVER_ACCEPTED' AND NEW."entityId" = '${h.handoverId}' THEN RAISE EXCEPTION 'audit unavailable'; END IF; RETURN NEW; END $$`);
    await db.$executeRawUnsafe(`CREATE TRIGGER direct001_fail_audit BEFORE INSERT ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION direct001_fail_audit()`);
    try {
      const r = await acceptDirect(incoming.email, h.handoverId, s.body.reviewVersion);
      assert.ok(r.status >= 400, r.text);
    } finally {
      await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS direct001_fail_audit ON "AuditLog"`);
      await db.$executeRawUnsafe(`DROP FUNCTION IF EXISTS direct001_fail_audit()`);
    }
    const handover = await db.handoverSession.findUniqueOrThrow({ where: { id: h.handoverId } });
    assert.equal(handover.status, "OUTGOING_SUBMITTED");
    assert.equal(handover.directAcknowledgedAt, null);
    const gated = await db.shift.findUniqueOrThrow({ where: { id: shift.id } });
    assert.equal(gated.custodyGateReason, "AWAITING_CUSTODY_TRANSFER");
    assert.equal(Number(gated.openingCashAmount), 0, "the opening amount did not move");
    assert.equal((await db.shift.findUniqueOrThrow({ where: { id: h.shiftId } })).status, "AWAITING_HANDOVER");
    // And it still works afterwards.
    const ok = await acceptDirect(incoming.email, h.handoverId, s.body.reviewVersion);
    assert.equal(ok.status, 200, ok.text);
  });
});

// ═════════════════════ recipient confirmation / dispute ═════════════════════

describe("declared delivery and recipient confirmation", () => {
  const confirm = (email: string, id: string, body: { idempotencyKey?: string; onBehalfReason?: string } = {}) =>
    as<{ status?: string; alreadyConfirmed?: boolean; confirmedOnBehalf?: boolean; error?: string }>(email, `/api/cash-deliveries/${id}/confirm`, { method: "POST", body: JSON.stringify({ idempotencyKey: key("confirm"), ...body }) });
  const dispute = (email: string, id: string, body: { note: string; claimedReceivedAmount?: number }) =>
    as<{ status?: string; alreadyDisputed?: boolean; error?: string }>(email, `/api/cash-deliveries/${id}/dispute`, { method: "POST", body: JSON.stringify(body) });
  const resolve = (email: string, id: string, body: { resolutionNote: string; resolvedAmount: number }) =>
    as<{ status?: string; error?: string }>(email, `/api/cash-deliveries/${id}/resolve`, { method: "POST", body: JSON.stringify(body) });

  async function declared(recipient: { id: string }, destination: "OWNER" | "MANAGER" = "OWNER") {
    const h = await outgoingJourney({ actual: 1000, disposition: { deliveries: [{ destination, recipientId: recipient.id, amount: 700 }], retainedAmount: 300 }, finish: false });
    const d = await db.cashDeliveryDeclaration.findFirstOrThrow({ where: { shiftId: h.shiftId } });
    return { ...h, deliveryId: d.id };
  }

  test("the named owner sees it pending, confirms from their own account once; duplicates and replays behave", async () => {
    const h = await declared(fx.owner);
    const list = await as<{ deliveries: { id: string; status: string; mine: boolean }[] }>(fx.owner.email, "/api/cash-deliveries");
    assert.equal(list.status, 200, list.text);
    assert.ok(list.body.deliveries.some((d) => d.id === h.deliveryId && d.status === "DECLARED" && d.mine));
    const k = key("owner-confirm");
    const ok = await confirm(fx.owner.email, h.deliveryId, { idempotencyKey: k });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.body.status, "CONFIRMED");
    const row = await db.cashDeliveryDeclaration.findUniqueOrThrow({ where: { id: h.deliveryId } });
    assert.equal(row.confirmedById, fx.owner.id);
    assert.ok(row.confirmedAt);
    assert.equal(row.confirmedByException, false);
    const replay = await confirm(fx.owner.email, h.deliveryId, { idempotencyKey: k });
    assert.equal(replay.status, 200);
    assert.equal(replay.headers.get("Idempotency-Replayed"), "true", "the same attempt is replayed, not re-run");
    assert.deepEqual(replay.body, ok.body);
    const duplicate = await confirm(fx.owner.email, h.deliveryId, { idempotencyKey: key("second") });
    assert.equal(duplicate.status, 409, duplicate.text);
    assert.equal(await db.auditLog.count({ where: { entityId: h.deliveryId, action: "CASH_DELIVERY_CONFIRMED" } }), 1);
    await assert.rejects(() => db.cashDeliveryDeclaration.update({ where: { id: h.deliveryId }, data: { status: "DECLARED", confirmedById: null, confirmedAt: null } }), "a confirmed delivery cannot be reopened");
  });

  test("the outgoing employee, a colleague and a different manager cannot confirm for the recipient", async () => {
    const h = await declared(fx.manager, "MANAGER");
    for (const who of [fx.cashier, incoming, fx.waiter, fx.storekeeper]) {
      const r = await confirm(who.email, h.deliveryId);
      assert.equal(r.status, 403, `${who.email}: ${r.text}`);
    }
    const foreignTenant = await confirm(other.owner.email, h.deliveryId);
    assert.equal(foreignTenant.status, 404, foreignTenant.text);
    assert.equal((await db.cashDeliveryDeclaration.findUniqueOrThrow({ where: { id: h.deliveryId } })).status, "DECLARED");
    const own = await confirm(fx.manager.email, h.deliveryId);
    assert.equal(own.status, 200, own.text);
  });

  test("an owner may confirm «نيابةً عن المستلم» only with a reason; it stays a distinct exception the recipient can still dispute", async () => {
    const h = await declared(fx.manager, "MANAGER");
    const noReason = await confirm(fx.owner.email, h.deliveryId);
    assert.equal(noReason.status, 400, noReason.text);
    const managerCannotProxy = await confirm(annexManager.email, h.deliveryId, { onBehalfReason: "x" });
    assert.ok([403, 404].includes(managerCannotProxy.status), managerCannotProxy.text);
    const selfWithReason = await confirm(fx.manager.email, h.deliveryId, { onBehalfReason: "x" });
    assert.equal(selfWithReason.status, 400, "a recipient confirming for themselves is not an on-behalf confirmation");
    assert.equal((await db.cashDeliveryDeclaration.findUniqueOrThrow({ where: { id: h.deliveryId } })).status, "DECLARED");

    const ok = await confirm(fx.owner.email, h.deliveryId, { onBehalfReason: "المدير في إجازة وتم الاستلام بحضور المالك" });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.body.confirmedOnBehalf, true);
    const row = await db.cashDeliveryDeclaration.findUniqueOrThrow({ where: { id: h.deliveryId } });
    assert.equal(row.status, "CONFIRMED");
    assert.equal(row.confirmedById, fx.owner.id);
    assert.equal(row.recipientId, fx.manager.id, "the named recipient is unchanged");
    assert.equal(row.confirmedByException, true);
    assert.ok(row.exceptionReason);
    assert.equal(await db.auditLog.count({ where: { entityId: h.deliveryId, action: "CASH_DELIVERY_CONFIRMED_ON_BEHALF" } }), 1);
    assert.equal(await db.auditLog.count({ where: { entityId: h.deliveryId, action: "CASH_DELIVERY_CONFIRMED" } }), 0, "never counted as the recipient's own confirmation");
    await assert.rejects(() => db.cashDeliveryDeclaration.update({ where: { id: h.deliveryId }, data: { confirmedByException: false } }), "the on-behalf fact cannot be rewritten");

    // The recipient still sees it, labelled, and may dispute it while the period is open.
    const list = await as<{ deliveries: { id: string; statusLabel: string; confirmedOnBehalf?: boolean; mine: boolean }[] }>(fx.manager.email, "/api/cash-deliveries");
    const seen = list.body.deliveries.find((d) => d.id === h.deliveryId);
    assert.ok(seen && seen.mine && seen.confirmedOnBehalf, JSON.stringify(list.body));
    assert.equal(seen!.statusLabel, "تأكيد نيابةً عن المستلم");
    const disputed = await dispute(fx.manager.email, h.deliveryId, { note: "ما استلمتش غير 600", claimedReceivedAmount: 600 });
    assert.equal(disputed.status, 200, disputed.text);
    const after = await db.cashDeliveryDeclaration.findUniqueOrThrow({ where: { id: h.deliveryId } });
    assert.equal(after.status, "DISPUTED");
    assert.equal(after.confirmedById, fx.owner.id, "the earlier on-behalf confirmation stays on record");
  });

  test("a recipient's dispute window on an on-behalf confirmation closes with the accounting period", async () => {
    const h = await declared(fx.manager, "MANAGER");
    assert.equal((await confirm(fx.owner.email, h.deliveryId, { onBehalfReason: "حضور المالك" })).status, 200);
    const row = await db.cashDeliveryDeclaration.findUniqueOrThrow({ where: { id: h.deliveryId } });
    const { dateStrInTz } = await import("@/lib/date-range");
    const day = new Date(`${dateStrInTz(row.declaredAt)}T00:00:00.000Z`);
    const entity = await db.accountingEntity.upsert({ where: { cafeId: fx.cafeId }, update: {}, create: { cafeId: fx.cafeId, name: fx.marker, currency: "EGP" } });
    // A closed period is fixture state here; the guard trigger that forbids writing one directly is
    // disabled inside this one transaction only (teardown purges it the same way).
    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`ALTER TABLE "AccountingPeriod" DISABLE TRIGGER "AccountingPeriod_immutable_guard"`);
      await tx.accountingPeriod.create({ data: { cafeId: fx.cafeId, entityId: entity.id, startsOn: day, endsOn: day, status: "CLOSED", closedAt: new Date(), closedById: fx.owner.id } });
      await tx.$executeRawUnsafe(`ALTER TABLE "AccountingPeriod" ENABLE TRIGGER "AccountingPeriod_immutable_guard"`);
    });
    try {
      const late = await dispute(fx.manager.email, h.deliveryId, { note: "متأخر" });
      assert.equal(late.status, 409, late.text);
      assert.equal((await db.cashDeliveryDeclaration.findUniqueOrThrow({ where: { id: h.deliveryId } })).status, "CONFIRMED");
    } finally {
      await db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`ALTER TABLE "AccountingPeriod" DISABLE TRIGGER "AccountingPeriod_immutable_guard"`);
        await tx.accountingPeriod.deleteMany({ where: { cafeId: fx.cafeId } });
        await tx.$executeRawUnsafe(`ALTER TABLE "AccountingPeriod" ENABLE TRIGGER "AccountingPeriod_immutable_guard"`);
      });
    }
  });

  test("dispute: recipient reports, it never rewrites the closed shift or the next opening, and only the owner resolves", async () => {
    const h = await outgoingJourney({ actual: 1000, disposition: { deliveries: [{ destination: "OWNER", recipientId: fx.owner.id, amount: 700 }], retainedAmount: 300 } });
    const delivery = await db.cashDeliveryDeclaration.findFirstOrThrow({ where: { shiftId: h.shiftId } });
    await incomingOpensShift();
    const s = await summaryOf(incoming.email, h.handoverId);
    assert.equal((await acceptDirect(incoming.email, h.handoverId, s.body.reviewVersion)).status, 200);
    const shiftBefore = await db.shift.findUniqueOrThrow({ where: { id: h.shiftId } });
    const incomingBefore = await db.shift.findFirstOrThrow({ where: { cashierId: incoming.id, branchId: fx.branchId } });

    const noNote = await dispute(fx.owner.email, delivery.id, { note: "  " });
    assert.equal(noNote.status, 400);
    const bystander = await dispute(fx.manager.email, delivery.id, { note: "ليس لي" });
    assert.equal(bystander.status, 403);
    const tooMuch = await dispute(fx.owner.email, delivery.id, { note: "المبلغ أقل", claimedReceivedAmount: 800 });
    assert.equal(tooMuch.status, 400, "a claim above the declared amount is refused");
    const d = await dispute(fx.owner.email, delivery.id, { note: "استلمت 650 فقط", claimedReceivedAmount: 650 });
    assert.equal(d.status, 200, d.text);
    assert.equal(d.body.status, "DISPUTED");
    const again = await dispute(fx.owner.email, delivery.id, { note: "استلمت 650 فقط", claimedReceivedAmount: 650 });
    assert.equal(again.body.alreadyDisputed, true);

    const shiftAfter = await db.shift.findUniqueOrThrow({ where: { id: h.shiftId } });
    const incomingAfter = await db.shift.findUniqueOrThrow({ where: { id: incomingBefore.id } });
    assert.deepEqual([shiftAfter.status, Number(shiftAfter.actualCashAmount), Number(shiftAfter.cashDifference)], [shiftBefore.status, Number(shiftBefore.actualCashAmount), Number(shiftBefore.cashDifference)], "the closed shift is not rewritten");
    assert.equal(Number(incomingAfter.openingCashAmount), 300, "the next shift's opening is not silently altered");
    const confirmAfterDispute = await confirm(fx.owner.email, delivery.id);
    assert.equal(confirmAfterDispute.status, 409, "a disputed delivery is settled, not confirmed");

    const notOwner = await resolve(fx.manager.email, delivery.id, { resolutionNote: "x", resolvedAmount: 650 });
    assert.equal(notOwner.status, 403);
    const tooHigh = await resolve(fx.owner.email, delivery.id, { resolutionNote: "x", resolvedAmount: 701 });
    assert.equal(tooHigh.status, 400);
    const ok = await resolve(fx.owner.email, delivery.id, { resolutionNote: "تم التحقق: 650 استُلمت و50 فرق يُتابع", resolvedAmount: 650 });
    assert.equal(ok.status, 200, ok.text);
    const row = await db.cashDeliveryDeclaration.findUniqueOrThrow({ where: { id: delivery.id } });
    assert.equal(row.status, "RESOLVED");
    assert.equal(Number(row.amount), 700, "the declaration itself is preserved");
    assert.equal(Number(row.resolvedAmount), 650);
    assert.equal((await db.shift.findUniqueOrThrow({ where: { id: incomingBefore.id } })).openingCashAmount.toString(), incomingAfter.openingCashAmount.toString());
    for (const action of ["CASH_DELIVERY_DISPUTED", "CASH_DELIVERY_DISPUTE_RESOLVED"]) assert.ok(await db.auditLog.findFirst({ where: { entityId: delivery.id, action } }), action);
  });

  test("concurrent confirmations produce exactly one confirmation", async () => {
    const h = await declared(fx.owner);
    const rs = await Promise.all([1, 2, 3].map(() => confirm(fx.owner.email, h.deliveryId)));
    assert.equal(rs.filter((r) => r.status === 200).length, 1, rs.map((r) => r.text).join(" | "));
    assert.ok(rs.every((r) => [200, 409].includes(r.status)));
    assert.equal(await db.auditLog.count({ where: { entityId: h.deliveryId, action: "CASH_DELIVERY_CONFIRMED" } }), 1);
  });

  test("a deactivated recipient cannot confirm", async () => {
    const h = await declared(fx.manager, "MANAGER");
    await db.user.update({ where: { id: fx.manager.id }, data: { isActive: false } });
    try {
      const r = await confirm(fx.manager.email, h.deliveryId);
      assert.ok([401, 403].includes(r.status), `${r.status} ${r.text}`);
    } finally {
      await db.user.update({ where: { id: fx.manager.id }, data: { isActive: true } });
    }
    assert.equal((await db.cashDeliveryDeclaration.findUniqueOrThrow({ where: { id: h.deliveryId } })).status, "DECLARED");
  });
});

// ═════════════════ other gates, legacy paths, issues ═════════════════

describe("independent gates and unchanged paths", () => {
  test("place/equipment requirement still gates POS after the simplified acceptance", async () => {
    const h = await outgoingJourney({ actual: 250, disposition: { deliveries: [], retainedAmount: 250 } });
    const shift = await incomingOpensShift();
    await db.branchOpeningSettings.create({ data: { branchId: fx.branchId, cafeId: fx.cafeId, placeAcceptanceRequired: true, updatedById: fx.owner.id, updatedAt: new Date(Date.now() - 3600_000) } });
    const s = await summaryOf(incoming.email, h.handoverId);
    assert.equal((await acceptDirect(incoming.email, h.handoverId, s.body.reviewVersion)).status, 200);
    const { branchReadiness } = await import("@/lib/handover-readiness");
    const ready = (await branchReadiness(fx.cafeId, fx.branchId)).find((r) => r.shiftId === shift.id)!;
    assert.equal(ready.requirements.find((r) => r.id === "custody")!.state, "done");
    assert.equal(ready.requirements.find((r) => r.id === "place-receipt")!.state, "pending", "acceptance does not satisfy the place check");
    assert.equal(ready.operational, false, "POS stays off until the independent place gate is satisfied");
    const { assertOpeningReady } = await import("@/lib/opening-readiness");
    await assert.rejects(() => assertOpeningReady(db, { shiftId: shift.id, scope: "OPERATIONS" }));
    await assert.doesNotReject(() => assertOpeningReady(db, { shiftId: shift.id, scope: "CASH" }));
  });

  test("legacy per-line acknowledgement + countedOpeningCash acceptance is unchanged", async () => {
    const h = await outgoingJourney({ actual: 500, disposition: null });
    await incomingOpensShift();
    const lines = await db.stockCountLine.findMany({ where: { sessionId: h.sessionId!, countedQuantity: { not: null } }, select: { id: true } });
    for (const line of lines) {
      const a = await as(incoming.email, `/api/handovers/${h.handoverId}/acknowledge`, { method: "POST", body: JSON.stringify({ stockCountLineId: line.id }) });
      assert.equal(a.status, 200, a.text);
    }
    const r = await as<{ status?: string }>(incoming.email, `/api/handovers/${h.handoverId}/accept`, { method: "POST", body: JSON.stringify({ idempotencyKey: key("legacy"), countedOpeningCash: 480 }) });
    assert.equal(r.status, 200, r.text);
    const handover = await db.handoverSession.findUniqueOrThrow({ where: { id: h.handoverId } });
    assert.equal(handover.directAcknowledgedAt, null, "the legacy path is not labelled a direct acknowledgement");
    assert.ok(handover.cashVerifiedAt, "legacy keeps its independent cash verification");
    assert.equal(Number(handover.countedOpeningCash), 480);
  });

  test("a dispute left by the legacy sheet still blocks a direct acceptance", async () => {
    const h = await outgoingJourney({ actual: 500, disposition: { deliveries: [], retainedAmount: 500 } });
    await incomingOpensShift();
    const line = await db.stockCountLine.findFirstOrThrow({ where: { sessionId: h.sessionId!, countedQuantity: { not: null } } });
    const reason = await db.reasonCode.create({ data: { cafeId: fx.cafeId, domain: "HANDOVER", code: `${MARKER}-D${keySeq}`, label: "اعتراض" } });
    const ack = await as(incoming.email, `/api/handovers/${h.handoverId}/acknowledge`, { method: "POST", body: JSON.stringify({ stockCountLineId: line.id, incomingCountedQuantity: 7, disputeReasonCodeId: reason.id }) });
    assert.equal(ack.status, 200, ack.text);
    const s = await summaryOf(incoming.email, h.handoverId);
    const r = await acceptDirect(incoming.email, h.handoverId, s.body.reviewVersion);
    assert.equal(r.status, 409, r.text);
  });

  test("a branch-custody (overnight) handover cannot be accepted directly", async () => {
    await resetBranch(fx.branchId);
    const shift = await openOperationalShift(fx.cashier.id, 100);
    const { closeShiftWithSettlement } = await cashCloseLib();
    const closed = await closeShiftWithSettlement({ shiftId: shift.id, actualCash: 100, actorId: fx.cashier.id, closedByManager: false, handoverTarget: "BRANCH_CUSTODY", grants: GRANTS_FULL });
    assert.ok(closed.handoverId);
    const dispo = await postDisposition(fx.cashier.email, shift.id, { deliveries: [], retainedAmount: 100 });
    assert.equal(dispo.status, 409, "branch custody keeps the night storage declaration instead");
    await incomingOpensShift();
    const direct = await summaryOf(incoming.email, closed.handoverId!);
    assert.equal(direct.body.can.acknowledge, false);
    const r = await acceptDirect(incoming.email, closed.handoverId!, direct.body.reviewVersion);
    assert.equal(r.status, 409, r.text);
  });

  test("a historical handover (no direct acknowledgement) is summarised without inventing one", async () => {
    const h = await outgoingJourney({ actual: 100, disposition: null });
    const s = await summaryOf(fx.manager.email, h.handoverId);
    assert.equal(s.status, 200, s.text);
    assert.equal(s.body.acknowledgement, null);
    assert.equal(s.body.cash.retained, null);
    assert.deepEqual(s.body.cash.deliveries, []);
  });
});

describe("«الإبلاغ عن اختلاف»", () => {
  const report = (email: string, handoverId: string, body: Record<string, unknown>) =>
    as<{ id?: string; alreadyReported?: boolean; error?: string }>(email, `/api/handovers/${handoverId}/issues`, { method: "POST", body: JSON.stringify({ idempotencyKey: key("issue"), ...body }) });

  test("an issue is recorded before and after acceptance, never edits history, and is replay-safe", async () => {
    const h = await outgoingJourney({ actual: 500, disposition: { deliveries: [], retainedAmount: 500 } });
    await incomingOpensShift();
    const s = await summaryOf(incoming.email, h.handoverId);
    const k = key("issue-fixed");
    const pre = await report(incoming.email, h.handoverId, { kind: "STOCK_ITEM", inventoryItemId: items[0].id, description: "الكمية أقل من المعلن", idempotencyKey: k });
    assert.equal(pre.status, 201, pre.text);
    const replay = await report(incoming.email, h.handoverId, { kind: "STOCK_ITEM", inventoryItemId: items[0].id, description: "الكمية أقل من المعلن", idempotencyKey: k });
    assert.equal(replay.status, 201, "the stored status of the first attempt");
    assert.equal(replay.headers.get("Idempotency-Replayed"), "true");
    assert.deepEqual(replay.body, pre.body);
    assert.equal((await acceptDirect(incoming.email, h.handoverId, s.body.reviewVersion)).status, 200, "reporting does not by itself block the separate acceptance");
    const post = await report(incoming.email, h.handoverId, { kind: "CASH", amount: 20, description: "ناقص 20 جنيه في الدرج" });
    assert.equal(post.status, 201, post.text);
    const rows = await db.handoverIssue.findMany({ where: { handoverId: h.handoverId }, orderBy: { reportedAt: "asc" } });
    assert.deepEqual(rows.map((r) => r.afterAcceptance), [false, true]);
    assert.equal(Number((await db.shift.findFirstOrThrow({ where: { cashierId: incoming.id, branchId: fx.branchId } })).openingCashAmount), 500, "the opening balance is not altered by a report");
    assert.equal((await report(incoming.email, h.handoverId, { kind: "CASH", description: "no amount" })).status, 400);
    assert.equal((await report(incoming.email, h.handoverId, { kind: "STOCK_ITEM", description: "no item" })).status, 400);
    assert.equal((await report(other.cashier.email, h.handoverId, { kind: "OTHER", description: "foreign" })).status, 404);
    const denied = await as(incoming.email, `/api/handover-issues/${rows[0].id}/resolve`, { method: "POST", body: JSON.stringify({ note: "x" }) });
    assert.equal(denied.status, 403);
    const resolved = await as(fx.manager.email, `/api/handover-issues/${rows[0].id}/resolve`, { method: "POST", body: JSON.stringify({ note: "تم العد من جديد" }) });
    assert.equal(resolved.status, 200, resolved.text);
    await assert.rejects(() => db.handoverIssue.update({ where: { id: rows[0].id }, data: { description: "rewritten" } }));
  });
});

describe("cross-business and branch isolation", () => {
  test("recipients are listed from the same café and branch only", async () => {
    const h = await outgoingJourney({ disposition: null, finish: false });
    const r = await as<{ recipients: { id: string; destination: string }[] }>(fx.cashier.email, `/api/shifts/${h.shiftId}/cash-disposition`);
    assert.equal(r.status, 200, r.text);
    const ids = r.body.recipients.map((x) => x.id);
    assert.ok(ids.includes(fx.owner.id) && ids.includes(fx.manager.id));
    assert.ok(!ids.includes(annexManager.id) && !ids.includes(other.owner.id) && !ids.includes(fx.cashier.id));
    const foreign = await as(other.cashier.email, `/api/shifts/${h.shiftId}/cash-disposition`);
    assert.equal(foreign.status, 404);
  });

  test("a delivery list is private to the recipient (and the owner)", async () => {
    await outgoingJourney({ actual: 100, disposition: { deliveries: [{ destination: "MANAGER", recipientId: fx.manager.id, amount: 100 }], retainedAmount: 0 }, finish: false });
    const mine = await as<{ deliveries: unknown[] }>(fx.manager.email, "/api/cash-deliveries");
    const bystander = await as<{ deliveries: unknown[] }>(incoming.email, "/api/cash-deliveries");
    const foreign = await as<{ deliveries: unknown[] }>(other.owner.email, "/api/cash-deliveries");
    assert.equal(mine.body.deliveries.length, 1);
    assert.equal(bystander.body.deliveries.length, 0);
    assert.equal(foreign.body.deliveries.length, 0);
  });
});

// ═════════ finish_outgoing disposition gate, no-handover close & reports ═════════

describe("directHandover finish_outgoing prerequisite, no-handover close and reports", () => {
  test("finish_outgoing requires a recorded disposition when opted into directHandover, then succeeds", async () => {
    await resetBranch(fx.branchId);
    const shift = await openOperationalShift(fx.cashier.id, 100);
    const closed = await as<{ handover: { handoverId: string } }>(fx.cashier.email, `/api/shifts/${shift.id}/close`, {
      method: "POST",
      body: JSON.stringify({ actualCashAmount: 1500, handoverTarget: "SHIFT_TO_SHIFT", directHandover: true }),
    });
    assert.equal(closed.status, 200, closed.text);
    const hid = closed.body.handover.handoverId;

    const started = await post<{ countSession: { id: string } }>(fx.cashier.email, { action: "start_count", handoverId: hid });
    const sid = started.body.countSession.id;
    const lines = await db.stockCountLine.findMany({ where: { sessionId: sid }, select: { id: true } });
    for (const line of lines) {
      await as(fx.cashier.email, `/api/stock-counts/${sid}/lines/${line.id}`, { method: "PATCH", body: JSON.stringify({ countedQuantity: 10 }) });
    }

    // Attempt finish_outgoing BEFORE recording cash disposition: must be refused with 409
    const blocked = await post<{ error?: string }>(fx.cashier.email, { action: "finish_outgoing", handoverId: hid });
    assert.equal(blocked.status, 409, blocked.text);
    assert.match(blocked.body.error ?? blocked.text, /مصير النقدية/);
    assert.equal((await db.handoverSession.findUniqueOrThrow({ where: { id: hid } })).status, "DRAFT");

    // Record cash disposition, then finish_outgoing succeeds
    const disp = await postDisposition(fx.cashier.email, shift.id, {
      deliveries: [{ destination: "OWNER", recipientId: fx.owner.id, amount: 1100 }],
      retainedAmount: 400,
    });
    assert.equal(disp.status, 201, disp.text);

    const finished = await post<{ status?: string }>(fx.cashier.email, { action: "finish_outgoing", handoverId: hid });
    assert.equal(finished.status, 200, finished.text);
    assert.equal(finished.body.status, "OUTGOING_SUBMITTED");
  });

  test("no-handover shift close records disposition and carries retained drawer custody into the next shift", async () => {
    await resetBranch(fx.branchId);
    // Disable handover on the café so closing a shift finishes as CLOSED with handoverId = null
    await db.cafeSettings.update({ where: { cafeId: fx.cafeId }, data: { stockCountPolicy: "NO_SHIFT_COUNT" } });
    const shift1 = await openOperationalShift(fx.cashier.id, 200);
    const closed1 = await as<{ handover: { required: boolean; handoverId: string | null } }>(fx.cashier.email, `/api/shifts/${shift1.id}/close`, {
      method: "POST",
      body: JSON.stringify({ actualCashAmount: 1800 }),
    });
    assert.equal(closed1.status, 200, closed1.text);
    assert.equal(closed1.body.handover.required, false);
    assert.equal(closed1.body.handover.handoverId, null);

    const disp = await postDisposition(fx.cashier.email, shift1.id, {
      deliveries: [{ destination: "MANAGER", recipientId: fx.manager.id, amount: 1300 }],
      retainedAmount: 500,
    });
    assert.equal(disp.status, 201, disp.text);

    const beforeNext = await as<{ disposition: { retainedCustody: { status: string; amount: number } } }>(fx.cashier.email, `/api/shifts/${shift1.id}/cash-disposition`);
    assert.equal(beforeNext.status, 200, beforeNext.text);
    assert.equal(beforeNext.body.disposition.retainedCustody.status, "IN_DRAWER_FOR_NEXT_SHIFT");
    assert.equal(beforeNext.body.disposition.retainedCustody.amount, 500);

    // Next shift opens via POST /api/shifts with openingCashAmount: 0 -> automatically carries forward 500 from drawer
    const nextOpen = await as<{ shift: { id: string; shiftNumber: number } }>(
      incoming.email,
      "/api/shifts",
      { method: "POST", body: JSON.stringify({ openingCashAmount: 0 }) },
    );
    assert.ok(nextOpen.status === 200 || nextOpen.status === 201, nextOpen.text);
    const openedShift = await db.shift.findUniqueOrThrow({ where: { id: nextOpen.body.shift.id } });
    assert.equal(Number(openedShift.openingCashAmount), 500, "retained drawer cash carries forward to the next shift");
    assert.equal(Number(openedShift.expectedCashAmount), 500);
    const openedCustodyLink = await db.shiftCustody.findUniqueOrThrow({
      where: { shiftId_scope: { shiftId: openedShift.id, scope: "CASH" } },
      include: { custodyPeriod: true },
    });
    assert.equal(Number(openedCustodyLink.custodyPeriod.openingCashAmount), 500);

    const afterNext = await as<{ disposition: { retainedCustody: { status: string; incomingShiftId: string | null } } }>(fx.cashier.email, `/api/shifts/${shift1.id}/cash-disposition`);
    assert.equal(afterNext.body.disposition.retainedCustody.status, "HANDED_TO_SHIFT");
    assert.equal(afterNext.body.disposition.retainedCustody.incomingShiftId, nextOpen.body.shift.id);
    // Restore default stockCountPolicy
    await configureBranch();
  });

  test("screen, handover report (HTML & XLSX) and shift report agree on disposition, deliveries, acknowledgements and issues", async () => {
    const h = await outgoingJourney({
      actual: 3000,
      disposition: {
        deliveries: [
          { destination: "OWNER", recipientId: fx.owner.id, amount: 2000, reference: "تسليم-مالك" },
          { destination: "MANAGER", recipientId: fx.manager.id, amount: 500, reference: "تسليم-مدير" },
        ],
        retainedAmount: 500,
      },
    });
    const deliveries = await db.cashDeliveryDeclaration.findMany({ where: { shiftId: h.shiftId }, orderBy: { declaredAt: "asc" } });
    const ownerDel = deliveries.find((d) => d.destination === "OWNER")!;
    // Confirm owner delivery
    await as(fx.owner.email, `/api/cash-deliveries/${ownerDel.id}/confirm`, { method: "POST", body: JSON.stringify({ idempotencyKey: key("rep-conf") }) });

    // Report an issue before acceptance
    await as(incoming.email, `/api/handovers/${h.handoverId}/issues`, {
      method: "POST",
      body: JSON.stringify({ kind: "STOCK_ITEM", inventoryItemId: items[0].id, description: "كيس مفتوح", idempotencyKey: key("rep-iss") }),
    });

    // Accept directly
    await incomingOpensShift();
    const s = await summaryOf(incoming.email, h.handoverId);
    const acc = await acceptDirect(incoming.email, h.handoverId, s.body.reviewVersion);
    assert.equal(acc.status, 200, acc.text);

    // 1. Handover detail payload (screen)
    const detail = await as<{ handover: { acknowledged: boolean; overview: { cashDisposition: { retainedAmount: number; deliveredAmount: number; deliveries: { status: string }[] }; issues: { description: string }[]; signatures: { directAcknowledgedAt: string | null } } } }>(
      fx.owner.email,
      `/api/handovers/${h.handoverId}`,
    );
    assert.equal(detail.status, 200, detail.text);
    assert.equal(detail.body.handover.acknowledged, true, "direct acknowledgement discloses outgoing stock lines");
    assert.equal(detail.body.handover.overview.cashDisposition.retainedAmount, 500);
    assert.equal(detail.body.handover.overview.cashDisposition.deliveredAmount, 2500);
    assert.ok(detail.body.handover.overview.signatures.directAcknowledgedAt);
    assert.equal(detail.body.handover.overview.issues.length, 1);

    // 2. Handover print HTML report
    const htmlRes = await as(fx.owner.email, `/api/handovers/${h.handoverId}/report?format=html`);
    assert.equal(htmlRes.status, 200);
    assert.match(htmlRes.text, /توزيع النقدية والتسليمات/);
    assert.match(htmlRes.text, /استلمها المالك/);
    assert.match(htmlRes.text, /تم تأكيد الاستلام/);
    assert.match(htmlRes.text, /تسليم مُعلن — بانتظار تأكيد المستلم/);
    assert.match(htmlRes.text, /تُترك في الدرج كعهدة/);
    assert.match(htmlRes.text, /إقرار استلام مباشر/);
    assert.match(htmlRes.text, /كيس مفتوح/);

    // 3. Handover XLSX workbook
    const { handoverDetailPayload } = await import("@/lib/handover-detail-payload");
    const { buildHandoverReport, reportWorkbook } = await import("@/lib/handover-report");
    const XLSX = await import("xlsx");
    const payload = await handoverDetailPayload(
      { id: fx.owner.id, email: fx.owner.email, name: "Owner", role: "CAFE_OWNER", cafeId: fx.cafeId, branchId: null },
      h.handoverId,
      fx.cafeId,
    );
    const repObj = buildHandoverReport(payload, {
      businessName: "Test Cafe",
      currency: "EGP",
      timezone: "Africa/Cairo",
      generatedAt: new Date(),
      viewerName: "Owner",
    });
    const wb = XLSX.read(reportWorkbook(repObj), { type: "buffer" });
    assert.deepEqual(wb.SheetNames.slice(0, 2), ["الملخص", "المال والمدفوعات"]);
    assert.ok(wb.SheetNames.includes("توزيع النقدية والتسليمات"));
    assert.ok(wb.SheetNames.includes("الاختلافات والملاحظات المسجل"));

    // 4. Shift report API
    const shiftRep = await as<{ report: { cashDisposition: { retainedAmount: number; deliveredAmount: number }; handover: { directAcknowledgedAt: string | null; issues: unknown[] } } }>(
      fx.owner.email,
      `/api/shifts/${h.shiftId}/report`,
    );
    assert.equal(shiftRep.status, 200, shiftRep.text);
    assert.equal(shiftRep.body.report.cashDisposition.retainedAmount, 500);
    assert.equal(shiftRep.body.report.cashDisposition.deliveredAmount, 2500);
    assert.ok(shiftRep.body.report.handover.directAcknowledgedAt);
    assert.equal(shiftRep.body.report.handover.issues.length, 1);
  });
});

// ═════════════════════ hardening (continuation, 2026-11-05) ═════════════════════

describe("hardening: one partition, authoritative figures, period gate, idempotency, masking, parity", () => {
  const confirmAs = (email: string, id: string, body: Record<string, unknown> = {}, k = key("hc")) =>
    rawAs<{ status?: string; confirmedOnBehalf?: boolean; error?: string }>(email, `/api/cash-deliveries/${id}/confirm`, { method: "POST", body: JSON.stringify(body), headers: { "Idempotency-Key": k } });

  test("one drawer partition per shift: the database refuses a night-storage row beside a disposition, and the reverse", async () => {
    const h = await outgoingJourney({ actual: 900, disposition: { deliveries: [], retainedAmount: 900 }, finish: false });
    await assert.rejects(
      () => db.cashStorage.create({ data: { cafeId: fx.cafeId, branchId: fx.branchId, outgoingShiftId: h.shiftId, handoverId: h.handoverId, closingAmount: 900, leftInDrawer: 900, toTreasury: 0, drawerLabel: "x", declaredById: fx.cashier.id } }),
      /direct-handover cash disposition/,
    );
    const { recordNightCash } = await import("@/lib/overnight-cash");
    // The service refuses before the database has to (its own message), on the same shift.
    await assert.rejects(() => db.$transaction((tx) => recordNightCash(tx, { cafeId: fx.cafeId, branchId: fx.branchId, shiftId: h.shiftId, handoverId: h.handoverId, actorId: fx.cashier.id, actualCash: 900, disposition: { leftInDrawer: 900, toTreasury: 0 } })));
    assert.equal(await db.cashStorage.count({ where: { outgoingShiftId: h.shiftId } }), 0);
  });

  test("the disposition snapshots the persisted close: counted = actualCashAmount, expected = the close's expectedCashAmount", async () => {
    const h = await outgoingJourney({ actual: 1234.56, disposition: { deliveries: [{ destination: "OWNER", recipientId: fx.owner.id, amount: 1000 }], retainedAmount: 234.56 }, finish: false });
    const [shift, row] = await Promise.all([
      db.shift.findUniqueOrThrow({ where: { id: h.shiftId } }),
      db.shiftCashDisposition.findUniqueOrThrow({ where: { shiftId: h.shiftId } }),
    ]);
    assert.equal(row.countedCash.toString(), shift.actualCashAmount!.toString());
    assert.equal(row.expectedCash.toString(), shift.expectedCashAmount.toString());
    assert.equal(row.cashDifference.toString(), shift.cashDifference!.toString());
  });

  test("period close is blocked by unconfirmed or disputed deliveries, warned by on-behalf ones — and never blocks the shifts", async () => {
    const h = await outgoingJourney({ actual: 1000, disposition: { deliveries: [{ destination: "OWNER", recipientId: fx.owner.id, amount: 600 }, { destination: "MANAGER", recipientId: fx.manager.id, amount: 300 }], retainedAmount: 100 } });
    // The next shift opens on the retained amount while both deliveries are pending.
    await incomingOpensShift();
    const s = await summaryOf(incoming.email, h.handoverId);
    assert.equal((await acceptDirect(incoming.email, h.handoverId, s.body.reviewVersion)).status, 200);
    const { dateStrInTz } = await import("@/lib/date-range");
    const today = new Date(`${dateStrInTz(new Date())}T00:00:00.000Z`);
    const entity = await db.accountingEntity.upsert({ where: { cafeId: fx.cafeId }, update: {}, create: { cafeId: fx.cafeId, name: fx.marker, currency: "EGP" } });
    const period = await db.accountingPeriod.create({ data: { cafeId: fx.cafeId, entityId: entity.id, startsOn: today, endsOn: today } });
    const { closeChecklist } = await import("@/lib/accounting/close-checklist");
    const item = async (k: string) => (await closeChecklist({ cafeId: fx.cafeId, periodId: period.id })).items.find((i) => i.key === k)!;
    assert.equal((await item("cash-deliveries")).status, "blocking");
    const [ownerDel, managerDel] = await Promise.all([
      db.cashDeliveryDeclaration.findFirstOrThrow({ where: { shiftId: h.shiftId, recipientId: fx.owner.id } }),
      db.cashDeliveryDeclaration.findFirstOrThrow({ where: { shiftId: h.shiftId, recipientId: fx.manager.id } }),
    ]);
    assert.equal((await confirmAs(fx.owner.email, ownerDel.id)).status, 200);
    assert.equal((await item("cash-deliveries")).status, "blocking", "the manager's delivery is still pending");
    assert.equal((await confirmAs(fx.owner.email, managerDel.id, { onBehalfReason: "حضور المالك" })).status, 200);
    assert.equal((await item("cash-deliveries")).status, "ok");
    assert.equal((await item("cash-deliveries-on-behalf")).status, "warning");
    // The incoming shift stayed operational throughout.
    const opened = await db.shift.findFirstOrThrow({ where: { cashierId: incoming.id, branchId: fx.branchId } });
    assert.equal(opened.custodyGateReason, null);
  });

  test("withIdempotency: same key + same body replays the stored response; same key + different body is 409; no key is 400", async () => {
    const h = await outgoingJourney({ actual: 800, disposition: null, finish: false });
    const k = key("hdr");
    const path = `/api/shifts/${h.shiftId}/cash-disposition`;
    const body = JSON.stringify({ deliveries: [{ destination: "OWNER", recipientId: fx.owner.id, amount: 500 }], retainedAmount: 300 });
    const first = await rawAs<{ disposition: { id: string } }>(fx.cashier.email, path, { method: "POST", body, headers: { "Idempotency-Key": k } });
    assert.equal(first.status, 201, first.text);
    const replay = await rawAs<{ disposition: { id: string } }>(fx.cashier.email, path, { method: "POST", body, headers: { "Idempotency-Key": k } });
    assert.equal(replay.status, 201, "the stored status is replayed");
    assert.equal(replay.headers.get("Idempotency-Replayed"), "true");
    assert.equal(replay.body.disposition.id, first.body.disposition.id);
    const other = await rawAs(fx.cashier.email, path, { method: "POST", body: JSON.stringify({ deliveries: [], retainedAmount: 800 }), headers: { "Idempotency-Key": k } });
    assert.equal(other.status, 409, other.text);
    const none = await rawAs(fx.cashier.email, path, { method: "POST", body });
    assert.equal(none.status, 400, none.text);
    const mismatch = await rawAs(fx.cashier.email, path, { method: "POST", body: JSON.stringify({ ...JSON.parse(body), idempotencyKey: "different-key-1" }), headers: { "Idempotency-Key": key("hdr2") } });
    assert.equal(mismatch.status, 400, mismatch.text);
    assert.equal(await db.shiftCashDisposition.count({ where: { shiftId: h.shiftId } }), 1);
    assert.equal(await db.cashDeliveryDeclaration.count({ where: { shiftId: h.shiftId } }), 1);
  });

  test("lost response: concurrent retries of one attempt write exactly one row on every new mutating route", async () => {
    const h = await outgoingJourney({ actual: 700, disposition: { deliveries: [{ destination: "OWNER", recipientId: fx.owner.id, amount: 400 }], retainedAmount: 300 } });
    const del = await db.cashDeliveryDeclaration.findFirstOrThrow({ where: { shiftId: h.shiftId } });
    const k = key("lost-conf");
    const conf = await Promise.all([confirmAs(fx.owner.email, del.id, {}, k), confirmAs(fx.owner.email, del.id, {}, k)]);
    assert.ok(conf.some((r) => r.status === 200), conf.map((r) => r.text).join(" | "));
    assert.ok(conf.every((r) => [200, 409].includes(r.status)));
    const again = await confirmAs(fx.owner.email, del.id, {}, k);
    assert.equal(again.status, 200, "after the race, the same key replays");
    assert.equal(await db.auditLog.count({ where: { entityId: del.id, action: "CASH_DELIVERY_CONFIRMED" } }), 1);
    const ik = key("lost-issue");
    const issueBody = JSON.stringify({ kind: "OTHER", description: "ملاحظة واحدة" });
    const issues = await Promise.all([1, 2].map(() => rawAs(incoming.email, `/api/handovers/${h.handoverId}/issues`, { method: "POST", body: issueBody, headers: { "Idempotency-Key": ik } })));
    assert.ok(issues.some((r) => r.status === 201), issues.map((r) => r.text).join(" | "));
    assert.equal(await db.handoverIssue.count({ where: { handoverId: h.handoverId } }), 1);
  });

  test("masking: no counted / expected / difference figure reaches an incoming cashier in JSON or the page payload", async () => {
    // Distinctive figures so a leak is unambiguous wherever it appears.
    const h = await outgoingJourney({ actual: 3137.25, disposition: { deliveries: [{ destination: "OWNER", recipientId: fx.owner.id, amount: 2500 }], retainedAmount: 637.25 } });
    const leaks = ["3137.25", "3,137.25", "3037.25", "3,037.25", "٣١٣٧"];
    const scan = (label: string, text: string) => { for (const l of leaks) assert.ok(!text.includes(l), `${label} leaks ${l}`); };
    const summary = await summaryOf(incoming.email, h.handoverId);
    assert.equal(summary.status, 200, summary.text);
    scan("direct summary", summary.text);
    assert.equal(summary.body.cash.counted, null);
    assert.equal(summary.body.cash.expected, null);
    assert.equal(summary.body.cash.difference, null, "hidden is null (rendered «غير متاح»), never 0");
    const detail = await rawAs(incoming.email, `/api/handovers/${h.handoverId}`);
    scan("handover detail", detail.text);
    const list = await rawAs(incoming.email, "/api/cash-deliveries");
    scan("deliveries list", list.text);
    const issues = await rawAs(incoming.email, `/api/handovers/${h.handoverId}/issues`);
    scan("issues", issues.text);
    const page = await rawAs(incoming.email, `/handovers?id=${h.handoverId}`, { headers: { RSC: "1" } });
    scan("handovers RSC payload", page.text);
    // The owner, who has report access, does see the figures — the scan is not vacuous.
    const ownerView = await summaryOf(fx.owner.email, h.handoverId);
    assert.equal(ownerView.body.cash.counted, 3137.25);
  });

  test("totals parity: screen (detail API) = HTML report = XLSX for counted, delivered, retained and each delivery", async () => {
    const h = await outgoingJourney({ actual: 3000, disposition: { deliveries: [{ destination: "OWNER", recipientId: fx.owner.id, amount: 2000 }, { destination: "MANAGER", recipientId: fx.manager.id, amount: 500 }], retainedAmount: 500 } });
    const ownerDel = await db.cashDeliveryDeclaration.findFirstOrThrow({ where: { shiftId: h.shiftId, recipientId: fx.owner.id } });
    assert.equal((await confirmAs(fx.owner.email, ownerDel.id)).status, 200);
    type Detail = { handover: { overview: { cashDisposition: { deliveredAmount: number; retainedAmount: number; countedCash: number | null; deliveries: { amount: number; statusLabel: string }[] } } } };
    const screen = await rawAs<Detail>(fx.owner.email, `/api/handovers/${h.handoverId}`);
    assert.equal(screen.status, 200, screen.text);
    const cd = screen.body.handover.overview.cashDisposition;
    assert.equal(cd.countedCash, 3000);
    assert.equal(cd.deliveredAmount + cd.retainedAmount, cd.countedCash);
    assert.deepEqual(cd.deliveries.map((d) => d.amount).sort((a, b) => a - b), [500, 2000]);

    const { handoverDetailPayload } = await import("@/lib/handover-detail-payload");
    const { buildHandoverReport, reportWorkbook, reportHtml } = await import("@/lib/handover-report");
    const payload = await handoverDetailPayload({ id: fx.owner.id, email: fx.owner.email, name: "Owner", role: "CAFE_OWNER", cafeId: fx.cafeId, branchId: null }, h.handoverId, fx.cafeId);
    const report = buildHandoverReport(payload, { businessName: "x", currency: "EGP", timezone: "Africa/Cairo", generatedAt: new Date(), viewerName: "Owner" });
    const table = report.tables.find((t) => t.key === "cash_disposition")!;
    const amounts = table.rows.map((r) => r[2]).filter((v): v is number => typeof v === "number");
    assert.equal(amounts.reduce((a, b) => a + b, 0), 3000, "deliveries + retained in the report = counted");
    assert.deepEqual([...amounts].sort((a, b) => a - b), [500, 500, 2000]);
    const html = reportHtml(report);
    assert.match(html, /<thead>/);
    assert.match(html, /size:A4 landscape/);
    // XLSX: the same numbers, read back from the generated workbook XML (no spreadsheet library needed).
    const zip = reportWorkbook(report);
    const { inflateRawSync } = await import("node:zlib");
    const sheets: string[] = [];
    for (let i = 0; i + 30 < zip.length; i++) {
      if (zip.readUInt32LE(i) !== 0x04034b50) continue;
      const method = zip.readUInt16LE(i + 8), size = zip.readUInt32LE(i + 18), nameLen = zip.readUInt16LE(i + 26), extra = zip.readUInt16LE(i + 28);
      const name = zip.subarray(i + 30, i + 30 + nameLen).toString();
      const data = zip.subarray(i + 30 + nameLen + extra, i + 30 + nameLen + extra + size);
      if (name.startsWith("xl/worksheets/")) sheets.push((method === 8 ? inflateRawSync(data) : data).toString("utf8"));
    }
    assert.ok(sheets.length >= 2, "workbook has worksheets");
    assert.ok(sheets.every((x) => /state="frozen"/.test(x)), "row 1 is frozen on every sheet");
    const withFilter = sheets.filter((x) => /<autoFilter /.test(x));
    assert.ok(withFilter.length >= 1, "data sheets carry an autofilter");
    const numbers = (x: string) => [...x.matchAll(/<v>(-?[0-9.]+)<\/v>/g)].map((m) => Number(m[1]));
    const dispositionSheet = sheets.find((x) => { const n = numbers(x); return n.includes(2000) && n.includes(500); });
    assert.ok(dispositionSheet, "the disposition sheet carries the delivery amounts");
    const n = numbers(dispositionSheet!);
    assert.equal([2000, 500].every((v) => n.includes(v)), true);
  });
});
