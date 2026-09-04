// CUSTODY-005 — a transfer records who accepted it, and which shift answers
// for what comes next.
//
// `transferCustody` already closed one period and opened its successor in one
// act. Two things it did not record turn out to be the whole substance of an
// acceptance:
//
//   * WHO ACCEPTED. Acceptance is an act performed UPON the custody being
//     handed over, so `acceptedById`/`acceptedAt` belong on the PREDECESSOR.
//     The successor has not itself been accepted by anyone yet; stamping it
//     would claim an event that has not happened. The roadmap states the rule
//     once, at line 334: transfer happens in exactly two places, and both
//     write those two columns.
//
//   * WHICH SHIFT ANSWERS. `resolveStockAttribution` reads a STOCK custody's
//     `responsibleShiftId` and stamps it on every subsequent stock movement.
//     A successor without one is not merely untidy: every sale made under it
//     is unattributable, and `POST /api/orders/[id]/status` refuses to serve
//     at all. The shift-open bootstrap has always written it at its own STOCK
//     open; a transfer that dropped it was the gap.
//
// The primitive is made capable of a BRANCH-held successor here because those
// semantics have to be proved before SH-22 relies on them. SH-20 never
// constructs one — its ordinary acceptance refuses a BRANCH_CUSTODY target
// outright — so what this suite pins is the primitive's capability, not a
// route to it.

import { test, after, before, beforeEach, describe } from "node:test";
import assert from "node:assert/strict";
import { db, tag, teardownTaggedCafe } from "./helpers/db";
import { openCustodyPeriod, transferCustody } from "@/lib/custody";
import { applyStockMutation, resolveStockAttribution } from "@/lib/ledger";

const MARKER = tag("CUSTODY005");

let cafeId: string;
let branchId: string;
let outgoingUserId: string;
let incomingUserId: string;
let acceptorId: string;
let outgoingShiftId: string;
let incomingShiftId: string;
let itemId: string;

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
  outgoingUserId = await mk("outgoing", "CASHIER");
  incomingUserId = await mk("incoming", "CASHIER");
  acceptorId = await mk("acceptor", "BRANCH_MANAGER");

  const shift = async (cashierId: string, n: number) =>
    (await db.shift.create({
      data: {
        cafeId, branchId, cashierId, shiftNumber: n,
        openingCashAmount: 0, expectedCashAmount: 0,
      },
    })).id;
  outgoingShiftId = await shift(outgoingUserId, 960001);
  incomingShiftId = await shift(incomingUserId, 960002);

  itemId = (await db.inventoryItem.create({
    data: {
      cafeId, branchId, name: `${MARKER} beans`, unit: "KG",
      costPerUnit: 450, currentStock: 20,
    },
  })).id;
});

/**
 * Custody is per-branch-per-scope unique while OPEN, so every test starts
 * from an empty branch rather than from whatever the last one left behind.
 */
async function clearCustody() {
  await db.shiftCustody.deleteMany({ where: { custodyPeriod: { branchId } } });
  await db.custodyParticipant.deleteMany({ where: { custodyPeriod: { branchId } } });
  await db.custodyPeriod.updateMany({ where: { branchId }, data: { previousPeriodId: null } });
  await db.custodyPeriod.deleteMany({ where: { branchId } });
  await db.auditLog.deleteMany({ where: { cafeId, action: "CUSTODY_TRANSFERRED" } });
}

beforeEach(clearCustody);

after(() => teardownTaggedCafe(cafeId, [], { disconnect: true }));

/** The outgoing custodian's period, held by the outgoing shift. */
async function openOutgoing(
  scope: "STOCK" | "CASH",
  options: { shiftId?: string | null; openingCashAmount?: number } = {}
) {
  const shiftId = options.shiftId === undefined ? outgoingShiftId : options.shiftId;
  const { custodyPeriodId } = await db.$transaction((tx) =>
    openCustodyPeriod(tx, {
      cafeId, branchId, scope,
      participants: [{ userId: outgoingUserId, role: "PRIMARY" }],
      shiftId,
      holderType: "USER",
      openedById: outgoingUserId,
      responsibleShiftId: scope === "STOCK" ? shiftId : null,
      openingCashAmount: options.openingCashAmount ?? null,
    })
  );
  return custodyPeriodId;
}

const period = (id: string) =>
  db.custodyPeriod.findUniqueOrThrow({
    where: { id },
    include: { participants: true, previousPeriod: true, nextPeriod: true, shiftLinks: true },
  });

