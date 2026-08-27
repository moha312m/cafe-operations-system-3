// CUSTODY-002 — hand over a scope in one movement, or not at all.
//
// The invariant this suite exists for: at no observable moment does a branch
// have two custodians of one scope, or none. A handover that closed the
// outgoing period and then opened the incoming one in a second transaction
// would leave a window in which nobody was answerable for the drawer — and
// any shortage discovered later would have no holder to attribute it to.
//
// So every mutator takes a `TransactionClient` rather than opening its own
// transaction. That is not a style preference: it is what lets a handover
// (T39) close outgoing, open incoming, rebase stock and write exceptions as
// one atomic act. A function that opened its own transaction could not
// participate in that.
//
// The database backs the same rule independently, through the partial unique
// index from T10 — so even a caller who ignored this service could not create
// the second open custody.

import { test, after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { db, tag } from "./helpers/db";
import {
  openCustodyPeriod, transferCustody, activeCustody, linkShiftCustody,
} from "@/lib/custody";

const MARKER = tag("CUSTODY002");
let cafeId: string;
let branchId: string;
let userA: string;
let userB: string;
let shiftA: string;
let shiftB: string;

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

  const mk = async (suffix: string) =>
    (await db.user.create({
      data: {
        email: `${MARKER}-${suffix}@example.invalid`, name: `${MARKER}-${suffix}`,
        passwordHash: "no-login-path", role: "CASHIER", cafeId, branchId,
      },
    })).id;
  userA = await mk("a");
  userB = await mk("b");

  const shift = async (n: number, cashierId: string) =>
    (await db.shift.create({
      data: {
        cafeId, branchId, cashierId, shiftNumber: n,
        openingCashAmount: 0, expectedCashAmount: 0,
      },
    })).id;
  shiftA = await shift(1, userA);
  shiftB = await shift(2, userB);
});

after(async () => {
  // Custody first, and deliberately so. `CustodyParticipant.userId` is
  // Restrict, not Cascade: a custody record names who was answerable, and
  // deleting a staff account must not erase the evidence of what they held.
  // The teardown has to unwind in that order, which is the schema working.
  await db.shiftCustody.deleteMany({ where: { custodyPeriod: { branchId } } });
  await db.custodyPeriod.updateMany({ where: { branchId }, data: { previousPeriodId: null } });
  await db.custodyParticipant.deleteMany({ where: { custodyPeriod: { branchId } } });
  await db.custodyPeriod.deleteMany({ where: { branchId } });
  await db.auditLog.deleteMany({ where: { cafeId } });
  await db.shift.deleteMany({ where: { cafeId } });
  await db.user.deleteMany({ where: { cafeId } });
  await db.cafe.deleteMany({ where: { id: cafeId } });
  await db.$disconnect();
});

/** Remove every custody row at this branch, between assertions. */
async function clearCustody() {
  await db.shiftCustody.deleteMany({ where: { custodyPeriod: { branchId } } });
  await db.custodyPeriod.updateMany({ where: { branchId }, data: { previousPeriodId: null } });
  await db.custodyPeriod.deleteMany({ where: { branchId } });
}

/** Open a period in its own transaction, the ordinary shift-open case. */
function open(scope: "CASH" | "STOCK", userId = userA, extra: Record<string, unknown> = {}) {
  return db.$transaction((tx) =>
    openCustodyPeriod(tx, {
      cafeId, branchId, scope,
      participants: [{ userId, role: "PRIMARY" }],
      ...extra,
    })
  );
}

