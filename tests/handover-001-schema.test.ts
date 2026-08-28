// HANDOVER-001 — two sides, two custodies, and stock the incoming hand can check.
//
// An earlier revision verified only cash on the incoming side. That made a
// stock handover one-sided in practice: the incoming custodian signed for a
// store room they had never inspected, and the schema had no place to record
// that they had not. So the incoming side gets its own evidence for stock —
// per line, blind — alongside the cash figures it already had.
//
// Four custody columns, not one, and not two. Custody is scope-separated
// (CASH and STOCK are separately held: the cashier holds the drawer while
// the barista holds the store room), and a handover has two sides. Outgoing
// × incoming × cash × stock is four, and collapsing any pair would make a
// cash-only or stock-only handover inexpressible — which is the ordinary
// case, not the exotic one.
//
// The two sides are two sets of columns on purpose. The outgoing side's
// evidence is what it submitted; the incoming side's verification is a
// different set of fields, so the incoming custodian recording what they
// counted cannot overwrite what they were told. That separation is
// structural here; the state machine that also forbids it in time is T37-T39
// and is not this task's to build.
//
// `StockCountSession.lockedByHandoverId` lands in this migration rather than
// an earlier one because this is the migration that creates the table it
// points at. A foreign key born with its target is the whole point of R3.3.

