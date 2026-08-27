// COUNT-007 — CASH keeps its single source of truth, and MIXED never gets one.
//
// The tolerance table can express a rule scoped TENDER against any
// PaymentMethod, and PaymentMethod has four members. Two of them must not
// become reconciliation channels, for two different reasons that are easy to
// collapse into one and get half right.
//
// CASH is already reconciled. The Shift close records the counted drawer, the
// expected drawer and the difference, and every cash figure in the system
// reads that. A second cash actual/variance record in TenderReconciliation
// would be a competing answer rather than a cross-check — two rows free to
// disagree, with nothing saying which one an owner should believe. But cash
// still has a TOLERANCE: the bound the Shift close compares its difference
// against. So a TENDER/CASH tolerance rule is legitimate and a CASH channel
// is not, and the tests below hold those two apart on purpose.
//
// MIXED is not a settlement channel at all. It marks an order paid across
// more than one method, and each of those parts is already a Payment row
// under its own real method. A MIXED reconciliation would count the same
// money a second time under a label no processor ever settles — so MIXED is
// refused everywhere: no channel, and no tolerance rule either.
//
// The invariant is asserted at both levels it is enforced at. The service
// refusal is what an owner sees; the database constraint is what stops a
// seed, a script or a later migration walking around the service.
//
// The representation is the approved plan's, not a local choice. Revision 3
// fixes `enum ToleranceScope { CAFE BRANCH CATEGORY ITEM TENDER }` — there is
// no CASH scope — and states the resolver's contract as "`resolveCashTolerance`
// returns the `CASH`-method rule". So a cash tolerance IS a TENDER-scoped rule
// whose method is CASH, and the line this suite draws is between a tolerance
// (which cash has) and a reconciliation channel (which cash must not have,
// because T16 says "`Shift` stays the one place cash is reconciled"). Anyone
// tempted to add a CASH scope should change the plan first.

import { test, after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { db, tag, teardownTaggedCafe } from "./helpers/db";
import {
  ELECTRONIC_TENDER_METHODS, assertReconcilableTender, isElectronicTender,
} from "@/lib/tender";
import {
  assertValidToleranceRule, resolveCashTolerance, resolveTenderTolerance,
} from "@/lib/tolerance";

const MARKER = tag("COUNT007");
let cafeId: string;
let branchId: string;
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

  itemId = (await db.inventoryItem.create({
    data: {
      cafeId, branchId, name: `${MARKER} beans`, unit: "KG",
      costPerUnit: 450, currentStock: "12.000",
    },
  })).id;
});

after(() => teardownTaggedCafe(cafeId, [], { disconnect: true }));

