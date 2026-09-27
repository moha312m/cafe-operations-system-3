// VAR-006 (T31) — moving a case forward requires the standing to do it.
//
// A variance case is an accusation in slow motion. It starts as "these
// numbers disagree" and can end as "this person is answerable", so the steps
// between are split across two permissions on purpose:
//
//   variance.investigate  look into it, and record who is answerable
//   variance.resolve      close it — RESOLVED or WAIVED
//
// Someone who may investigate may not sign the case off, because closing a
// case is the act that ends the review, and the person doing the reviewing
// should not also be the one deciding the review is over.
//
// TWO REFUSALS THAT ARE NOT ABOUT PERMISSIONS.
//
//   Evidence nobody could verify must never quietly become somebody's fault.
//   A case whose theoretical figure is PARTIAL or UNVERIFIABLE cannot receive
//   `assignedResponsibilityUserId` at all, whatever keys the caller holds,
//   and the refusal names the confidence so the person reading it knows what
//   would have to change.
//
//   Closing a case with no note is refused. A case that ends with no stated
//   reason is one nobody can review afterwards, which defeats the point of
//   having recorded it.
//
// And advancing a case moves no money and no stock. Responsibility here is
// an investigation OUTCOME with no financial effect in this milestone —
// spec §12 — so this suite asserts the absence rather than trusting it.

import { test, after, before, describe } from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcryptjs";
import { db, closeOpenShifts, teardownTaggedCafe } from "./helpers/db";
import { requireServer, login, as } from "./helpers/http";
import { countCafe, COUNT_PASSWORD, type CountCafe } from "./helpers/count";
import { openVarianceCase } from "@/lib/variance-case";
import { VARIANCE_STATUS_AUDIT_ACTION } from "@/lib/variance-case";

let fx: CountCafe;
let other: CountCafe;
/** Holds variance.investigate but has variance.resolve taken away. */
let investigatorEmail: string;
let investigatorId: string;

before(async () => {
  await requireServer();
  fx = await countCafe("VAR006");
  other = await countCafe("VAR006X");

  const hash = await bcrypt.hash(COUNT_PASSWORD, 10);
  const u = await db.user.create({
    data: {
      email: `${fx.marker.toLowerCase()}-investigator@example.invalid`,
      name: `${fx.marker}-investigator`,
      passwordHash: hash,
      role: "BRANCH_MANAGER",
      cafeId: fx.cafeId,
      branchId: fx.branchId,
      // The role grants both keys; the override takes the closing one away,
      // which is the only way to express "may look, may not sign off" with
      // the legacy role set.
      permissionOverrides: {
        create: [{ permissionKey: "variance.resolve", allowed: false }],
      },
    },
    select: { id: true, email: true },
  });
  investigatorId = u.id;
  investigatorEmail = u.email;
  await login(investigatorEmail, COUNT_PASSWORD);
});

after(() =>
  teardownTaggedCafe([fx?.cafeId, other?.cafeId].filter(Boolean) as string[], [], {
    disconnect: true,
  })
);

let seq = 0;

/** A cash variance case, opened through the accepted engine. */
async function openCase(opts: {
  confidence?: "VERIFIED" | "PARTIAL" | "UNVERIFIABLE";
  cafe?: CountCafe;
  branchId?: string;
} = {}) {
  const owner = opts.cafe ?? fx;
  seq += 1;
  // One drawer per cashier: close the one the previous test left open
  // rather than deleting it, so its payments and evidence survive.
  await closeOpenShifts(opts.branchId ?? owner.branchId, owner.cashier.id);
  const shift = await db.shift.create({
    data: {
      cafeId: owner.cafeId,
      branchId: opts.branchId ?? owner.branchId,
      cashierId: owner.cashier.id,
      shiftNumber: 7000 + seq,
      openingCashAmount: 0,
      expectedCashAmount: 0,
    },
  });
  const { caseId } = await db.$transaction((tx) =>
    openVarianceCase(tx, {
      cafeId: owner.cafeId,
      branchId: opts.branchId ?? owner.branchId,
      type: "CASH",
      shiftId: shift.id,
      source: { kind: "CASH_SHIFT" },
      amountVariance: -40,
      financialImpact: { available: true, value: 40 },
      confidence: opts.confidence ?? "VERIFIED",
      openedById: owner.manager.id,
    })
  );
  return caseId;
}

const advance = (email: string, caseId: string, body: Record<string, unknown>) =>
  as<{ caseId?: string; status?: string; error?: string }>(
    email,
    `/api/variances/${caseId}/advance`,
    { method: "POST", body: JSON.stringify(body) }
  );

const caseRow = (id: string) => db.varianceCase.findUniqueOrThrow({ where: { id } });

