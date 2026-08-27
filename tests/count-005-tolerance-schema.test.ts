// COUNT-005 — rules for closeness, records for second looks.
//
// Three tables, one theme: the business decides what counts as a discrepancy,
// and every attempt to resolve one leaves its own record rather than
// overwriting what came before.
//
// ToleranceRule is scoped four ways for stock (CAFE, BRANCH, CATEGORY, ITEM)
// plus TENDER for card and wallet. Narrowest wins, which T15 resolves — this
// suite only asserts the rules can be stored at each scope with the right
// columns nullable.
//
// StockCountRecount is a record, not an update. A recount captures its OWN
// expected quantity at its OWN count point, because the shelf may have moved
// between the first count and the second: reusing the original expectation
// would measure the recount against a stale figure and manufacture a variance
// that never existed.
//
// StockCountCorrection defaults to PENDING_APPROVAL and requires a reason
// code — non-nullable, deliberately. A correction is somebody changing a
// recorded observation, which is exactly the act that most needs a stated
// reason and a second signature.

import { test, after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { db, tag, teardownTaggedCafe } from "./helpers/db";

const MARKER = tag("COUNT005");
let cafeId: string;
let branchId: string;
let userId: string;
let approverId: string;
let itemId: string;
let lineId: string;
let reasonCodeId: string;

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
        passwordHash: "no-login-path", role: "BRANCH_MANAGER", cafeId, branchId,
      },
    })).id;
  userId = await mk("counter");
  approverId = await mk("approver");

  itemId = (await db.inventoryItem.create({
    data: {
      cafeId, branchId, name: `${MARKER} beans`, unit: "KG",
      category: "قهوة", costPerUnit: 450, currentStock: "12.018",
    },
  })).id;

  const session = await db.stockCountSession.create({
    data: {
      cafeId, branchId, type: "FULL", scopeDerivation: "ALL_ELIGIBLE",
      initiatedById: userId,
    },
  });
  lineId = (await db.stockCountLine.create({
    data: {
      sessionId: session.id, inventoryItemId: itemId, unit: "KG",
      expectedQuantity: "12.018", countedQuantity: "11.500",
    },
  })).id;

  reasonCodeId = (await db.reasonCode.create({
    data: { cafeId, domain: "STOCK", code: `${MARKER}-MISCOUNT`, label: "خطأ في العد" },
  })).id;
});

// Three of the nine deletes this replaces named models that did not exist
// during the RED run, and the first of them was enough to abandon the other
// eight and strand the café. See TOOLING-003.
after(() => teardownTaggedCafe(cafeId, [], { disconnect: true }));

