// VAR-004 — judge the whole gap since the last count, and cost nothing we
// cannot price.
//
// Two mistakes this module exists to prevent, both of which look reasonable
// until you follow them through.
//
// THE WINDOW. An earlier revision rolled confidence over "the orders served
// under this shift". Stock does not work that way. It drifts across every
// shift since the last physical count, so a shortage found this evening may
// have been created by an unmapped add-on three shifts ago. Judging only
// today's orders would find them all well-mapped, report VERIFIED, and hand
// somebody a confident number built on a gap nobody examined. The window
// therefore runs from the last TRUSTED BASELINE — the `confirmedAt` of the
// most recent CONFIRMED or LOCKED count covering that item at that branch, or
// the item's own `createdAt` when there has never been one — up to the moment
// this line was counted. It is stored on the line so the judgement can be
// reproduced later rather than re-derived from a menu that has since changed.
//
// THE ZERO. A missing cost is not a cost of zero. `stockCostImpact` returns
// `{ available: false }` when the ingredient has no usable price AND when
// confidence is anything but VERIFIED — and there is no path through it that
// returns `{ available: true, value: 0 }` for something it could not price.
// The tests below assert that as a property over every input, not just on the
// two cases that happen to be interesting.
//
// And the consequence that matters most: PARTIAL or UNVERIFIABLE evidence
// must never quietly become somebody's fault. `mayAssignResponsibility` is
// true for VERIFIED alone, and `advanceVarianceCase` refuses to move a case
// to RESPONSIBILITY_ASSIGNED without it.

import { test, after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { db, tag, teardownTaggedCafe } from "./helpers/db";
import { RecipeIssue } from "@/lib/costing";
import { recipeFingerprint } from "@/lib/recipes";
import { advanceVarianceCase, openVarianceCase } from "@/lib/variance-case";
import {
  confidenceForCountedItem, lastTrustedBaselineAt, mayAssignResponsibility, stockCostImpact,
} from "@/lib/variance-confidence";

const MARKER = tag("VAR004");
let cafeId: string;
let branchId: string;
let openerId: string;
let staffId: string;
let itemId: string;
let freshItemId: string;
let categoryId: string;
let lineId: string;
/** A branch with no active count, so the unconfirmed-baseline test can open one. */
let quietBranchId: string;

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
  quietBranchId = (await db.branch.create({
    data: { cafeId, name: `${MARKER} quiet` },
  })).id;

  const mk = async (suffix: string, role: "CASHIER" | "BRANCH_MANAGER") =>
    (await db.user.create({
      data: {
        email: `${MARKER}-${suffix}@example.invalid`, name: `${MARKER}-${suffix}`,
        passwordHash: "no-login-path", role, cafeId, branchId,
      },
    })).id;
  openerId = await mk("opener", "BRANCH_MANAGER");
  staffId = await mk("staff", "CASHIER");

  categoryId = (await db.menuCategory.create({
    data: { cafeId, name: `${MARKER} drinks` },
  })).id;

  itemId = (await db.inventoryItem.create({
    data: {
      cafeId, branchId, name: `${MARKER} beans`, unit: "KG",
      costPerUnit: 450, currentStock: "12.000",
    },
  })).id;
  freshItemId = (await db.inventoryItem.create({
    data: {
      cafeId, branchId, name: `${MARKER} syrup`, unit: "LITER",
      costPerUnit: 60, currentStock: "5.000",
    },
  })).id;

  const sessionId = (await db.stockCountSession.create({
    data: {
      cafeId, branchId, type: "FULL", scopeDerivation: "ALL_ELIGIBLE",
      initiatedById: openerId,
    },
  })).id;
  lineId = (await db.stockCountLine.create({
    data: {
      sessionId, inventoryItemId: itemId, unit: "KG",
      expectedQuantity: "12.000", countedQuantity: "11.500", varianceQuantity: "-0.500",
    },
  })).id;
});

after(() =>
  teardownTaggedCafe(cafeId, [
    () => db.menuCategory.deleteMany({ where: { cafeId } }),
  ], { disconnect: true })
);

const clearCases = async () => {
  await db.shift.updateMany({ where: { cafeId }, data: { cashVarianceCaseId: null } });
  await db.varianceCase.deleteMany({ where: { cafeId } });
};