describe("CUSTODY-005 transfer acceptance metadata and successor responsibility", () => {
  test("a shift-to-shift STOCK successor names the shift answerable for it", async () => {
    const outgoing = await openOutgoing("STOCK");
    const acceptedAt = new Date();

    const r = await db.$transaction((tx) =>
      transferCustody(tx, {
        outgoingPeriodId: outgoing, scope: "STOCK",
        incoming: {
          participants: [{ userId: incomingUserId, role: "PRIMARY" }],
          shiftId: incomingShiftId,
          responsibleShiftId: incomingShiftId,
          holderType: "USER",
          openedById: acceptorId,
        },
        actorId: acceptorId,
        acceptedById: acceptorId,
        acceptedAt,
      })
    );

    const successor = await period(r.incomingPeriodId);
    assert.equal(successor.status, "OPEN");
    assert.equal(successor.holderType, "USER");
    assert.equal(
      successor.responsibleShiftId, incomingShiftId,
      "the arriving shift answers for every movement made under this custody"
    );
    assert.equal(successor.openedById, acceptorId, "and the record says who opened it");
    assert.equal(successor.previousPeriodId, outgoing);
    assert.deepEqual(successor.participants.map((p) => p.userId), [incomingUserId]);
  });

  test("acceptance is stamped on the predecessor, never on the successor", async () => {
    const outgoing = await openOutgoing("STOCK");
    const acceptedAt = new Date();

    const r = await db.$transaction((tx) =>
      transferCustody(tx, {
        outgoingPeriodId: outgoing, scope: "STOCK",
        incoming: {
          participants: [{ userId: incomingUserId, role: "PRIMARY" }],
          shiftId: incomingShiftId, responsibleShiftId: incomingShiftId,
          openedById: acceptorId,
        },
        actorId: acceptorId, acceptedById: acceptorId, acceptedAt,
      })
    );

    const predecessor = await period(r.outgoingPeriodId);
    assert.equal(predecessor.status, "TRANSFERRED");
    assert.ok(predecessor.endedAt, "closed");
    assert.equal(
      predecessor.acceptedById, acceptorId,
      "acceptance is done TO the custody being handed over"
    );
    assert.equal(predecessor.acceptedAt?.getTime(), acceptedAt.getTime());

    const successor = await period(r.incomingPeriodId);
    assert.equal(
      successor.acceptedById, null,
      "nobody has accepted the successor — it has only just been opened"
    );
    assert.equal(successor.acceptedAt, null);
  });

  test("the chain resolves in both directions", async () => {
    const outgoing = await openOutgoing("STOCK");
    const r = await db.$transaction((tx) =>
      transferCustody(tx, {
        outgoingPeriodId: outgoing, scope: "STOCK",
        incoming: {
          participants: [{ userId: incomingUserId, role: "PRIMARY" }],
          shiftId: incomingShiftId, responsibleShiftId: incomingShiftId,
          openedById: acceptorId,
        },
        actorId: acceptorId, acceptedById: acceptorId, acceptedAt: new Date(),
      })
    );

    const successor = await period(r.incomingPeriodId);
    const predecessor = await period(r.outgoingPeriodId);
    assert.equal(successor.previousPeriod?.id, predecessor.id);
    assert.equal(predecessor.nextPeriod?.id, successor.id);
  });

  test("a BRANCH successor holds stock with nobody named, and no shift invented", async () => {
    const outgoing = await openOutgoing("STOCK");
    const r = await db.$transaction((tx) =>
      transferCustody(tx, {
        outgoingPeriodId: outgoing, scope: "STOCK",
        incoming: {
          participants: [], shiftId: null, holderType: "BRANCH", openedById: acceptorId,
        },
        actorId: acceptorId, acceptedById: acceptorId, acceptedAt: new Date(),
      })
    );

    const successor = await period(r.incomingPeriodId);
    assert.equal(successor.holderType, "BRANCH");
    assert.equal(successor.participants.length, 0, "the branch holds it, not a person");
    assert.equal(
      successor.responsibleShiftId, null,
      "and no shift is fabricated to answer for a period no shift held"
    );
    assert.equal(successor.shiftLinks.length, 0);
  });

  test("a BRANCH successor of the cash drawer is refused", async () => {
    const outgoing = await openOutgoing("CASH", { openingCashAmount: 100 });
    await assert.rejects(
      () =>
        db.$transaction((tx) =>
          transferCustody(tx, {
            outgoingPeriodId: outgoing, scope: "CASH",
            incoming: { participants: [], shiftId: null, holderType: "BRANCH" },
            actorId: acceptorId,
          })
        ),
      /stock-only/i,
      "a branch cannot hold a till overnight the way it can hold a store room"
    );

    const predecessor = await period(outgoing);
    assert.equal(predecessor.status, "OPEN", "and the refusal wrote nothing");
    assert.equal(predecessor.acceptedById, null);
  });

  test("a CASH successor carries no responsible shift", async () => {
    const outgoing = await openOutgoing("CASH", { openingCashAmount: 100 });
    const r = await db.$transaction((tx) =>
      transferCustody(tx, {
        outgoingPeriodId: outgoing, scope: "CASH",
        incoming: {
          participants: [{ userId: incomingUserId, role: "PRIMARY" }],
          shiftId: incomingShiftId,
          // Supplied, and deliberately ignored: responsibility for stock
          // movement is a stock concept, and a drawer has no shelf.
          responsibleShiftId: incomingShiftId,
          openedById: acceptorId,
        },
        closingCashAmount: 400,
        actorId: acceptorId, acceptedById: acceptorId, acceptedAt: new Date(),
      })
    );

    const successor = await period(r.incomingPeriodId);
    assert.equal(successor.responsibleShiftId, null);
    assert.equal(Number(successor.openingCashAmount), 400, "cash semantics are untouched");
    const predecessor = await period(r.outgoingPeriodId);
    assert.equal(Number(predecessor.closingCashAmount), 400);
    assert.equal(predecessor.acceptedById, acceptorId);
  });

  test("a STOCK successor attached to a shift is never left shift-less", async () => {
    // RULING R-B. `openShiftCustody` already answers this at its own STOCK
    // open: the shift the custody is attached to is the shift that answers for
    // it. A transfer that named a shift but no responsibility would create the
    // one state that makes every later sale unattributable, so the attached
    // shift supplies it.
    const outgoing = await openOutgoing("STOCK");
    const r = await db.$transaction((tx) =>
      transferCustody(tx, {
        outgoingPeriodId: outgoing, scope: "STOCK",
        incoming: {
          participants: [{ userId: incomingUserId, role: "PRIMARY" }],
          shiftId: incomingShiftId,
          // responsibleShiftId deliberately omitted.
        },
        actorId: acceptorId,
      })
    );

    const successor = await period(r.incomingPeriodId);
    assert.equal(successor.responsibleShiftId, incomingShiftId);
  });

  test("a STOCK successor attached to no shift stays shift-less", async () => {
    // The other half of RULING R-B, and the reason it defaults rather than
    // refuses. This state is not new and not an inconsistency: SERVE already
    // refuses to deduct against a stock custody with no responsible shift, so
    // the system has a defined answer for it. Refusing to create it here would
    // be a new restriction on a shape that predates SH-20.
    const outgoing = await openOutgoing("STOCK", { shiftId: null });
    const r = await db.$transaction((tx) =>
      transferCustody(tx, {
        outgoingPeriodId: outgoing, scope: "STOCK",
        incoming: { participants: [{ userId: incomingUserId, role: "PRIMARY" }], shiftId: null },
        actorId: acceptorId,
      })
    );

    const successor = await period(r.incomingPeriodId);
    assert.equal(successor.responsibleShiftId, null);
    assert.equal(successor.holderType, "USER");
  });

  test("stock moved after the transfer is attributed to the incoming shift", async () => {
    const outgoing = await openOutgoing("STOCK");
    const r = await db.$transaction((tx) =>
      transferCustody(tx, {
        outgoingPeriodId: outgoing, scope: "STOCK",
        incoming: {
          participants: [{ userId: incomingUserId, role: "PRIMARY" }],
          shiftId: incomingShiftId, responsibleShiftId: incomingShiftId,
          openedById: acceptorId,
        },
        actorId: acceptorId, acceptedById: acceptorId, acceptedAt: new Date(),
      })
    );

    const attribution = await db.$transaction((tx) => resolveStockAttribution(tx, branchId));
    assert.deepEqual(attribution, {
      custodyPeriodId: r.incomingPeriodId,
      shiftId: incomingShiftId,
    });

    // And the real writer stamps that pair, rather than the test asserting a
    // resolver in isolation.
    const mutation = await db.$transaction((tx) =>
      applyStockMutation(tx, {
        inventoryItemId: itemId, type: "USAGE", quantity: -1,
        cafeId, branchId, createdById: incomingUserId,
      })
    );
    const txn = await db.inventoryTransaction.findUniqueOrThrow({
      where: { id: mutation.transactionId },
    });
    assert.equal(txn.custodyPeriodId, r.incomingPeriodId);
    assert.equal(txn.shiftId, incomingShiftId);
  });

  test("the caller's rollback leaves the predecessor open and creates no successor", async () => {
    const outgoing = await openOutgoing("STOCK");
    const before = await db.custodyPeriod.count({ where: { branchId } });

    await assert.rejects(
      () =>
        db.$transaction(async (tx) => {
          await transferCustody(tx, {
            outgoingPeriodId: outgoing, scope: "STOCK",
            incoming: {
              participants: [{ userId: incomingUserId, role: "PRIMARY" }],
              shiftId: incomingShiftId, responsibleShiftId: incomingShiftId,
              openedById: acceptorId,
            },
            actorId: acceptorId, acceptedById: acceptorId, acceptedAt: new Date(),
          });
          throw new Error("CUSTODY-005 forced acceptance failure");
        }),
      /CUSTODY-005 forced acceptance failure/
    );

    const predecessor = await period(outgoing);
    assert.equal(predecessor.status, "OPEN", "the outgoing custodian is still answerable");
    assert.equal(predecessor.endedAt, null);
    assert.equal(predecessor.acceptedById, null, "and nobody is recorded as having accepted");
    assert.equal(predecessor.acceptedAt, null);
    assert.equal(await db.custodyPeriod.count({ where: { branchId } }), before);
  });

  test("two acceptances racing for one custody produce exactly one successor", async () => {
    const outgoing = await openOutgoing("STOCK");

    const attempt = (openedById: string) =>
      db.$transaction((tx) =>
        transferCustody(tx, {
          outgoingPeriodId: outgoing, scope: "STOCK",
          incoming: {
            participants: [{ userId: incomingUserId, role: "PRIMARY" }],
            shiftId: null, responsibleShiftId: incomingShiftId, openedById,
          },
          actorId: openedById, acceptedById: openedById, acceptedAt: new Date(),
        })
      );

    const outcomes = await Promise.allSettled([attempt(acceptorId), attempt(incomingUserId)]);
    const won = outcomes.filter((o) => o.status === "fulfilled");
    assert.equal(won.length, 1, "one acceptance, not two");

    assert.equal(
      await db.custodyPeriod.count({ where: { branchId, scope: "STOCK", status: "OPEN" } }), 1,
      "and the branch has exactly one open stock custody"
    );
    const predecessor = await period(outgoing);
    assert.equal(predecessor.status, "TRANSFERRED");
    assert.equal(
      await db.custodyPeriod.count({ where: { previousPeriodId: outgoing } }), 1,
      "one period claims it as predecessor"
    );
  });

  test("the audit row carries the acceptance and the responsibility it recorded", async () => {
    const outgoing = await openOutgoing("STOCK");
    const acceptedAt = new Date();
    const r = await db.$transaction((tx) =>
      transferCustody(tx, {
        outgoingPeriodId: outgoing, scope: "STOCK",
        incoming: {
          participants: [{ userId: incomingUserId, role: "PRIMARY" }],
          shiftId: incomingShiftId, responsibleShiftId: incomingShiftId,
          holderType: "USER", openedById: acceptorId,
        },
        actorId: acceptorId, acceptedById: acceptorId, acceptedAt,
      })
    );

    const entry = await db.auditLog.findFirstOrThrow({
      where: { cafeId, action: "CUSTODY_TRANSFERRED" },
      orderBy: { createdAt: "desc" },
    });
    const details = entry.details as Record<string, unknown>;
    assert.equal(details.scope, "STOCK", "the existing shape is unchanged");
    assert.equal(details.outgoingPeriodId, r.outgoingPeriodId);
    assert.equal(details.incomingPeriodId, r.incomingPeriodId);
    assert.equal(details.acceptedById, acceptorId);
    assert.equal(details.acceptedAt, acceptedAt.toISOString());
    assert.equal(details.responsibleShiftId, incomingShiftId);
    assert.equal(details.holderType, "USER");
  });
});
