// VAR-008 — no committed status transition without its audit row.
//
// T31 gave a variance case a state machine and T45 gave the move a canonical
// audit action, `VARIANCE_CASE_STATUS_CHANGED`. VAR-006 already proves the
// row is written on the happy path. This suite asks the question VAR-006
// cannot: what happens when writing it FAILS.
//
// `advanceVarianceCase` updated the row through `db` — its own implicit
// transaction, committed the moment it returned — and only then called
// `audit`, which swallows. Two independent writes, in an order where the
// second one is allowed to disappear. A café whose AuditLog was full, whose
// disk was full, whose connection dropped between the two, got a case that
// had quietly moved from UNDER_INVESTIGATION to RESOLVED with nothing saying
// who closed it or what it was before.
//
// That is not a log line missing from a successful write. A variance case is
// an accusation in slow motion — it can end with a named person answerable
// for a shortage — and its status history IS the record of how that
// conclusion was reached. A transition nobody can reconstruct is an
// accusation with its evidence deleted.
//
// So the two writes become one act: the same transaction client updates the
// status and writes the audit row, through `auditInTransaction`, which
// throws where `audit` swallows. Either both land or neither does.
//
// The failure test does not stub. It installs a Postgres trigger that raises
// on the audit INSERT for one specific case, so the failure happens exactly
// where the question is interesting: after the transition was validated,
// after the status was written, and before commit. A stub that threw before
// the transaction opened would prove only that an exception propagates.