describe("VAR-004 cost trust and baseline-window confidence", () => {
  test("a cost of zero is a missing cost, not a free shortage", async () => {
    const r = stockCostImpact({
      varianceQuantity: -0.5, costPerUnit: 0, confidence: "VERIFIED",
    });
    assert.equal(r.available, false);
    assert.equal(r.available === false && r.reason, "MISSING_COST");
  });

  test("a null cost is a missing cost too", async () => {
    const r = stockCostImpact({
      varianceQuantity: -0.5, costPerUnit: null, confidence: "VERIFIED",
    });
    assert.equal(r.available, false);
    assert.equal(r.available === false && r.reason, "MISSING_COST");
  });

  test("no input at all produces a priced zero for something unpriceable", async () => {
    // The property, over a grid rather than over the two cases that happen to
    // be interesting. Spec §12 says a missing cost must never read as 0 EGP,
    // and the only way to be sure is to try every shape that could produce it.
    const confidences = ["VERIFIED", "PARTIAL", "UNVERIFIABLE"] as const;
    const costs = [null, 0, -1, -0.0001];
    const variances = [0, -0.5, 0.5, -1000, 1e-9];

    for (const confidence of confidences) {
      for (const costPerUnit of costs) {
        for (const varianceQuantity of variances) {
          const r = stockCostImpact({ varianceQuantity, costPerUnit, confidence });
          assert.equal(
            r.available, false,
            `an unusable cost (${costPerUnit}) must never be priced`
          );
          assert.equal(
            "value" in r, false,
            `no unavailable result may carry a number — ${confidence}/${costPerUnit}/${varianceQuantity}`
          );
        }
      }
    }
  });

  test("a trustworthy cost with VERIFIED confidence prices the variance", async () => {
    const r = stockCostImpact({
      varianceQuantity: -0.5, costPerUnit: 450, confidence: "VERIFIED",
    });
    assert.equal(r.available, true);
    assert.equal(r.available === true && r.value, 225, "|variance| × cost, rounded to money");

    const surplus = stockCostImpact({
      varianceQuantity: 0.5, costPerUnit: 450, confidence: "VERIFIED",
    });
    assert.equal(
      surplus.available === true && surplus.value, 225,
      "a surplus has an impact too — sign is not the question"
    );

    const rounded = stockCostImpact({
      varianceQuantity: -0.333, costPerUnit: 10.01, confidence: "VERIFIED",
    });
    assert.equal(rounded.available === true && rounded.value, 3.33, "money is two places");
  });

  test("a trustworthy cost with PARTIAL confidence is still not priced", async () => {
    // The cost is knowable; the consumption it would be measured against is
    // not. Pricing it anyway would produce a confident figure resting on a
    // gap nobody examined.
    const partial = stockCostImpact({
      varianceQuantity: -0.5, costPerUnit: 450, confidence: "PARTIAL",
    });
    assert.equal(partial.available, false);
    assert.equal(partial.available === false && partial.reason, "CONFIDENCE_NOT_VERIFIED");

    const unverifiable = stockCostImpact({
      varianceQuantity: -0.5, costPerUnit: 450, confidence: "UNVERIFIABLE",
    });
    assert.equal(unverifiable.available === false && unverifiable.reason, "CONFIDENCE_NOT_VERIFIED");
  });

  test("a genuine zero variance with a real cost is priced at zero", async () => {
    // The other side of the rule: zero IS expressible when it is the true
    // answer, and says so with available: true.
    const r = stockCostImpact({
      varianceQuantity: 0, costPerUnit: 450, confidence: "VERIFIED",
    });
    assert.equal(r.available, true);
    assert.equal(r.available === true && r.value, 0, "nothing missing, and we know it");
  });

  test("the baseline is the most recent CONFIRMED count's confirmedAt", async () => {
    const old = new Date("2026-08-01T10:00:00Z");
    const recent = new Date("2026-08-20T10:00:00Z");
    const mkSession = async (confirmedAt: Date, status: "CONFIRMED" | "LOCKED") =>
      (await db.stockCountSession.create({
        data: {
          cafeId, branchId, type: "FULL", scopeDerivation: "ALL_ELIGIBLE",
          initiatedById: openerId, status, confirmedAt,
          lines: {
            create: [{
              inventoryItemId: itemId, unit: "KG",
              countedQuantity: "12.000", countedAt: confirmedAt,
            }],
          },
        },
      })).id;

    await mkSession(old, "CONFIRMED");
    const recentId = await mkSession(recent, "CONFIRMED");

    const baseline = await lastTrustedBaselineAt({
      branchId, inventoryItemId: itemId, before: new Date("2026-08-25T00:00:00Z"),
    });
    assert.equal(baseline.at.toISOString(), recent.toISOString(), "the most recent one wins");
    assert.equal(baseline.sessionId, recentId, "and says which count it trusted");
  });

  test("a LOCKED count is a baseline too", async () => {
    const locked = new Date("2026-08-22T10:00:00Z");
    const lockedId = (await db.stockCountSession.create({
      data: {
        cafeId, branchId, type: "FULL", scopeDerivation: "ALL_ELIGIBLE",
        initiatedById: openerId, status: "LOCKED", confirmedAt: locked,
        lines: {
          create: [{
            inventoryItemId: itemId, unit: "KG",
            countedQuantity: "12.000", countedAt: locked,
          }],
        },
      },
    })).id;

    const baseline = await lastTrustedBaselineAt({
      branchId, inventoryItemId: itemId, before: new Date("2026-08-25T00:00:00Z"),
    });
    assert.equal(baseline.sessionId, lockedId, "locked by a handover is still counted and trusted");
    assert.equal(baseline.at.toISOString(), locked.toISOString());
  });

  test("with no prior count the baseline is the item's own createdAt", async () => {
    // Not the epoch, and not "now". An item that has never been counted has
    // been drifting since it existed, and that is exactly the window to judge.
    const item = await db.inventoryItem.findUniqueOrThrow({ where: { id: freshItemId } });
    const baseline = await lastTrustedBaselineAt({
      branchId, inventoryItemId: freshItemId, before: new Date(),
    });
    assert.equal(baseline.at.toISOString(), item.createdAt.toISOString());
    assert.equal(baseline.sessionId, null, "and there is no session to name");
  });

  test("a DRAFT or SUBMITTED count is not a baseline", async () => {
    // Only a count somebody confirmed can be trusted as a starting point.
    // Treating an unconfirmed one as a baseline would shorten the window on
    // the strength of a count still being argued about.
    // One at a time, and on a branch with no live count: T12 permits a single
    // active session per branch, so opening four together — or one beside the
    // fixture's own DRAFT — would fail for a reason that has nothing to do
    // with what this test is about.
    const item = await db.inventoryItem.findUniqueOrThrow({ where: { id: freshItemId } });
    for (const status of ["DRAFT", "SUBMITTED", "IN_PROGRESS", "RECOUNT_REQUIRED"] as const) {
      const session = await db.stockCountSession.create({
        data: {
          cafeId, branchId: quietBranchId, type: "FULL", scopeDerivation: "ALL_ELIGIBLE",
          initiatedById: openerId, status,
          // Deliberately stamped as though it had been confirmed: the status
          // is what decides trust, not the presence of a timestamp.
          confirmedAt: new Date(),
          lines: {
            create: [{
              inventoryItemId: freshItemId, unit: "LITER", countedQuantity: "5.000",
            }],
          },
        },
      });

      const baseline = await lastTrustedBaselineAt({
        branchId: quietBranchId, inventoryItemId: freshItemId, before: new Date(),
      });
      assert.equal(
        baseline.sessionId, null,
        `a ${status} count must not shorten the window`
      );
      assert.equal(baseline.at.toISOString(), item.createdAt.toISOString());

      await db.stockCountLine.deleteMany({ where: { sessionId: session.id } });
      await db.stockCountSession.delete({ where: { id: session.id } });
    }
  });

  test("an unmapped add-on sold outside this shift, inside the window, yields PARTIAL", async () => {
    // The heart of it. A shift-scoped roll-up would examine today's orders,
    // find them clean, and report VERIFIED — while the gap that actually
    // caused the shortage sat two shifts back.
    const product = await db.product.create({
      data: { cafeId, categoryId, name: `${MARKER} latte`, basePrice: 75 },
    });
    // A recipe is verified only when its stored fingerprint still matches its
    // contents — a `verifiedAt` on its own means nothing, which is the point
    // of the fingerprint. Setting it the way the recipe suites do is what
    // makes this configuration genuinely eligible, so the PARTIAL below is
    // caused by the add-on rather than by a fixture that was never verified.
    const recipe = await db.recipe.create({
      data: {
        cafeId, productId: product.id,
        items: { create: [{ inventoryItemId: itemId, quantity: "0.018", unit: "KG" }] },
      },
      include: { items: { include: { inventoryItem: true } } },
    });
    await db.recipe.update({
      where: { id: recipe.id },
      data: {
        verifiedById: openerId,
        verifiedAt: new Date(),
        verifiedFingerprint: recipeFingerprint(recipe.items),
      },
    });
    // An add-on with no recipe at all: the unmapped configuration.
    const addOn = await db.addOn.create({
      data: { cafeId, name: `${MARKER} vanilla`, price: 10 },
    });

    const windowFrom = new Date("2026-08-01T00:00:00Z");
    const longAgo = new Date("2026-08-05T12:00:00Z");   // inside window, not today
    const countedAt = new Date("2026-08-25T12:00:00Z");

    // A clean sale of the SAME product without the add-on, so the window
    // holds one eligible configuration and one that is not. Without it the
    // honest verdict would be UNVERIFIABLE — nothing was verifiable at all —
    // and the test would prove far less than it looks like it does: PARTIAL
    // is specifically the claim that ONE unmapped configuration taints a
    // window otherwise full of good ones.
    const clean = await db.order.create({
      data: {
        cafeId, branchId, orderNumber: 900000, type: "TAKEAWAY", status: "SERVED",
        source: "CASHIER_POS", customerName: MARKER,
        subtotal: 75, taxAmount: 0, discountAmount: 0, serviceChargeAmount: 0,
        total: 75, remainingAmount: 0, paymentStatus: "PAID",
        createdById: staffId, createdAt: longAgo,
        items: {
          create: [{
            productId: product.id, productName: product.name,
            unitPrice: 75, quantity: 1, lineTotal: 75,
          }],
        },
      },
    });

    const order = await db.order.create({
      data: {
        cafeId, branchId, orderNumber: 900001, type: "TAKEAWAY", status: "SERVED",
        source: "CASHIER_POS", customerName: MARKER,
        subtotal: 85, taxAmount: 0, discountAmount: 0, serviceChargeAmount: 0,
        total: 85, remainingAmount: 0, paymentStatus: "PAID",
        createdById: staffId, createdAt: longAgo,
        items: {
          create: [{
            productId: product.id, productName: product.name,
            unitPrice: 85, quantity: 1, lineTotal: 85,
            addOns: { create: [{ addOnId: addOn.id, addOnName: addOn.name, price: 10 }] },
          }],
        },
      },
    });

    const result = await confidenceForCountedItem({
      cafeId, branchId, inventoryItemId: itemId, windowFrom, countedAt,
    });
    assert.notEqual(
      result.confidence, "VERIFIED",
      "an unmapped add-on three shifts ago still taints today's judgement"
    );
    assert.equal(result.confidence, "PARTIAL", "some configurations were eligible, not all");
    assert.ok(
      result.issues.includes(RecipeIssue.MISSING_ADDON_RECIPE),
      "and it says which gap it found"
    );
    assert.ok(result.ordersExamined >= 1, "the old order was inside the window and examined");

    // And the control: the same window without the tainted sale is VERIFIED,
    // so PARTIAL above was caused by the add-on and not by the fixture.
    await db.order.delete({ where: { id: order.id } });
    const withoutTaint = await confidenceForCountedItem({
      cafeId, branchId, inventoryItemId: itemId, windowFrom, countedAt,
    });
    assert.equal(
      withoutTaint.confidence, "VERIFIED",
      "remove the unmapped add-on and the same window is trustworthy"
    );

    await db.order.delete({ where: { id: clean.id } });
  });

  test("orders before the window are excluded, proven by ordersExamined", async () => {
    const product = await db.product.findFirstOrThrow({
      where: { cafeId }, orderBy: { createdAt: "asc" },
    });
    const beforeWindow = new Date("2026-07-01T12:00:00Z");
    const order = await db.order.create({
      data: {
        cafeId, branchId, orderNumber: 900002, type: "TAKEAWAY", status: "SERVED",
        source: "CASHIER_POS", customerName: MARKER,
        subtotal: 75, taxAmount: 0, discountAmount: 0, serviceChargeAmount: 0,
        total: 75, remainingAmount: 0, paymentStatus: "PAID",
        createdById: staffId, createdAt: beforeWindow,
        items: {
          create: [{
            productId: product.id, productName: product.name,
            unitPrice: 75, quantity: 1, lineTotal: 75,
          }],
        },
      },
    });

    const wide = await confidenceForCountedItem({
      cafeId, branchId, inventoryItemId: itemId,
      windowFrom: new Date("2026-06-01T00:00:00Z"),
      countedAt: new Date("2026-08-25T12:00:00Z"),
    });
    const narrow = await confidenceForCountedItem({
      cafeId, branchId, inventoryItemId: itemId,
      windowFrom: new Date("2026-08-01T00:00:00Z"),
      countedAt: new Date("2026-08-25T12:00:00Z"),
    });

    assert.ok(
      wide.ordersExamined > narrow.ordersExamined,
      `the wider window examined more orders (${wide.ordersExamined} vs ${narrow.ordersExamined})`
    );

    await db.order.delete({ where: { id: order.id } });
  });

  test("mayAssignResponsibility is true only for VERIFIED", () => {
    assert.equal(mayAssignResponsibility("VERIFIED"), true);
    assert.equal(mayAssignResponsibility("PARTIAL"), false);
    assert.equal(mayAssignResponsibility("UNVERIFIABLE"), false);
  });

  test("a PARTIAL case cannot be moved to RESPONSIBILITY_ASSIGNED", async () => {
    // The whole point of judging confidence. Evidence nobody could verify
    // must never quietly become somebody's fault — and the refusal must
    // leave the field null rather than assigning and then complaining.
    await clearCases();
    const { caseId } = await db.$transaction((tx) =>
      openVarianceCase(tx, {
        cafeId, branchId, type: "STOCK", openedById: openerId,
        source: { kind: "STOCK_LINE", stockCountLineId: lineId },
        quantityVariance: -0.5, confidence: "PARTIAL",
        financialImpact: { available: false, reason: "CONFIDENCE_NOT_VERIFIED" },
      })
    );
    await advanceVarianceCase({ caseId, to: "UNDER_INVESTIGATION", actorId: openerId });

    await assert.rejects(
      () => advanceVarianceCase({
        caseId, to: "RESPONSIBILITY_ASSIGNED", actorId: openerId,
        assignedResponsibilityUserId: staffId,
      }),
      (e: { status?: number }) => e.status === 400,
      "partial evidence is not grounds for holding somebody responsible"
    );

    const still = await db.varianceCase.findUniqueOrThrow({ where: { id: caseId } });
    assert.equal(
      still.assignedResponsibilityUserId, null,
      "and nobody was named on the way to the refusal"
    );
    assert.equal(still.status, "UNDER_INVESTIGATION", "the case did not move");
  });

  test("a VERIFIED case can be moved to RESPONSIBILITY_ASSIGNED", async () => {
    // The permissive half — a guard that refused everything would just be an
    // outage with a principled comment above it.
    await clearCases();
    const { caseId } = await db.$transaction((tx) =>
      openVarianceCase(tx, {
        cafeId, branchId, type: "STOCK", openedById: openerId,
        source: { kind: "STOCK_LINE", stockCountLineId: lineId },
        quantityVariance: -0.5, confidence: "VERIFIED",
        financialImpact: { available: true, value: 225 },
      })
    );
    await advanceVarianceCase({ caseId, to: "UNDER_INVESTIGATION", actorId: openerId });
    const assigned = await advanceVarianceCase({
      caseId, to: "RESPONSIBILITY_ASSIGNED", actorId: openerId,
      assignedResponsibilityUserId: staffId,
    });
    assert.equal(assigned.status, "RESPONSIBILITY_ASSIGNED");

    const c = await db.varianceCase.findUniqueOrThrow({
      where: { id: caseId }, include: { assignedResponsibility: true },
    });
    assert.equal(c.assignedResponsibility?.id, staffId);
  });

  test("assigning responsibility still creates no money owed by anybody", async () => {
    // Responsibility is an investigation outcome. It is not a deduction, and
    // this milestone has nowhere to put one — asserted rather than assumed.
    await clearCases();
    const { caseId } = await db.$transaction((tx) =>
      openVarianceCase(tx, {
        cafeId, branchId, type: "STOCK", openedById: openerId,
        source: { kind: "STOCK_LINE", stockCountLineId: lineId },
        quantityVariance: -0.5, confidence: "VERIFIED",
        financialImpact: { available: true, value: 225 },
      })
    );
    await advanceVarianceCase({ caseId, to: "UNDER_INVESTIGATION", actorId: openerId });
    await advanceVarianceCase({
      caseId, to: "RESPONSIBILITY_ASSIGNED", actorId: openerId,
      assignedResponsibilityUserId: staffId,
    });

    const payrollish = await db.$queryRaw<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
       WHERE table_schema = current_schema()
         AND (table_name ILIKE '%payroll%' OR table_name ILIKE '%salary%'
              OR table_name ILIKE '%deduction%' OR table_name ILIKE '%liability%')
    `;
    assert.deepEqual(payrollish, [], "there is no payroll surface for this to have touched");

    const staff = await db.user.findUniqueOrThrow({ where: { id: staffId } });
    assert.equal(staff.isActive, true, "and the named person's account is untouched");
  });
});