describe("COUNT-007 tender channels", () => {
  test("only CARD and WALLET are settlement channels", () => {
    assert.deepEqual(
      [...ELECTRONIC_TENDER_METHODS], ["CARD", "WALLET"],
      "the channel list is stated once so CASH and MIXED cannot creep back in"
    );
    assert.equal(isElectronicTender("CARD"), true);
    assert.equal(isElectronicTender("WALLET"), true);
    assert.equal(isElectronicTender("CASH"), false, "cash settles in the drawer");
    assert.equal(isElectronicTender("MIXED"), false, "mixed settles nowhere");
  });

  test("CASH is refused a channel, and the refusal says why", () => {
    assert.throws(
      () => assertReconcilableTender("CASH"),
      /Shift cash close/,
      "the refusal must point at the record that already holds the answer"
    );
  });

  test("MIXED is refused a channel, and the refusal says why", () => {
    assert.throws(
      () => assertReconcilableTender("MIXED"),
      /split-payment marker|same money twice/,
      "the refusal must explain the double count, not just deny"
    );
  });

  test("CARD and WALLET pass through unchanged", () => {
    assert.equal(assertReconcilableTender("CARD"), "CARD");
    assert.equal(assertReconcilableTender("WALLET"), "WALLET");
  });

  test("cash keeps its tolerance even though it has no channel", async () => {
    // The distinction the whole suite turns on. Refusing CASH a channel must
    // not also strip the Shift close of the bound it compares against.
    await db.toleranceRule.deleteMany({ where: { cafeId } });
    await db.toleranceRule.create({
      data: { cafeId, scope: "TENDER", tenderMethod: "CASH", amountTolerance: "3.00" },
    });

    const cash = await resolveCashTolerance({ cafeId, branchId });
    assert.equal(cash.scope, "TENDER", "the cash bound resolves");
    assert.equal(cash.amountTolerance, 3, "and carries the configured figure");

    assert.doesNotThrow(
      () => assertValidToleranceRule({ scope: "TENDER", tenderMethod: "CASH" }),
      "a cash tolerance rule is legitimate configuration"
    );
    assert.throws(
      () => assertReconcilableTender("CASH"),
      "…while a cash channel is still refused"
    );
  });

  test("a MIXED tolerance rule is refused by the service", () => {
    assert.throws(
      () => assertValidToleranceRule({ scope: "TENDER", tenderMethod: "MIXED" }),
      /MIXED/,
      "MIXED has no tolerance because it has nothing of its own to settle"
    );
  });

  test("resolving a MIXED tolerance is refused rather than answered emptily", async () => {
    // Returning "no rule configured" would be a plausible-looking answer to a
    // question that should never have been asked, and a caller reading it as
    // exact-match would have built a MIXED channel without noticing.
    await assert.rejects(
      () => resolveTenderTolerance({ cafeId, branchId, method: "MIXED" }),
      /MIXED/
    );
  });

  test("a TENDER rule with no method, and a stock rule with one, are both refused", () => {
    assert.throws(
      () => assertValidToleranceRule({ scope: "TENDER", tenderMethod: null }),
      /must name a tender method/
    );
    assert.throws(
      () => assertValidToleranceRule({ scope: "ITEM", tenderMethod: "CARD" }),
      /governs stock/,
      "an EGP card bound says nothing about how many grams are missing"
    );
  });

  test("the database refuses a MIXED tender rule even past the service", async () => {
    // The service check is what an owner sees; this is what stops a seed
    // script, a data fix or a later migration from writing the row anyway.
    await assert.rejects(
      () => db.toleranceRule.create({
        data: { cafeId, scope: "TENDER", tenderMethod: "MIXED", amountTolerance: "5.00" },
      }),
      /ToleranceRule_tender_scope_method_valid|constraint/i,
      "the check constraint must reject MIXED at the table"
    );
  });

  test("the database refuses a TENDER rule with no method", async () => {
    await assert.rejects(
      () => db.toleranceRule.create({
        data: { cafeId, scope: "TENDER", amountTolerance: "5.00" },
      }),
      /ToleranceRule_tender_scope_method_valid|constraint/i
    );
  });

  test("the database refuses a stock-scoped rule that names a tender method", async () => {
    await assert.rejects(
      () => db.toleranceRule.create({
        data: {
          cafeId, scope: "ITEM", inventoryItemId: itemId,
          tenderMethod: "CARD", quantityTolerance: "0.010",
        },
      }),
      /ToleranceRule_tender_scope_method_valid|constraint/i
    );
  });

  test("the legitimate combinations still write", async () => {
    // A constraint that refuses everything is not an invariant, it is an
    // outage. Both shapes the schema is meant to allow are exercised here.
    await db.toleranceRule.deleteMany({ where: { cafeId } });
    const card = await db.toleranceRule.create({
      data: { cafeId, scope: "TENDER", tenderMethod: "CARD", amountTolerance: "5.00" },
    });
    const item = await db.toleranceRule.create({
      data: { cafeId, scope: "ITEM", inventoryItemId: itemId, quantityTolerance: "0.018" },
    });

    assert.equal(card.tenderMethod, "CARD");
    assert.equal(item.tenderMethod, null, "a stock rule names no method, and says so with null");
  });

  test("TenderReconciliation exists and inherited these refusals rather than re-deciding", async () => {
    // This test used to assert the model was absent, as a tripwire for the
    // task that would build it. T16 built it, so the tripwire is spent and
    // the claim becomes the one it was guarding: the new table refuses the
    // same two methods this suite refuses, at the database level.
    const delegates = db as unknown as Record<string, unknown>;
    assert.notEqual(delegates.tenderReconciliation, undefined, "T16 has landed");

    const check = await db.$queryRaw<{ definition: string }[]>`
      SELECT pg_get_constraintdef(oid) AS definition
        FROM pg_constraint
       WHERE conname = 'TenderReconciliation_no_cash_check'
    `;
    assert.equal(check.length, 1, "the channel restriction is a constraint, not a comment");
    assert.match(check[0].definition, /CARD/);
    assert.match(check[0].definition, /WALLET/);
    assert.doesNotMatch(check[0].definition, /'CASH'/, "CASH is not an allowed channel");
    assert.doesNotMatch(check[0].definition, /'MIXED'/, "and neither is MIXED");
  });
});