import { test, after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { db, closeOpenShifts, teardownTaggedCafe } from "./helpers/db";
import { requireServer, as } from "./helpers/http";
import { countCafe, type CountCafe } from "./helpers/count";
import {
  advanceVarianceCase,
  openVarianceCase,
  VARIANCE_STATUS_AUDIT_ACTION,
} from "@/lib/variance-case";

let fx: CountCafe;
let other: CountCafe;

before(async () => {
  await requireServer();
  fx = await countCafe("VAR008");
  other = await countCafe("VAR008X");
});

after(() =>
  teardownTaggedCafe([fx?.cafeId, other?.cafeId].filter(Boolean) as string[], [], {
    disconnect: true,
  })
);

let seq = 0;

/** A cash variance case, opened through the accepted engine. */
async function openCase(
  opts: { cafe?: CountCafe; branchId?: string; confidence?: "VERIFIED" | "PARTIAL" } = {}
) {
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
      shiftNumber: 8000 + seq,
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

const caseRow = (id: string) => db.varianceCase.findUniqueOrThrow({ where: { id } });

const statusAudits = (caseId: string) =>
  db.auditLog.findMany({
    where: { action: VARIANCE_STATUS_AUDIT_ACTION, entityId: caseId },
    orderBy: { createdAt: "asc" },
  });

const statusAuditCount = (caseId: string) =>
  db.auditLog.count({ where: { action: VARIANCE_STATUS_AUDIT_ACTION, entityId: caseId } });

const advanceHttp = (email: string, caseId: string, body: Record<string, unknown>) =>
  as<{ caseId?: string; status?: string; error?: string }>(
    email,
    `/api/variances/${caseId}/advance`,
    { method: "POST", body: JSON.stringify(body) }
  );

/**
 * Make the status audit INSERT for one case fail, at the database, mid-write.
 *
 * A trigger rather than a stub: the point is the ATOMICITY BOUNDARY, and the
 * only place the question means anything is inside the same transaction as
 * the status update.
 */
async function blockAuditFor(caseId: string) {
  await db.$executeRawUnsafe(`
    CREATE OR REPLACE FUNCTION ph1_block_variance_status_audit() RETURNS trigger AS $fn$
    BEGIN
      IF NEW."action" = '${VARIANCE_STATUS_AUDIT_ACTION}'
         AND NEW."entityId" = '${caseId}' THEN
        RAISE EXCEPTION 'variance status audit insert blocked by VAR-008';
      END IF;
      RETURN NEW;
    END;
    $fn$ LANGUAGE plpgsql;
  `);
  // One command per call: Postgres refuses multiple statements in a prepared
  // statement, which is what `$executeRawUnsafe` sends.
  await db.$executeRawUnsafe(
    `DROP TRIGGER IF EXISTS ph1_block_variance_status_audit_trg ON "AuditLog"`
  );
  await db.$executeRawUnsafe(`
    CREATE TRIGGER ph1_block_variance_status_audit_trg
      BEFORE INSERT ON "AuditLog"
      FOR EACH ROW EXECUTE FUNCTION ph1_block_variance_status_audit()
  `);
}

async function unblockAudit() {
  await db.$executeRawUnsafe(
    `DROP TRIGGER IF EXISTS ph1_block_variance_status_audit_trg ON "AuditLog"`
  );
  await db.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ph1_block_variance_status_audit()`);
}

describe("VAR-008 variance status transitions are atomic with their audit", () => {
  test("a legal move changes the status and writes exactly one audit row", async () => {
    const id = await openCase();
    const before = await statusAuditCount(id);
    assert.equal(before, 0, "…from a starting point that was genuinely empty");

    const result = await advanceVarianceCase({
      caseId: id,
      to: "UNDER_INVESTIGATION",
      actorId: fx.manager.id,
    });

    assert.equal(result.status, "UNDER_INVESTIGATION");
    assert.equal((await caseRow(id)).status, "UNDER_INVESTIGATION", "the row moved");
    assert.equal(await statusAuditCount(id), 1, "exactly one audit row, not zero and not two");
  });

  test("the audit names the previous status, the new one, the actor, the café and the case", async () => {
    const id = await openCase();
    await advanceVarianceCase({
      caseId: id,
      to: "UNDER_INVESTIGATION",
      actorId: fx.manager.id,
    });

    const [row] = await statusAudits(id);
    const details = row.details as Record<string, unknown>;
    assert.equal(details.from, "OPEN", "what it was");
    assert.equal(details.to, "UNDER_INVESTIGATION", "and what it became");
    assert.equal(row.userId, fx.manager.id, "who moved it");
    assert.equal(row.cafeId, fx.cafeId, "whose café it belongs to");
    assert.equal(row.entity, "VarianceCase");
    assert.equal(row.entityId, id, "and which case");
  });

  test("a failing audit insert rolls back the status change with it", async () => {
    const id = await openCase();
    const before = {
      status: (await caseRow(id)).status,
      updatedAt: (await caseRow(id)).updatedAt,
      audits: await statusAuditCount(id),
      cafeAudits: await db.auditLog.count({ where: { cafeId: fx.cafeId } }),
    };
    assert.equal(before.status, "OPEN");

    await blockAuditFor(id);
    try {
      await assert.rejects(
        () =>
          advanceVarianceCase({
            caseId: id,
            to: "UNDER_INVESTIGATION",
            actorId: fx.manager.id,
          }),
        /blocked by VAR-008/,
        "the audit insert must fail, or this test proves nothing"
      );
    } finally {
      await unblockAudit();
    }

    const after = await caseRow(id);
    assert.equal(after.status, "OPEN", "the status did not move");
    assert.deepEqual(after.updatedAt, before.updatedAt, "and the row was not touched at all");
    assert.equal(await statusAuditCount(id), before.audits, "no audit row");
    assert.equal(
      await db.auditLog.count({ where: { cafeId: fx.cafeId } }),
      before.cafeAudits,
      "and nothing else was written to the log either"
    );
  });

  test("a failing audit insert is not reported to the caller as success", async () => {
    // The HTTP surface must not answer 200 for a transition that did not
    // happen: a client that believed it would show a case as investigated
    // while the database still calls it open.
    const id = await openCase();

    await blockAuditFor(id);
    let response;
    try {
      response = await advanceHttp(fx.manager.email, id, { to: "UNDER_INVESTIGATION" });
    } finally {
      await unblockAudit();
    }

    assert.ok(response.status >= 400, `expected a failure, got ${response.status}: ${response.text}`);
    assert.equal((await caseRow(id)).status, "OPEN", "and the case really did not move");
    assert.equal(await statusAuditCount(id), 0, "with no audit row");
  });

  test("after the block is lifted, the same move applies cleanly", async () => {
    // The rollback left nothing behind, so a retry is a first attempt rather
    // than a resume — the difference between rolling back and half-committing.
    const id = await openCase();

    await blockAuditFor(id);
    try {
      await assert.rejects(() =>
        advanceVarianceCase({ caseId: id, to: "UNDER_INVESTIGATION", actorId: fx.manager.id })
      );
    } finally {
      await unblockAudit();
    }

    const result = await advanceVarianceCase({
      caseId: id,
      to: "UNDER_INVESTIGATION",
      actorId: fx.manager.id,
    });
    assert.equal(result.status, "UNDER_INVESTIGATION");
    assert.equal((await caseRow(id)).status, "UNDER_INVESTIGATION");
    assert.equal(await statusAuditCount(id), 1, "one row, from the attempt that succeeded");
  });

  test("an illegal move changes nothing and writes no status audit", async () => {
    // OPEN → RESOLVED skips the entire investigation. A refusal that wrote an
    // audit row would put a transition in the history that never happened.
    const id = await openCase();

    await assert.rejects(
      () =>
        advanceVarianceCase({
          caseId: id,
          to: "RESOLVED",
          actorId: fx.manager.id,
          note: "لا",
        }),
      /مينفعش/
    );

    assert.equal((await caseRow(id)).status, "OPEN", "still open");
    assert.equal((await caseRow(id)).resolvedAt, null, "and not closed behind the refusal");
    assert.equal(await statusAuditCount(id), 0, "no audit row for a move that was refused");
  });

  test("responsibility refused on unverified evidence leaves no audit row", async () => {
    const id = await openCase({ confidence: "PARTIAL" });

    await assert.rejects(() =>
      advanceVarianceCase({
        caseId: id,
        to: "UNDER_INVESTIGATION",
        actorId: fx.manager.id,
      }).then(() =>
        advanceVarianceCase({
          caseId: id,
          to: "RESPONSIBILITY_ASSIGNED",
          actorId: fx.manager.id,
          assignedResponsibilityUserId: fx.cashier.id,
        })
      )
    );

    const row = await caseRow(id);
    assert.equal(row.status, "UNDER_INVESTIGATION", "the legal move stands");
    assert.equal(row.assignedResponsibilityUserId, null, "and no name was written");
    assert.equal(
      await statusAuditCount(id),
      1,
      "one row for the move that happened, none for the one refused"
    );
  });

  test("a sequence of moves leaves an ordered, gapless history", async () => {
    const id = await openCase();
    await advanceVarianceCase({ caseId: id, to: "UNDER_INVESTIGATION", actorId: fx.manager.id });
    await advanceVarianceCase({
      caseId: id,
      to: "RESPONSIBILITY_ASSIGNED",
      actorId: fx.manager.id,
      assignedResponsibilityUserId: fx.cashier.id,
    });
    await advanceVarianceCase({ caseId: id, to: "APPROVED", actorId: fx.manager.id });
    await advanceVarianceCase({
      caseId: id,
      to: "RESOLVED",
      actorId: fx.owner.id,
      note: "تمت المراجعة",
    });

    const rows = await statusAudits(id);
    assert.equal(rows.length, 4, "one row per transition, no more and no fewer");
    assert.deepEqual(
      rows.map((r) => {
        const d = r.details as Record<string, unknown>;
        return `${d.from}->${d.to}`;
      }),
      [
        "OPEN->UNDER_INVESTIGATION",
        "UNDER_INVESTIGATION->RESPONSIBILITY_ASSIGNED",
        "RESPONSIBILITY_ASSIGNED->APPROVED",
        "APPROVED->RESOLVED",
      ]
    );

    // Each row's `from` is the previous row's `to`: the history is a chain,
    // not a set of independent claims.
    for (let i = 1; i < rows.length; i += 1) {
      const prev = rows[i - 1].details as Record<string, unknown>;
      const curr = rows[i].details as Record<string, unknown>;
      assert.equal(curr.from, prev.to, `row ${i} continues from row ${i - 1}`);
    }
    assert.equal(rows.at(-1)!.userId, fx.owner.id, "the closer is named on the closing row");
    assert.equal((await caseRow(id)).status, "RESOLVED");
  });

  test("a case from another café cannot be moved, and gains no audit row", async () => {
    const id = await openCase({ cafe: other });
    const r = await advanceHttp(fx.manager.email, id, { to: "UNDER_INVESTIGATION" });

    assert.equal(r.status, 404, `expected 404, got ${r.status}: ${r.text}`);
    assert.equal((await caseRow(id)).status, "OPEN", "the other café's case did not move");
    assert.equal(await statusAuditCount(id), 0, "and no audit row crossed the boundary");
  });

  test("a branch-pinned caller cannot move another branch's case", async () => {
    const id = await openCase({ branchId: fx.otherBranchId });
    const r = await advanceHttp(fx.manager.email, id, { to: "UNDER_INVESTIGATION" });

    assert.equal(r.status, 403, `expected 403, got ${r.status}: ${r.text}`);
    assert.equal((await caseRow(id)).status, "OPEN");
    assert.equal(await statusAuditCount(id), 0, "a refusal writes nothing");

    // The café owner, pinned to no branch, may — so the 403 above is about
    // the branch and not about the case being unreachable.
    const ok = await advanceHttp(fx.owner.email, id, { to: "UNDER_INVESTIGATION" });
    assert.ok(ok.status < 300, ok.text);
    assert.equal(await statusAuditCount(id), 1);
  });

  test("reading the list and the detail mutates nothing and audits nothing", async () => {
    const id = await openCase();
    await advanceVarianceCase({ caseId: id, to: "UNDER_INVESTIGATION", actorId: fx.manager.id });

    const before = {
      row: await caseRow(id),
      statusAudits: await statusAuditCount(id),
      cafeAudits: await db.auditLog.count({ where: { cafeId: fx.cafeId } }),
      cases: await db.varianceCase.count({ where: { cafeId: fx.cafeId } }),
    };

    const list = await as(fx.manager.email, `/api/variances`);
    const detail = await as(fx.manager.email, `/api/variances/${id}`);
    assert.ok(list.status < 300, list.text);
    assert.ok(detail.status < 300, detail.text);

    const after = await caseRow(id);
    assert.equal(after.status, before.row.status, "reading did not move the case");
    assert.deepEqual(after.updatedAt, before.row.updatedAt, "nor touch the row");
    assert.equal(await statusAuditCount(id), before.statusAudits, "and wrote no status audit");
    assert.equal(
      await db.auditLog.count({ where: { cafeId: fx.cafeId } }),
      before.cafeAudits,
      "no audit row of any kind"
    );
    assert.equal(
      await db.varianceCase.count({ where: { cafeId: fx.cafeId } }),
      before.cases,
      "and no case appeared or vanished"
    );
  });

  test("the blocking trigger is gone", async () => {
    // A test that installs a database trigger and leaves it behind would
    // poison every suite that runs afterwards.
    const rows = await db.$queryRaw<{ tgname: string }[]>`
      SELECT tgname FROM pg_trigger WHERE tgname = 'ph1_block_variance_status_audit_trg'
    `;
    assert.deepEqual(rows, [], "the trigger was dropped");
    const fns = await db.$queryRaw<{ proname: string }[]>`
      SELECT proname FROM pg_proc WHERE proname = 'ph1_block_variance_status_audit'
    `;
    assert.deepEqual(fns, [], "and so was its function");
  });
});