import { test, after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { db, tag, teardownTaggedCafe } from "./helpers/db";
import { LEGACY_TO_KEYS } from "@/lib/perms/catalog";
import { defaultKeysForRole } from "@/lib/perms/templates";

const MARKER = tag("HANDOVER001");
let cafeId: string;
let branchId: string;
let outgoingUserId: string;
let incomingUserId: string;
let managerId: string;
let outgoingShiftId: string;
let incomingShiftId: string;
let outCashCustodyId: string;
let outStockCustodyId: string;
let inCashCustodyId: string;
let inStockCustodyId: string;
let countSessionId: string;
let lineId: string;
let otherLineId: string;
let rejectionReasonId: string;
let disputeReasonId: string;

before(async () => {
  const cafe = await db.cafe.create({
    data: {
      name: `${MARKER} cafe`, slug: MARKER.toLowerCase(),
      settings: { create: {} },
      branches: { create: [{ name: `${MARKER} main` }] },
    },
    include: { branches: true },
  });
  cafeId = cafe.id;
  branchId = cafe.branches[0].id;

  const mk = async (suffix: string, role: "CASHIER" | "BRANCH_MANAGER") =>
    (await db.user.create({
      data: {
        email: `${MARKER}-${suffix}@example.invalid`, name: `${MARKER}-${suffix}`,
        passwordHash: "no-login-path", role, cafeId, branchId,
      },
    })).id;
  outgoingUserId = await mk("out", "CASHIER");
  incomingUserId = await mk("in", "CASHIER");
  managerId = await mk("manager", "BRANCH_MANAGER");

  const shift = async (n: number, cashierId: string) =>
    (await db.shift.create({
      data: {
        cafeId, branchId, cashierId, shiftNumber: n,
        openingCashAmount: 0, expectedCashAmount: 0,
      },
    })).id;
  outgoingShiftId = await shift(1, outgoingUserId);
  incomingShiftId = await shift(2, incomingUserId);

  // T10 allows one OPEN custody per branch per scope, which is the rule a
  // handover exists to satisfy: the outgoing period is TRANSFERRED as the
  // incoming one opens. Modelling the fixture that way rather than opening
  // four at once keeps the shape honest — four simultaneously open periods
  // would be a state the schema already forbids.
  const custody = async (
    scope: "CASH" | "STOCK",
    userId: string,
    status: "OPEN" | "TRANSFERRED"
  ) =>
    (await db.custodyPeriod.create({
      data: {
        cafeId, branchId, scope, status,
        endedAt: status === "TRANSFERRED" ? new Date() : null,
        participants: { create: [{ userId, role: "PRIMARY" }] },
      },
    })).id;
  outCashCustodyId = await custody("CASH", outgoingUserId, "TRANSFERRED");
  outStockCustodyId = await custody("STOCK", outgoingUserId, "TRANSFERRED");
  inCashCustodyId = await custody("CASH", incomingUserId, "OPEN");
  inStockCustodyId = await custody("STOCK", incomingUserId, "OPEN");

  const item = async (name: string) =>
    (await db.inventoryItem.create({
      data: {
        cafeId, branchId, name: `${MARKER} ${name}`, unit: "KG",
        costPerUnit: 450, currentStock: "12.000",
      },
    })).id;

  countSessionId = (await db.stockCountSession.create({
    data: {
      cafeId, branchId, type: "FULL", scopeDerivation: "ALL_ELIGIBLE",
      initiatedById: outgoingUserId,
    },
  })).id;
  const line = async (inventoryItemId: string) =>
    (await db.stockCountLine.create({
      data: {
        sessionId: countSessionId, inventoryItemId, unit: "KG",
        expectedQuantity: "12.000", countedQuantity: "11.900",
        effectiveCountedQuantity: "11.900", itemVersion: BigInt(7),
      },
    })).id;
  lineId = await line(await item("beans"));
  otherLineId = await line(await item("milk"));

  rejectionReasonId = (await db.reasonCode.create({
    data: { cafeId, domain: "HANDOVER", code: `${MARKER}-SHORT`, label: "عجز عند الاستلام" },
  })).id;
  disputeReasonId = (await db.reasonCode.create({
    data: { cafeId, domain: "STOCK", code: `${MARKER}-DISPUTE`, label: "الكمية غير مطابقة" },
  })).id;
});

after(() => teardownTaggedCafe(cafeId, [], { disconnect: true }));

/** The partial unique index allows one live handover per branch at a time. */
const clearHandovers = async () => {
  await db.stockCountSession.updateMany({
    where: { cafeId }, data: { lockedByHandoverId: null },
  });
  await db.openingException.deleteMany({ where: { cafeId } });
  await db.handoverSession.deleteMany({ where: { cafeId } });
};

const outgoing = {
  outgoingShiftId: "", outgoingUserId: "",
} as { outgoingShiftId: string; outgoingUserId: string };

describe("HANDOVER-001 handover, stock acknowledgement and opening exception", () => {
  test("a handover persists as DRAFT with all four custody columns null", async () => {
    // A handover exists before anybody has said which custodies it moves.
    // NULL means "not this scope", which is how a cash-only or stock-only
    // handover is expressed — see the next test.
    await clearHandovers();
    outgoing.outgoingShiftId = outgoingShiftId;
    outgoing.outgoingUserId = outgoingUserId;

    const h = await db.handoverSession.create({
      data: { cafeId, branchId, outgoingShiftId, outgoingUserId },
    });

    assert.equal(h.status, "DRAFT", "a handover starts unsubmitted");
    assert.equal(h.outgoingCashCustodyId, null);
    assert.equal(h.outgoingStockCustodyId, null);
    assert.equal(h.incomingCashCustodyId, null);
    assert.equal(h.incomingStockCustodyId, null);
    assert.equal(h.incomingUserId, null, "nobody has taken the other side yet");
    assert.equal(h.incomingShiftId, null);
    assert.equal(h.submittedAt, null);
    assert.equal(h.cafeId, cafeId, "and it belongs to the café that owns the branch");
    assert.equal(h.branchId, branchId);
  });

  test("cash and stock custody are set independently, so a stock-only handover exists", async () => {
    // The reason there are four columns. Collapsing them would make the
    // ordinary case — the barista hands over the store room while the
    // cashier keeps the drawer — impossible to record.
    await clearHandovers();
    const stockOnly = await db.handoverSession.create({
      data: {
        cafeId, branchId, outgoingShiftId, outgoingUserId,
        outgoingStockCustodyId: outStockCustodyId,
        incomingStockCustodyId: inStockCustodyId,
        incomingUserId,
      },
    });
    assert.equal(stockOnly.outgoingStockCustodyId, outStockCustodyId);
    assert.equal(stockOnly.incomingStockCustodyId, inStockCustodyId);
    assert.equal(stockOnly.outgoingCashCustodyId, null, "no drawer changed hands");
    assert.equal(stockOnly.incomingCashCustodyId, null);

    const loaded = await db.handoverSession.findUniqueOrThrow({
      where: { id: stockOnly.id },
      include: {
        outgoingStockCustody: true, incomingStockCustody: true,
        outgoingCashCustody: true, incomingCashCustody: true,
      },
    });
    assert.equal(loaded.outgoingStockCustody?.scope, "STOCK");
    assert.equal(loaded.incomingStockCustody?.scope, "STOCK");
    assert.equal(loaded.outgoingCashCustody, null);
    assert.equal(
      loaded.incomingCashCustody, null,
      "cash and stock evidence cannot be conflated — they are different columns"
    );
  });

  test("the two sides are two identities, and both resolve", async () => {
    await clearHandovers();
    const h = await db.handoverSession.create({
      data: {
        cafeId, branchId,
        outgoingShiftId, outgoingUserId,
        incomingShiftId, incomingUserId,
        outgoingCashCustodyId: outCashCustodyId, incomingCashCustodyId: inCashCustodyId,
      },
    });
    assert.notEqual(h.outgoingUserId, h.incomingUserId, "one hand cannot be both sides");
    assert.notEqual(h.outgoingShiftId, h.incomingShiftId);
    assert.notEqual(h.outgoingCashCustodyId, h.incomingCashCustodyId);

    const loaded = await db.handoverSession.findUniqueOrThrow({
      where: { id: h.id },
      include: { outgoingUser: true, incomingUser: true, outgoingShift: true, incomingShift: true },
    });
    assert.equal(loaded.outgoingUser.id, outgoingUserId);
    assert.equal(loaded.incomingUser?.id, incomingUserId);
    assert.equal(loaded.outgoingShift.id, outgoingShiftId);
    assert.equal(loaded.incomingShift?.id, incomingShiftId);
    assert.equal(
      loaded.outgoingUser.id === loaded.incomingUser?.id, false,
      "responsibility transfers between people, not within one"
    );
  });

  test("recording the incoming verification leaves every outgoing field untouched", async () => {
    // Structural, which is what a schema task can prove. The incoming side's
    // verification lands in its OWN columns, so writing all of them cannot
    // rewrite what the outgoing side submitted. Forbidding it in TIME — an
    // incoming user issuing an update to `proposedOpeningCash` — is the state
    // machine's job in T37-T39, not this migration's.
    await clearHandovers();
    const submitted = await db.handoverSession.create({
      data: {
        cafeId, branchId, outgoingShiftId, outgoingUserId,
        outgoingCashCustodyId: outCashCustodyId,
        outgoingStockCustodyId: outStockCustodyId,
        stockCountSessionId: countSessionId,
        proposedOpeningCash: "500.00",
        status: "OUTGOING_SUBMITTED", submittedAt: new Date(),
      },
    });

    const evidence = {
      outgoingUserId: submitted.outgoingUserId,
      outgoingShiftId: submitted.outgoingShiftId,
      outgoingCashCustodyId: submitted.outgoingCashCustodyId,
      outgoingStockCustodyId: submitted.outgoingStockCustodyId,
      stockCountSessionId: submitted.stockCountSessionId,
      proposedOpeningCash: String(submitted.proposedOpeningCash),
      submittedAt: submitted.submittedAt?.toISOString(),
    };

    const verified = await db.handoverSession.update({
      where: { id: submitted.id },
      data: {
        status: "INCOMING_REVIEW",
        incomingUserId, incomingShiftId,
        incomingCashCustodyId: inCashCustodyId,
        incomingStockCustodyId: inStockCustodyId,
        countedOpeningCash: "487.00",
        cashVarianceAmount: "-13.00",
        cashVerifiedById: incomingUserId,
        cashVerifiedAt: new Date(),
        reviewedAt: new Date(),
      },
    });

    assert.deepEqual(
      {
        outgoingUserId: verified.outgoingUserId,
        outgoingShiftId: verified.outgoingShiftId,
        outgoingCashCustodyId: verified.outgoingCashCustodyId,
        outgoingStockCustodyId: verified.outgoingStockCustodyId,
        stockCountSessionId: verified.stockCountSessionId,
        proposedOpeningCash: String(verified.proposedOpeningCash),
        submittedAt: verified.submittedAt?.toISOString(),
      },
      evidence,
      "the incoming side wrote a full verification and moved no outgoing figure"
    );
    assert.equal(Number(verified.countedOpeningCash), 487, "what they counted");
    assert.equal(Number(verified.proposedOpeningCash), 500, "against what they were told");
    assert.equal(Number(verified.cashVarianceAmount), -13);
    assert.equal(verified.cashVerifiedById, incomingUserId);
  });

  test("ACCEPT and REJECT are different persisted outcomes, not one flag", async () => {
    await clearHandovers();
    const mk = () => db.handoverSession.create({
      data: { cafeId, branchId, outgoingShiftId, outgoingUserId, incomingUserId },
    });

    const a = await mk();
    const accepted = await db.handoverSession.update({
      where: { id: a.id },
      data: { status: "ACCEPTED", acceptedAt: new Date(), completedAt: new Date() },
    });
    assert.equal(accepted.status, "ACCEPTED");
    assert.ok(accepted.acceptedAt, "an acceptance is timestamped");
    assert.equal(accepted.rejectedAt, null, "and carries no rejection");
    assert.equal(accepted.rejectionReasonCodeId, null);

    // ACCEPTED is outside the active-handover index, so a second may exist.
    const r = await mk();
    const rejected = await db.handoverSession.update({
      where: { id: r.id },
      data: {
        status: "REJECTED", rejectedAt: new Date(),
        rejectionReasonCodeId: rejectionReasonId, rejectionNote: "الدرج ناقص ١٣",
      },
      include: { rejectionReason: true },
    });
    assert.equal(rejected.status, "REJECTED");
    assert.ok(rejected.rejectedAt);
    assert.equal(rejected.acceptedAt, null, "a rejection is not a quiet acceptance");
    assert.equal(rejected.rejectionReason?.code, `${MARKER}-SHORT`);
    assert.equal(rejected.rejectionReason?.domain, "HANDOVER");

    // The original submission survives the rejection: it is evidence, and the
    // recheck workflow needs something to recheck against.
    assert.equal(rejected.outgoingUserId, outgoingUserId);
    assert.equal(rejected.outgoingShiftId, outgoingShiftId);
  });

  test("a rejection with no reason is refused by the database", async () => {
    // Spec §10: an outside-tolerance difference needs a predefined reason,
    // and a refused handover is the loudest one of those. Nullable on the
    // column because a DRAFT has nothing to explain; required once the status
    // says somebody refused.
    await clearHandovers();
    const h = await db.handoverSession.create({
      data: { cafeId, branchId, outgoingShiftId, outgoingUserId },
    });
    await assert.rejects(
      () => db.handoverSession.update({
        where: { id: h.id },
        data: { status: "REJECTED", rejectedAt: new Date() },
      }),
      /HandoverSession_rejection_reason_required|constraint/i,
      "refusing a handover without saying why must be impossible"
    );

    const still = await db.handoverSession.findUniqueOrThrow({ where: { id: h.id } });
    assert.equal(still.status, "DRAFT", "and the refused write changed nothing");
  });

  test("a manager exception cannot be anonymous", async () => {
    // Exception authority is manager/owner only, and an exception that names
    // nobody is exactly the record that makes that unenforceable afterwards.
    await clearHandovers();
    const h = await db.handoverSession.create({
      data: { cafeId, branchId, outgoingShiftId, outgoingUserId },
    });
    await assert.rejects(
      () => db.handoverSession.update({
        where: { id: h.id },
        data: { status: "MANAGER_EXCEPTION", exceptionAt: new Date() },
      }),
      /HandoverSession_exception_authority_required|constraint/i
    );

    const authorised = await db.handoverSession.update({
      where: { id: h.id },
      data: {
        status: "MANAGER_EXCEPTION", exceptionById: managerId,
        exceptionReason: "الكاشير التالي لم يحضر", exceptionAt: new Date(),
      },
      include: { exceptionBy: true },
    });
    assert.equal(authorised.exceptionBy?.id, managerId);
    assert.equal(authorised.exceptionBy?.role, "BRANCH_MANAGER");
  });

  test("the exception key is withheld from the participation bridge and from cashiers", async () => {
    // The permission half of the same rule. `handover:participate` is a
    // compatibility bridge for view/submit/accept only — the manager action
    // must never arrive through it, or every cashier would inherit it.
    assert.deepEqual(
      LEGACY_TO_KEYS["handover:participate"],
      ["handover.view", "handover.submit", "handover.accept"],
      "the bridge carries participation, never authority"
    );
    assert.equal(
      LEGACY_TO_KEYS["handover:participate"].includes("handover.exception"), false
    );
    assert.equal(
      defaultKeysForRole("CASHIER").includes("handover.exception"), false,
      "a cashier cannot wave through their own handover"
    );
    assert.equal(
      defaultKeysForRole("CAFE_OWNER").includes("handover.exception"), true,
      "the owner holds it, so the exception is authority rather than a dead key"
    );
    assert.equal(
      defaultKeysForRole("BRANCH_MANAGER").includes("handover.exception"), true,
      "and so does the manager on the floor"
    );
  });

  test("only one live handover per branch, and a finished one does not block", async () => {
    await clearHandovers();
    const first = await db.handoverSession.create({
      data: {
        cafeId, branchId, outgoingShiftId, outgoingUserId,
        status: "OUTGOING_SUBMITTED", submittedAt: new Date(),
      },
    });
    await assert.rejects(
      () => db.handoverSession.create({
        data: {
          cafeId, branchId, outgoingShiftId: incomingShiftId, outgoingUserId: incomingUserId,
          status: "OUTGOING_SUBMITTED", submittedAt: new Date(),
        },
      }),
      (e: { code?: string }) => e.code === "P2002",
      "two open handovers at one branch is two answers to who holds the room"
    );

    // A REJECTED handover still blocks: it is unfinished business, and the
    // recheck it triggers is the same handover being worked on.
    await db.handoverSession.update({
      where: { id: first.id },
      data: {
        status: "REJECTED", rejectedAt: new Date(), rejectionReasonCodeId: rejectionReasonId,
      },
    });
    await assert.rejects(
      () => db.handoverSession.create({
        data: {
          cafeId, branchId, outgoingShiftId: incomingShiftId, outgoingUserId: incomingUserId,
          status: "DRAFT",
        },
      }),
      (e: { code?: string }) => e.code === "P2002",
      "a rejected handover is unfinished, not closed"
    );

    await db.handoverSession.update({
      where: { id: first.id },
      data: { status: "COMPLETED", completedAt: new Date() },
    });
    const next = await db.handoverSession.create({
      data: {
        cafeId, branchId, outgoingShiftId: incomingShiftId, outgoingUserId: incomingUserId,
      },
    });
    assert.equal(next.status, "DRAFT", "once the last one completed, the next may open");
  });

  test("a stock acknowledgement persists, and (handover, line) rejects a duplicate", async () => {
    await clearHandovers();
    const h = await db.handoverSession.create({
      data: {
        cafeId, branchId, outgoingShiftId, outgoingUserId, incomingUserId,
        stockCountSessionId: countSessionId, status: "INCOMING_REVIEW",
      },
    });

    const ack = await db.handoverStockAcknowledgement.create({
      data: {
        handoverId: h.id, stockCountLineId: lineId,
        handedOverQuantity: "11.900", incomingCountedQuantity: "11.900",
        varianceQuantity: "0.000", acknowledgedById: incomingUserId,
      },
    });
    assert.equal(ack.decision, "ACCEPTED", "acknowledging is the default outcome");
    assert.equal(Number(ack.handedOverQuantity), 11.9);
    assert.equal(ack.disputeReasonCodeId, null);

    await assert.rejects(
      () => db.handoverStockAcknowledgement.create({
        data: {
          handoverId: h.id, stockCountLineId: lineId,
          handedOverQuantity: "11.900", acknowledgedById: incomingUserId,
        },
      }),
      (e: { code?: string }) => e.code === "P2002",
      "one line is acknowledged once per handover, or the count is meaningless"
    );

    const second = await db.handoverStockAcknowledgement.create({
      data: {
        handoverId: h.id, stockCountLineId: otherLineId,
        handedOverQuantity: "6.000", acknowledgedById: incomingUserId,
      },
    });
    assert.equal(second.stockCountLineId, otherLineId, "a different shelf is a different row");
  });

  test("an uncounted line is distinguishable from one counted at zero", async () => {
    // NULL means the incoming custodian accepted the line without counting
    // it. Zero means they counted and found nothing there. Collapsing those
    // would turn "I did not look" into "it is empty".
    await clearHandovers();
    const h = await db.handoverSession.create({
      data: {
        cafeId, branchId, outgoingShiftId, outgoingUserId, incomingUserId,
        status: "INCOMING_REVIEW",
      },
    });
    const uncounted = await db.handoverStockAcknowledgement.create({
      data: {
        handoverId: h.id, stockCountLineId: lineId,
        handedOverQuantity: "11.900", acknowledgedById: incomingUserId,
      },
    });
    const countedEmpty = await db.handoverStockAcknowledgement.create({
      data: {
        handoverId: h.id, stockCountLineId: otherLineId,
        handedOverQuantity: "6.000", incomingCountedQuantity: "0.000",
        varianceQuantity: "-6.000", acknowledgedById: incomingUserId,
      },
    });
    assert.equal(uncounted.incomingCountedQuantity, null, "accepted uncounted");
    assert.equal(Number(countedEmpty.incomingCountedQuantity), 0, "counted, and empty");
  });

  test("a disputed acknowledgement stores its reason", async () => {
    await clearHandovers();
    const h = await db.handoverSession.create({
      data: {
        cafeId, branchId, outgoingShiftId, outgoingUserId, incomingUserId,
        status: "INCOMING_REVIEW",
      },
    });
    const disputed = await db.handoverStockAcknowledgement.create({
      data: {
        handoverId: h.id, stockCountLineId: lineId,
        handedOverQuantity: "11.900", incomingCountedQuantity: "10.500",
        varianceQuantity: "-1.400", decision: "DISPUTED",
        disputeReasonCodeId: disputeReasonId, disputeNote: "الرف ناقص",
        acknowledgedById: incomingUserId,
      },
      include: { disputeReason: true, acknowledgedBy: true, line: true },
    });

    assert.equal(disputed.decision, "DISPUTED");
    assert.equal(disputed.disputeReason?.code, `${MARKER}-DISPUTE`);
    assert.equal(Number(disputed.varianceQuantity), -1.4);
    assert.equal(
      disputed.acknowledgedBy.id, incomingUserId,
      "a dispute names who raised it"
    );
    assert.equal(disputed.line.id, lineId, "and which shelf it is about");
  });

  test("an opening exception with no reason code is refused by the database", async () => {
    // Non-nullable on purpose, per spec §17. An exception is somebody opening
    // a shift against the evidence; a stated reason is the minimum record of
    // why.
    const cols = await db.$queryRaw<{ is_nullable: string }[]>`
      SELECT is_nullable FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND table_name = 'OpeningException' AND column_name = 'reasonCodeId'
    `;
    assert.equal(cols[0]?.is_nullable, "NO", "reasonCodeId is required");

    await assert.rejects(
      () => db.openingException.create({
        data: {
          cafeId, branchId, kind: "CASH_MISMATCH",
          authorizedById: managerId,
        } as never,
      }),
      "an exception with no stated reason must be refused"
    );
  });

  test("all six exception kinds store, STOCK_MISMATCH included", async () => {
    // STOCK_MISMATCH is the one the earlier revision could not express,
    // because the incoming side never inspected stock in the first place.
    await clearHandovers();
    const h = await db.handoverSession.create({
      data: { cafeId, branchId, outgoingShiftId, outgoingUserId },
    });
    const kinds = [
      "CASH_MISMATCH", "STOCK_MISMATCH", "FREE_FORM_OPENING",
      "NO_INCOMING", "FIRST_OPENING", "MANAGER_ADJUSTMENT",
    ] as const;

    const made = [];
    for (const kind of kinds) {
      made.push(await db.openingException.create({
        data: {
          cafeId, branchId, kind, shiftId: incomingShiftId,
          custodyPeriodId: inCashCustodyId, handoverId: h.id,
          proposedAmount: "500.00", actualAmount: "487.00", varianceAmount: "-13.00",
          reasonCodeId: rejectionReasonId, authorizedById: managerId,
        },
      }));
    }
    assert.deepEqual(made.map((m) => m.kind), [...kinds]);

    const loaded = await db.openingException.findUniqueOrThrow({
      where: { id: made[1].id },
      include: { handover: true, custodyPeriod: true, shift: true, reasonCode: true, authorizedBy: true },
    });
    assert.equal(loaded.kind, "STOCK_MISMATCH");
    assert.equal(loaded.handover?.id, h.id, "an exception knows the handover it stood in for");
    assert.equal(loaded.custodyPeriod?.id, inCashCustodyId);
    assert.equal(loaded.shift?.id, incomingShiftId);
    assert.equal(loaded.authorizedBy.id, managerId, "and who authorised it");
  });

  test("Restrict refuses deleting a custody period a handover still references", async () => {
    // Custody is the accountability record. A handover names the custody it
    // moved, and deleting that period would erase who was answerable while
    // leaving the transfer standing.
    await clearHandovers();
    // TRANSFERRED, not OPEN: T10 already allows only one open custody per
    // branch per scope, and the fixture holds the open one.
    const doomed = await db.custodyPeriod.create({
      data: { cafeId, branchId, scope: "STOCK", status: "TRANSFERRED", endedAt: new Date() },
    });
    const h = await db.handoverSession.create({
      data: {
        cafeId, branchId, outgoingShiftId, outgoingUserId,
        outgoingStockCustodyId: doomed.id,
      },
    });

    await assert.rejects(
      () => db.custodyPeriod.delete({ where: { id: doomed.id } }),
      /Foreign key|constraint|P2003/i,
      "the custody a handover cites must outlive the citation"
    );

    await db.handoverSession.delete({ where: { id: h.id } });
    await db.custodyPeriod.delete({ where: { id: doomed.id } });
  });

  test("StockCountSession.lockedByHandoverId exists, with its foreign key", async () => {
    // R3.3, visible in a test: the column ships in the migration that creates
    // the table it points at, so it is never a bare String pretending to be a
    // relation.
    const constraints = await db.$queryRaw<{ constraint_name: string; foreign_table: string }[]>`
      SELECT tc.constraint_name, ccu.table_name AS foreign_table
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
        JOIN information_schema.constraint_column_usage ccu
          ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
       WHERE tc.constraint_type = 'FOREIGN KEY'
         AND tc.table_schema = current_schema()
         AND tc.table_name = 'StockCountSession'
         AND kcu.column_name = 'lockedByHandoverId'
    `;
    assert.equal(constraints.length, 1, "the column is constrained, not merely present");
    assert.equal(constraints[0].foreign_table, "HandoverSession");
  });

  test("locking a count to a handover that does not exist is rejected", async () => {
    await clearHandovers();
    await assert.rejects(
      () => db.stockCountSession.update({
        where: { id: countSessionId },
        data: { lockedByHandoverId: `no-such-handover-${MARKER}` },
      }),
      /Foreign key|constraint|P2003/i,
      "a lock must name a handover that happened"
    );

    const h = await db.handoverSession.create({
      data: { cafeId, branchId, outgoingShiftId, outgoingUserId },
    });
    const locked = await db.stockCountSession.update({
      where: { id: countSessionId },
      data: { lockedByHandoverId: h.id },
      include: { lockedByHandover: true },
    });
    assert.equal(locked.lockedByHandover?.id, h.id, "and a real one locks it");

    const back = await db.handoverSession.findUniqueOrThrow({
      where: { id: h.id }, include: { lockedCounts: true },
    });
    assert.equal(back.lockedCounts.length, 1, "the handover reaches the counts it locked");

    await db.stockCountSession.update({
      where: { id: countSessionId }, data: { lockedByHandoverId: null },
    });
  });

  test("a live rejection holds its reason code; a finished one lets it go", async () => {
    // The SetNull foreign key and the rejection-reason CHECK combine into
    // something stronger than either alone, and stronger than SetNull on its
    // own would suggest. Deleting a reason code tries to blank the citation;
    // on a still-REJECTED handover that blanking would leave a refusal with
    // no stated reason, so the CHECK refuses the delete outright.
    //
    // The reason is therefore held exactly as long as the refusal is live.
    // Once the handover moves on — the recheck happened, the handover
    // completed — the citation is free to blank, and the vocabulary can be
    // retired without deleting the history that used it.
    await clearHandovers();
    const temp = await db.reasonCode.create({
      data: { cafeId, domain: "HANDOVER", code: `${MARKER}-TEMP`, label: "مؤقت" },
    });
    const h = await db.handoverSession.create({
      data: {
        cafeId, branchId, outgoingShiftId, outgoingUserId,
        status: "REJECTED", rejectedAt: new Date(), rejectionReasonCodeId: temp.id,
      },
    });

    await assert.rejects(
      () => db.reasonCode.delete({ where: { id: temp.id } }),
      /check constraint|HandoverSession_rejection_reason_required/i,
      "a live refusal cannot be quietly stripped of the reason it gave"
    );
    const stillRejected = await db.handoverSession.findUniqueOrThrow({ where: { id: h.id } });
    assert.equal(stillRejected.rejectionReasonCodeId, temp.id, "the citation stands");

    await db.handoverSession.update({
      where: { id: h.id },
      data: { status: "COMPLETED", completedAt: new Date() },
    });
    await db.reasonCode.delete({ where: { id: temp.id } });
    const finished = await db.handoverSession.findUniqueOrThrow({ where: { id: h.id } });
    assert.equal(finished.rejectionReasonCodeId, null, "now the citation blanks");
    assert.ok(finished.rejectedAt, "and the record that it was once refused survives");

    // An OpeningException's reason is Restrict rather than SetNull, because
    // there is no status it can reach where a missing reason becomes valid.
    const held = await db.reasonCode.create({
      data: { cafeId, domain: "HANDOVER", code: `${MARKER}-HELD`, label: "محجوز" },
    });
    await db.openingException.create({
      data: {
        cafeId, branchId, kind: "FIRST_OPENING",
        reasonCodeId: held.id, authorizedById: managerId,
      },
    });
    await assert.rejects(
      () => db.reasonCode.delete({ where: { id: held.id } }),
      /Foreign key|constraint|P2003/i,
      "an exception has no valid state without its reason, so the reason is held for good"
    );
  });

  test("every accountability id is a real foreign key", async () => {
    const fks = await db.$queryRaw<{ table_name: string; column_name: string; foreign_table: string }[]>`
      SELECT tc.table_name, kcu.column_name, ccu.table_name AS foreign_table
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
        JOIN information_schema.constraint_column_usage ccu
          ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
       WHERE tc.constraint_type = 'FOREIGN KEY'
         AND tc.table_schema = current_schema()
         AND tc.table_name IN (
           'HandoverSession', 'HandoverStockAcknowledgement', 'OpeningException'
         )
    `;
    const found = new Set(fks.map((f) => `${f.table_name}.${f.column_name}->${f.foreign_table}`));

    for (const expected of [
      "HandoverSession.cafeId->Cafe",
      "HandoverSession.branchId->Branch",
      "HandoverSession.outgoingCashCustodyId->CustodyPeriod",
      "HandoverSession.outgoingStockCustodyId->CustodyPeriod",
      "HandoverSession.incomingCashCustodyId->CustodyPeriod",
      "HandoverSession.incomingStockCustodyId->CustodyPeriod",
      "HandoverSession.outgoingShiftId->Shift",
      "HandoverSession.incomingShiftId->Shift",
      "HandoverSession.outgoingUserId->User",
      "HandoverSession.incomingUserId->User",
      "HandoverSession.exceptionById->User",
      "HandoverSession.cashVerifiedById->User",
      "HandoverSession.stockCountSessionId->StockCountSession",
      "HandoverSession.rejectionReasonCodeId->ReasonCode",
      "HandoverStockAcknowledgement.handoverId->HandoverSession",
      "HandoverStockAcknowledgement.stockCountLineId->StockCountLine",
      "HandoverStockAcknowledgement.acknowledgedById->User",
      "HandoverStockAcknowledgement.disputeReasonCodeId->ReasonCode",
      "OpeningException.cafeId->Cafe",
      "OpeningException.branchId->Branch",
      "OpeningException.shiftId->Shift",
      "OpeningException.custodyPeriodId->CustodyPeriod",
      "OpeningException.handoverId->HandoverSession",
      "OpeningException.reasonCodeId->ReasonCode",
      "OpeningException.authorizedById->User",
    ]) {
      assert.ok(found.has(expected), `missing foreign key ${expected}`);
    }
  });

  test("a reference to a row in another café is rejected by the foreign key", async () => {
    // What the schema can enforce today: an id must name something real.
    // Whether that something belongs to the SAME branch is a cross-field rule
    // no plain foreign key expresses, and it is owned by the handover
    // services in T37-T39 — this test pins the half that is structural so the
    // other half cannot be mistaken for done.
    await clearHandovers();
    await assert.rejects(
      () => db.handoverSession.create({
        data: {
          cafeId, branchId, outgoingShiftId, outgoingUserId,
          outgoingCashCustodyId: `not-a-custody-${MARKER}`,
        },
      }),
      /Foreign key|constraint|P2003/i
    );
    await assert.rejects(
      () => db.handoverSession.create({
        data: {
          cafeId, branchId, outgoingShiftId: `not-a-shift-${MARKER}`, outgoingUserId,
        },
      }),
      /Foreign key|constraint|P2003/i
    );
  });

  test("the handover belongs to its branch and café, and both resolve", async () => {
    await clearHandovers();
    const h = await db.handoverSession.create({
      data: { cafeId, branchId, outgoingShiftId, outgoingUserId },
    });
    const loaded = await db.handoverSession.findUniqueOrThrow({
      where: { id: h.id }, include: { cafe: true, branch: true },
    });
    assert.equal(loaded.cafe.id, cafeId);
    assert.equal(loaded.branch.id, branchId);
    assert.equal(loaded.branch.cafeId, cafeId, "the branch is this café's branch");

    const branch = await db.branch.findUniqueOrThrow({
      where: { id: branchId }, include: { handoverSessions: true },
    });
    assert.equal(branch.handoverSessions.length, 1, "and the branch reaches its handovers");
  });

  test("the idempotency key rejects a replayed submission", async () => {
    await clearHandovers();
    const key = `${MARKER}-idem`;
    await db.handoverSession.create({
      data: { cafeId, branchId, outgoingShiftId, outgoingUserId, idempotencyKey: key },
    });
    await assert.rejects(
      () => db.handoverSession.create({
        data: {
          cafeId, branchId, outgoingShiftId: incomingShiftId, outgoingUserId: incomingUserId,
          idempotencyKey: key,
        },
      }),
      (e: { code?: string }) => e.code === "P2002",
      "a retried request must not open a second handover"
    );
  });
});