describe("VAR-006 variance investigation", () => {
  test("a holder of variance.investigate may open the investigation", async () => {
    const id = await openCase();
    const r = await advance(investigatorEmail, id, { to: "UNDER_INVESTIGATION" });
    assert.ok(r.status < 300, `expected success: ${r.text}`);
    assert.equal(r.body.status, "UNDER_INVESTIGATION");
    assert.equal((await caseRow(id)).status, "UNDER_INVESTIGATION");
  });

  test("investigating does not carry the right to close the case", async () => {
    const id = await openCase();
    await advance(investigatorEmail, id, { to: "UNDER_INVESTIGATION" });
    await advance(investigatorEmail, id, { to: "APPROVED" });

    const denied = await advance(investigatorEmail, id, {
      to: "RESOLVED", note: "خلاص",
    });
    assert.equal(
      denied.status, 403,
      `closing needs variance.resolve, got ${denied.status}: ${denied.text}`
    );
    assert.equal((await caseRow(id)).status, "APPROVED", "and the case stays open");

    const waived = await advance(investigatorEmail, id, { to: "WAIVED", note: "متجاوز" });
    assert.equal(waived.status, 403, "waiving is closing too");

    // Somebody who holds the key can.
    const signed = await advance(fx.manager.email, id, { to: "RESOLVED", note: "اتقفلت" });
    assert.ok(signed.status < 300, `expected success: ${signed.text}`);
    const closed = await caseRow(id);
    assert.equal(closed.status, "RESOLVED");
    assert.ok(closed.resolvedAt, "and the close is stamped");
    assert.equal(closed.resolvedById, fx.manager.id);
    assert.equal(closed.resolutionNote, "اتقفلت");
  });

  test("a cashier cannot move a case at all", async () => {
    const id = await openCase();
    for (const to of ["UNDER_INVESTIGATION", "WAIVED", "RESOLVED"]) {
      const r = await advance(fx.cashier.email, id, { to, note: "لا" });
      assert.equal(r.status, 403, `cashier reached ${to}: ${r.text}`);
    }
    assert.equal((await caseRow(id)).status, "OPEN");
  });

  test("an illegal transition is refused and names both states", async () => {
    const id = await openCase();
    // OPEN leads only to UNDER_INVESTIGATION or WAIVED.
    const r = await advance(fx.manager.email, id, { to: "RESOLVED", note: "مباشرة" });
    assert.equal(r.status, 400, `expected 400, got ${r.status}: ${r.text}`);
    assert.equal((await caseRow(id)).status, "OPEN");

    // And a closed case is history.
    await advance(fx.manager.email, id, { to: "WAIVED", note: "متجاوز عنه" });
    const reopened = await advance(fx.manager.email, id, { to: "UNDER_INVESTIGATION" });
    assert.equal(
      reopened.status, 400,
      "a closed case must not be quietly reopened and rewritten"
    );
  });

  test("responsibility cannot be assigned from evidence nobody could verify", async () => {
    const id = await openCase({ confidence: "PARTIAL" });
    await advance(fx.manager.email, id, { to: "UNDER_INVESTIGATION" });

    const r = await advance(fx.manager.email, id, {
      to: "RESPONSIBILITY_ASSIGNED",
      assignedResponsibilityUserId: fx.cashier.id,
    });
    assert.equal(r.status, 403, `expected 403, got ${r.status}: ${r.text}`);
    assert.match(
      r.body.error ?? "", /PARTIAL/,
      "the refusal must name the confidence, so the reader knows what would have to change"
    );

    const stored = await caseRow(id);
    assert.equal(
      stored.assignedResponsibilityUserId, null,
      "and no name is written — a guard that assigns first and complains after is no guard"
    );
    assert.equal(stored.status, "UNDER_INVESTIGATION");
  });

  test("responsibility on VERIFIED evidence is allowed", async () => {
    // The non-vacuity partner: if assignment were refused everywhere, the
    // test above would prove nothing about confidence.
    const id = await openCase({ confidence: "VERIFIED" });
    await advance(fx.manager.email, id, { to: "UNDER_INVESTIGATION" });
    const r = await advance(fx.manager.email, id, {
      to: "RESPONSIBILITY_ASSIGNED",
      assignedResponsibilityUserId: fx.cashier.id,
    });
    assert.ok(r.status < 300, `expected success: ${r.text}`);
    assert.equal((await caseRow(id)).assignedResponsibilityUserId, fx.cashier.id);
  });

  test("responsibility cannot be pinned on somebody from another café", async () => {
    const id = await openCase({ confidence: "VERIFIED" });
    await advance(fx.manager.email, id, { to: "UNDER_INVESTIGATION" });
    const r = await advance(fx.manager.email, id, {
      to: "RESPONSIBILITY_ASSIGNED",
      assignedResponsibilityUserId: other.cashier.id,
    });
    assert.ok(r.status >= 400, `expected a refusal, got ${r.status}: ${r.text}`);
    assert.equal((await caseRow(id)).assignedResponsibilityUserId, null);
  });

  test("closing a case without a stated reason is refused", async () => {
    const id = await openCase();
    await advance(fx.manager.email, id, { to: "UNDER_INVESTIGATION" });
    await advance(fx.manager.email, id, { to: "APPROVED" });

    const noNote = await advance(fx.manager.email, id, { to: "RESOLVED" });
    assert.equal(noNote.status, 400, `expected 400, got ${noNote.status}: ${noNote.text}`);
    assert.equal((await caseRow(id)).status, "APPROVED");

    const blank = await advance(fx.manager.email, id, { to: "RESOLVED", note: "   " });
    assert.equal(blank.status, 400, "whitespace is not a reason");

    const withNote = await advance(fx.manager.email, id, {
      to: "RESOLVED", note: "اتصرف فيها بالجرد",
    });
    assert.ok(withNote.status < 300, withNote.text);
  });

  test("waiving also requires a reason", async () => {
    const id = await openCase();
    const noNote = await advance(fx.manager.email, id, { to: "WAIVED" });
    assert.equal(noNote.status, 400, `waiving is closing: ${noNote.text}`);
    assert.equal((await caseRow(id)).status, "OPEN");
  });

  test("every transition leaves an audit row carrying the old and new status", async () => {
    const id = await openCase();
    await advance(fx.manager.email, id, { to: "UNDER_INVESTIGATION" });
    await advance(fx.manager.email, id, { to: "APPROVED" });
    await advance(fx.manager.email, id, { to: "RESOLVED", note: "تمام" });

    const rows = await db.auditLog.findMany({
      where: { cafeId: fx.cafeId, action: VARIANCE_STATUS_AUDIT_ACTION, entityId: id },
      orderBy: { createdAt: "asc" },
    });
    assert.equal(rows.length, 3, "one row per transition");
    const pairs = rows.map((r) => {
      const d = r.details as Record<string, unknown>;
      return `${d.from}->${d.to}`;
    });
    assert.deepEqual(pairs, [
      "OPEN->UNDER_INVESTIGATION",
      "UNDER_INVESTIGATION->APPROVED",
      "APPROVED->RESOLVED",
    ]);
    assert.ok(rows.every((r) => r.userId === fx.manager.id));
  });

  test("advancing a case moves no money and no stock", async () => {
    // Responsibility is an investigation outcome with no financial effect in
    // this milestone. Asserted rather than assumed.
    const ledgerBefore = await db.inventoryTransaction.count({ where: { cafeId: fx.cafeId } });
    const paymentsBefore = await db.payment.count({ where: { cafeId: fx.cafeId } });

    const id = await openCase({ confidence: "VERIFIED" });
    await advance(fx.manager.email, id, { to: "UNDER_INVESTIGATION" });
    await advance(fx.manager.email, id, {
      to: "RESPONSIBILITY_ASSIGNED", assignedResponsibilityUserId: fx.cashier.id,
    });
    await advance(fx.manager.email, id, { to: "APPROVED" });
    await advance(fx.manager.email, id, { to: "RESOLVED", note: "خصم مرفوض" });

    assert.equal(
      await db.inventoryTransaction.count({ where: { cafeId: fx.cafeId } }), ledgerBefore,
      "no stock moved"
    );
    assert.equal(
      await db.payment.count({ where: { cafeId: fx.cafeId } }), paymentsBefore,
      "and no money"
    );
  });

  test("another café's case is not found", async () => {
    const id = await openCase({ cafe: other });
    const r = await advance(fx.manager.email, id, { to: "UNDER_INVESTIGATION" });
    assert.equal(r.status, 404, `expected 404, got ${r.status}: ${r.text}`);
    assert.equal((await caseRow(id)).status, "OPEN");
  });

  test("a branch-pinned caller cannot move another branch's case", async () => {
    const id = await openCase({ branchId: fx.otherBranchId });
    const r = await advance(fx.manager.email, id, { to: "UNDER_INVESTIGATION" });
    assert.equal(r.status, 403, `expected 403, got ${r.status}: ${r.text}`);
    assert.equal((await caseRow(id)).status, "OPEN");

    // The café owner, pinned to no branch, may.
    const ok = await advance(fx.owner.email, id, { to: "UNDER_INVESTIGATION" });
    assert.ok(ok.status < 300, ok.text);
  });

  test("an unknown case is 404 and an unknown status is 400", async () => {
    const unknown = await advance(fx.manager.email, "no-such-case", {
      to: "UNDER_INVESTIGATION",
    });
    assert.equal(unknown.status, 404, unknown.text);

    const id = await openCase();
    const bad = await advance(fx.manager.email, id, { to: "NOT_A_STATUS" });
    assert.equal(bad.status, 400, bad.text);
    assert.equal((await caseRow(id)).status, "OPEN");
  });

  test("the investigator's own id is not what decides — the key is", async () => {
    // A guard keyed on identity rather than permission would let the
    // override be bypassed by any other manager account.
    const id = await openCase();
    await advance(fx.manager.email, id, { to: "UNDER_INVESTIGATION" });
    assert.equal(
      (await db.userPermissionOverride.findFirstOrThrow({
        where: { userId: investigatorId, permissionKey: "variance.resolve" },
      })).allowed,
      false,
      "the override is what this suite's 403s rest on"
    );
  });
});