describe("CUSTODY-002 custody lifecycle", () => {
  test("opening a period records the period and who holds it", async () => {
    await clearCustody();
    const { custodyPeriodId } = await db.$transaction((tx) =>
      openCustodyPeriod(tx, {
        cafeId, branchId, scope: "CASH",
        participants: [
          { userId: userA, role: "PRIMARY" },
          { userId: userB, role: "SHARED" },
        ],
        shiftId: shiftA,
        openingCashAmount: 250,
      })
    );

    const p = await db.custodyPeriod.findUniqueOrThrow({
      where: { id: custodyPeriodId },
      include: { participants: { orderBy: { role: "asc" } }, shiftLinks: true },
    });
    assert.equal(p.status, "OPEN");
    assert.equal(Number(p.openingCashAmount), 250);
    assert.deepEqual(p.participants.map((x) => x.role), ["PRIMARY", "SHARED"]);
    assert.equal(p.shiftLinks.length, 1, "the opening shift is linked in the same act");
    assert.equal(p.shiftLinks[0].scope, "CASH");
  });

  test("the two scopes are independent custodies at the same branch", async () => {
    await clearCustody();
    const cash = await open("CASH");
    const stock = await open("STOCK", userB);

    const activeCash = await activeCustody(branchId, "CASH");
    const activeStock = await activeCustody(branchId, "STOCK");
    assert.equal(activeCash?.id, cash.custodyPeriodId);
    assert.equal(activeStock?.id, stock.custodyPeriodId);
    assert.notEqual(
      activeCash?.id, activeStock?.id,
      "the drawer and the store room are held by different people, and the model says so"
    );
  });

  test("a transfer closes outgoing and opens incoming in one act, chained", async () => {
    await clearCustody();
    const { custodyPeriodId: outgoing } = await open("CASH", userA, { shiftId: shiftA });

    const r = await db.$transaction((tx) =>
      transferCustody(tx, {
        outgoingPeriodId: outgoing, scope: "CASH",
        incoming: { participants: [{ userId: userB, role: "PRIMARY" }], shiftId: shiftB },
        closingCashAmount: 400, actorId: userA,
      })
    );

    const out = await db.custodyPeriod.findUniqueOrThrow({ where: { id: r.outgoingPeriodId } });
    const inc = await db.custodyPeriod.findUniqueOrThrow({
      where: { id: r.incomingPeriodId }, include: { participants: true, previousPeriod: true },
    });

    assert.equal(out.status, "TRANSFERRED", "the outgoing custody is closed, not left open");
    assert.ok(out.endedAt, "and stamped with when it ended");
    assert.equal(Number(out.closingCashAmount), 400);
    assert.equal(inc.status, "OPEN");
    assert.equal(inc.previousPeriod?.id, outgoing, "the chain records who handed to whom");
    assert.deepEqual(inc.participants.map((p) => p.userId), [userB]);
  });

  test("a transfer that throws leaves the outgoing custody open and creates no successor", async () => {
    // The window that must never be observable. If the close committed
    // separately from the open, a failure here would leave the branch with
    // no custodian and a shortage with nobody to attribute it to.
    await clearCustody();
    const { custodyPeriodId: outgoing } = await open("CASH", userA);
    const before = await db.custodyPeriod.count({ where: { branchId } });

    await assert.rejects(() =>
      db.$transaction(async (tx) => {
        await transferCustody(tx, {
          outgoingPeriodId: outgoing, scope: "CASH",
          incoming: { participants: [{ userId: userB, role: "PRIMARY" }], shiftId: null },
          actorId: userA,
        });
        throw new Error("deliberate rollback");
      })
    );

    const out = await db.custodyPeriod.findUniqueOrThrow({ where: { id: outgoing } });
    assert.equal(out.status, "OPEN", "the outgoing custodian is still answerable");
    assert.equal(out.endedAt, null);
    assert.equal(
      await db.custodyPeriod.count({ where: { branchId } }), before,
      "and no half-born successor exists"
    );
  });

  test("a second open custody of one scope at a branch is refused", async () => {
    await clearCustody();
    await open("STOCK");
    await assert.rejects(
      () => open("STOCK", userB),
      /عهدة|custody|already/i,
      "two open stock custodies would mean nobody is answerable"
    );
  });

  test("linking a second custody of the same scope to one shift is refused", async () => {
    await clearCustody();
    const first = await open("CASH", userA, { shiftId: shiftA });
    // A transferred period is a legitimate second row; the refusal must be
    // about the shift link, not about the period's existence.
    const spare = await db.custodyPeriod.create({
      data: { cafeId, branchId, scope: "CASH", status: "TRANSFERRED" },
    });

    await assert.rejects(
      () => db.$transaction((tx) =>
        linkShiftCustody(tx, { shiftId: shiftA, custodyPeriodId: spare.id, scope: "CASH" })
      ),
      (e: { code?: string; message?: string }) =>
        e.code === "P2002" || /عهدة|custody/i.test(e.message ?? ""),
      "one shift, one cash custody"
    );
    assert.ok(first.custodyPeriodId);
  });

  test("transferring cash leaves the stock custody exactly where it was", async () => {
    await clearCustody();
    const cash = await open("CASH", userA);
    const stock = await open("STOCK", userB);

    await db.$transaction((tx) =>
      transferCustody(tx, {
        outgoingPeriodId: cash.custodyPeriodId, scope: "CASH",
        incoming: { participants: [{ userId: userB, role: "PRIMARY" }], shiftId: null },
        actorId: userA,
      })
    );

    const stockAfter = await db.custodyPeriod.findUniqueOrThrow({
      where: { id: stock.custodyPeriodId }, include: { participants: true },
    });
    assert.equal(stockAfter.status, "OPEN", "the store room did not change hands");
    assert.equal(stockAfter.endedAt, null);
    assert.deepEqual(stockAfter.participants.map((p) => p.userId), [userB]);
    assert.equal(
      (await activeCustody(branchId, "STOCK"))?.id, stock.custodyPeriodId,
      "and it is still the active stock custody"
    );
  });

  test("the transfer is audited, naming both periods and the scope", async () => {
    await clearCustody();
    await db.auditLog.deleteMany({ where: { cafeId } });
    const { custodyPeriodId: outgoing } = await open("STOCK", userA);

    const r = await db.$transaction((tx) =>
      transferCustody(tx, {
        outgoingPeriodId: outgoing, scope: "STOCK",
        incoming: { participants: [{ userId: userB, role: "PRIMARY" }], shiftId: null },
        actorId: userA,
      })
    );

    const entry = await db.auditLog.findFirstOrThrow({
      where: { cafeId, action: "CUSTODY_TRANSFERRED" },
      orderBy: { createdAt: "desc" },
    });
    const details = entry.details as Record<string, unknown>;
    assert.equal(details.scope, "STOCK");
    assert.equal(details.outgoingPeriodId, r.outgoingPeriodId);
    assert.equal(details.incomingPeriodId, r.incomingPeriodId);
    assert.equal(entry.userId, userA, "and who performed it");
  });
});