describe("COUNT-005 tolerance, recount and correction schema", () => {
  test("a rule persists at each of the five scopes, with the right columns filled", async () => {
    await db.toleranceRule.deleteMany({ where: { cafeId } });
    const made = await Promise.all([
      db.toleranceRule.create({
        data: { cafeId, scope: "CAFE", percentTolerance: "2.00" },
      }),
      db.toleranceRule.create({
        data: { cafeId, scope: "BRANCH", branchId, quantityTolerance: "0.500" },
      }),
      db.toleranceRule.create({
        data: { cafeId, scope: "CATEGORY", category: "قهوة", quantityTolerance: "0.250" },
      }),
      db.toleranceRule.create({
        data: { cafeId, scope: "ITEM", inventoryItemId: itemId, quantityTolerance: "0.018" },
      }),
      db.toleranceRule.create({
        data: { cafeId, scope: "TENDER", tenderMethod: "CARD", amountTolerance: "5.00" },
      }),
    ]);

    assert.equal(made.length, 5);
    const cafeRule = made[0];
    assert.equal(cafeRule.branchId, null, "a café rule names no branch");
    assert.equal(cafeRule.inventoryItemId, null);
    assert.equal(cafeRule.tenderMethod, null);
    assert.equal(Number(cafeRule.percentTolerance), 2);
    assert.equal(cafeRule.isActive, true, "a new rule is live");

    assert.equal(Number(made[3].quantityTolerance), 0.018, "an item rule holds gram precision");
    assert.equal(made[4].tenderMethod, "CARD");
    assert.equal(Number(made[4].amountTolerance), 5);
  });

  test("a recount stores its own expected quantity and its own count point", async () => {
    // The shelf may have moved between the two counts. Measuring a recount
    // against the ORIGINAL expectation would invent a variance that never
    // existed, so the recount captures its own.
    await db.stockCountRecount.deleteMany({ where: { lineId } });
    const r = await db.stockCountRecount.create({
      data: {
        lineId, attempt: 1, kind: "INDEPENDENT",
        countedQuantity: "11.900", expectedQuantity: "12.000",
        itemVersion: BigInt(88), varianceQuantity: "-0.100",
        counterId: userId,
      },
    });
    assert.equal(Number(r.expectedQuantity), 12, "its own expectation, not the line's");
    assert.equal(r.itemVersion, BigInt(88), "captured at its own count point");
    assert.equal(Number(r.varianceQuantity), -0.1);
    assert.equal(r.resolved, false, "a recount is evidence until something resolves it");
  });

  test("(lineId, attempt) rejects a duplicate recount attempt", async () => {
    await db.stockCountRecount.deleteMany({ where: { lineId } });
    const base = {
      lineId, attempt: 1, kind: "SELF_RECOUNT" as const,
      countedQuantity: "11.900", expectedQuantity: "12.000",
      itemVersion: BigInt(90), varianceQuantity: "-0.100", counterId: userId,
    };
    await db.stockCountRecount.create({ data: base });
    await assert.rejects(
      () => db.stockCountRecount.create({ data: base }),
      (e: { code?: string }) => e.code === "P2002",
      "attempt numbers must be distinct, or the attempt count means nothing"
    );

    const second = await db.stockCountRecount.create({
      data: { ...base, attempt: 2 },
    });
    assert.equal(second.attempt, 2, "a genuine second attempt is fine");
  });

  test("a correction defaults to PENDING_APPROVAL and is not post-custody by default", async () => {
    await db.stockCountCorrection.deleteMany({ where: { lineId } });
    const c = await db.stockCountCorrection.create({
      data: {
        lineId, oldCountedQuantity: "11.500", newCountedQuantity: "12.018",
        reasonCodeId, actorId: userId, note: "أعيد العد",
      },
    });
    assert.equal(
      c.status, "PENDING_APPROVAL",
      "changing a recorded observation waits for a second signature"
    );
    assert.equal(c.postCustodyTransfer, false);
    assert.equal(c.approvedById, null);
    assert.equal(Number(c.oldCountedQuantity), 11.5, "the superseded figure is kept");
    assert.equal(Number(c.newCountedQuantity), 12.018);

    const approved = await db.stockCountCorrection.update({
      where: { id: c.id },
      data: { status: "APPROVED", approvedById: approverId, approvedAt: new Date() },
    });
    assert.equal(approved.approvedById, approverId);
  });

  test("a correction cannot be recorded without a reason code", async () => {
    // Non-nullable on purpose. A correction is somebody altering recorded
    // evidence — the act that most needs a stated reason.
    const cols = await db.$queryRaw<{ is_nullable: string }[]>`
      SELECT is_nullable FROM information_schema.columns
       WHERE table_name = 'StockCountCorrection' AND column_name = 'reasonCodeId'
    `;
    assert.equal(cols[0]?.is_nullable, "NO", "reasonCodeId is required");

    await assert.rejects(
      () => db.stockCountCorrection.create({
        data: {
          lineId, oldCountedQuantity: "1.000", newCountedQuantity: "2.000",
          actorId: userId,
        } as never,
      }),
      "a correction with no stated reason must be refused"
    );
  });

  test("every relation resolves through Prisma rather than by loose id", async () => {
    await db.stockCountCorrection.deleteMany({ where: { lineId } });
    await db.stockCountRecount.deleteMany({ where: { lineId } });
    await db.stockCountRecount.create({
      data: {
        lineId, attempt: 1, kind: "INDEPENDENT",
        countedQuantity: "11.900", expectedQuantity: "12.000",
        itemVersion: BigInt(5), varianceQuantity: "-0.100", counterId: userId,
      },
    });
    const correction = await db.stockCountCorrection.create({
      data: {
        lineId, oldCountedQuantity: "11.500", newCountedQuantity: "12.018",
        reasonCodeId, actorId: userId, approvedById: approverId,
        status: "APPROVED", approvedAt: new Date(),
      },
    });

    const loaded = await db.stockCountCorrection.findUniqueOrThrow({
      where: { id: correction.id },
      include: { line: true, reasonCode: true, actor: true, approvedBy: true },
    });
    assert.equal(loaded.line.id, lineId);
    assert.equal(loaded.reasonCode.code, `${MARKER}-MISCOUNT`);
    assert.equal(loaded.actor.id, userId);
    assert.equal(loaded.approvedBy?.id, approverId);

    const line = await db.stockCountLine.findUniqueOrThrow({
      where: { id: lineId }, include: { recounts: true, corrections: true },
    });
    assert.equal(line.recounts.length, 1, "the line reaches its recounts");
    assert.equal(line.corrections.length, 1, "and its corrections");

    const rule = await db.toleranceRule.create({
      data: { cafeId, scope: "ITEM", inventoryItemId: itemId, quantityTolerance: "0.010" },
    });
    const loadedRule = await db.toleranceRule.findUniqueOrThrow({
      where: { id: rule.id }, include: { cafe: true, branch: true, inventoryItem: true },
    });
    assert.equal(loadedRule.cafe.id, cafeId);
    assert.equal(loadedRule.inventoryItem?.id, itemId);
    assert.equal(loadedRule.branch, null, "an item rule has no branch, and says so with null");
  });
});
