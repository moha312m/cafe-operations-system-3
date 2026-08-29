// COUNT-006 — let the business say how close is close enough.
//
// Precedence is ITEM → CATEGORY → BRANCH → CAFE: the narrowest configured
// rule wins, because that is the one somebody chose most deliberately. A café
// rule of 2% is a general statement; an item rule of 18 g on espresso beans
// is a specific one, and the specific one should not be overridden by the
// general.
//
// Two conservative readings are asserted here rather than assumed:
//
//   NO RULE means EXACT MATCH, not "anything goes". A café that has never
//   configured tolerance has not thereby permitted unlimited drift — it has
//   simply not spoken, and the safe reading of silence is zero.
//
//   BOTH SET means BOTH must be exceeded. A rule with quantity 0.5 kg AND
//   percent 2% describes a variance that is small in either sense being
//   acceptable, so exceeding only one of them is still within tolerance.
//   Treating it as "either exceeded" would make the rule stricter than
//   either bound alone, which nobody configuring it would expect.

import { test, after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { db, tag, teardownTaggedCafe } from "./helpers/db";
import type { Prisma } from "@prisma/client";
import {
  resolveStockTolerance, resolveTenderTolerance, resolveCashTolerance, withinTolerance,
} from "@/lib/tolerance";

const MARKER = tag("COUNT006");
let cafeId: string;
let branchId: string;
let otherBranchId: string;
let itemId: string;
let otherItemId: string;
const CATEGORY = "قهوة";

before(async () => {
  const cafe = await db.cafe.create({
    data: {
      name: `${MARKER} cafe`, slug: MARKER.toLowerCase(),
      settings: { create: {} },
      branches: { create: [{ name: `${MARKER} main` }, { name: `${MARKER} other` }] },
    },
    include: { branches: { orderBy: { name: "asc" } } },
  });
  cafeId = cafe.id;
  branchId = cafe.branches[0].id;
  otherBranchId = cafe.branches[1].id;

  const mkItem = async (name: string, category: string | null) =>
    (await db.inventoryItem.create({
      data: { cafeId, branchId, name: `${MARKER} ${name}`, unit: "KG", category, costPerUnit: 1 },
    })).id;
  itemId = await mkItem("beans", CATEGORY);
  otherItemId = await mkItem("milk", "ألبان");
});

after(() => teardownTaggedCafe(cafeId, [], { disconnect: true }));

const clearRules = () => db.toleranceRule.deleteMany({ where: { cafeId } });

type RuleInput = Omit<Prisma.ToleranceRuleUncheckedCreateInput, "cafeId">;

function rule(data: RuleInput) {
  return db.toleranceRule.create({ data: { cafeId, ...data } });
}

const forItem = () =>
  resolveStockTolerance({ cafeId, branchId, inventoryItemId: itemId, category: CATEGORY });

describe("COUNT-006 tolerance resolution", () => {
  test("no rule means exact match, and says so", async () => {
    await clearRules();
    const t = await forItem();
    assert.equal(t.scope, "NONE");
    assert.equal(t.ruleId, null);
    assert.equal(t.quantityTolerance, null);

    assert.equal(
      withinTolerance({ varianceQuantity: 0, tolerance: t }), true,
      "no variance is always within"
    );
    assert.equal(
      withinTolerance({ varianceQuantity: -0.001, tolerance: t }), false,
      "silence is not permission — a gram of drift is outside an unconfigured tolerance"
    );
  });

  test("a café rule applies when nothing narrower exists", async () => {
    await clearRules();
    const r = await rule({ scope: "CAFE", quantityTolerance: "1.000" });
    const t = await forItem();
    assert.equal(t.scope, "CAFE");
    assert.equal(t.ruleId, r.id);
    assert.equal(t.quantityTolerance, 1);
    assert.equal(withinTolerance({ varianceQuantity: -0.9, tolerance: t }), true);
    assert.equal(withinTolerance({ varianceQuantity: -1.1, tolerance: t }), false);
  });

  test("branch beats café, category beats branch, item beats category", async () => {
    // The whole precedence chain in one walk, each step tightening.
    await clearRules();
    await rule({ scope: "CAFE", quantityTolerance: "1.000" });
    assert.equal((await forItem()).scope, "CAFE");

    const branchRule = await rule({ scope: "BRANCH", branchId, quantityTolerance: "0.500" });
    let t = await forItem();
    assert.equal(t.scope, "BRANCH");
    assert.equal(t.ruleId, branchRule.id);
    assert.equal(t.quantityTolerance, 0.5);

    const catRule = await rule({ scope: "CATEGORY", category: CATEGORY, quantityTolerance: "0.250" });
    t = await forItem();
    assert.equal(t.scope, "CATEGORY");
    assert.equal(t.ruleId, catRule.id);

    const itemRule = await rule({ scope: "ITEM", inventoryItemId: itemId, quantityTolerance: "0.018" });
    t = await forItem();
    assert.equal(t.scope, "ITEM");
    assert.equal(t.ruleId, itemRule.id);
    assert.equal(
      t.quantityTolerance, 0.018,
      "the most deliberate statement wins over the most general"
    );
  });

  test("percent is evaluated against the expected quantity", async () => {
    await clearRules();
    await rule({ scope: "CAFE", percentTolerance: "2.00" });
    const t = await forItem();
    assert.equal(t.percentTolerance, 2);

    // 2% of 100 kg is 2 kg.
    assert.equal(
      withinTolerance({ varianceQuantity: -1.5, expectedQuantity: 100, tolerance: t }), true
    );
    assert.equal(
      withinTolerance({ varianceQuantity: -2.5, expectedQuantity: 100, tolerance: t }), false
    );
    // The same absolute variance against a smaller expectation is outside.
    assert.equal(
      withinTolerance({ varianceQuantity: -1.5, expectedQuantity: 10, tolerance: t }), false,
      "a percentage is meaningless without the figure it is a percentage of"
    );
  });

  test("when quantity and percent are both set, a variance must exceed both", async () => {
    await clearRules();
    await rule({ scope: "CAFE", quantityTolerance: "0.500", percentTolerance: "2.00" });
    const t = await forItem();

    // 2% of 100 = 2.0; quantity bound = 0.5.
    assert.equal(
      withinTolerance({ varianceQuantity: -1.0, expectedQuantity: 100, tolerance: t }), true,
      "over the quantity bound but under the percentage — still within"
    );
    assert.equal(
      withinTolerance({ varianceQuantity: -0.4, expectedQuantity: 5, tolerance: t }), true,
      "over the percentage but under the quantity bound — still within"
    );
    assert.equal(
      withinTolerance({ varianceQuantity: -3.0, expectedQuantity: 100, tolerance: t }), false,
      "over both — outside"
    );
  });

  test("an inactive rule falls through to the next widest", async () => {
    await clearRules();
    const cafeRule = await rule({ scope: "CAFE", quantityTolerance: "1.000" });
    await rule({ scope: "ITEM", inventoryItemId: itemId, quantityTolerance: "0.018", isActive: false });

    const t = await forItem();
    assert.equal(t.scope, "CAFE", "a switched-off rule is not a rule");
    assert.equal(t.ruleId, cafeRule.id);
  });

  test("a TENDER rule is never returned for stock, and cash resolves its own", async () => {
    // Different domains entirely: an EGP amount tolerance on card settlement
    // says nothing about how many grams of coffee may be missing.
    await clearRules();
    await rule({ scope: "TENDER", tenderMethod: "CARD", amountTolerance: "5.00" });
    const stock = await forItem();
    assert.equal(stock.scope, "NONE", "a tender rule must not leak into a stock decision");

    const card = await resolveTenderTolerance({ cafeId, branchId, method: "CARD" });
    assert.equal(card.scope, "TENDER");
    assert.equal(card.amountTolerance, 5);

    const wallet = await resolveTenderTolerance({ cafeId, branchId, method: "WALLET" });
    assert.equal(wallet.scope, "NONE", "a card rule does not govern a wallet");

    await rule({ scope: "TENDER", tenderMethod: "CASH", amountTolerance: "10.00" });
    const cash = await resolveCashTolerance({ cafeId, branchId });
    assert.equal(cash.scope, "TENDER");
    assert.equal(cash.amountTolerance, 10);
    assert.equal(
      withinTolerance({ varianceAmount: -8, tolerance: cash }), true,
      "cash is judged by amount"
    );
    assert.equal(withinTolerance({ varianceAmount: -12, tolerance: cash }), false);
  });

  test("another branch's rule never applies", async () => {
    await clearRules();
    await rule({ scope: "BRANCH", branchId: otherBranchId, quantityTolerance: "0.010" });
    const t = await forItem();
    assert.equal(
      t.scope, "NONE",
      "one branch's tolerance is not another's — the shelves and the staff differ"
    );
  });

  test("an ITEM rule for a different item never applies", async () => {
    await clearRules();
    await rule({ scope: "ITEM", inventoryItemId: otherItemId, quantityTolerance: "0.010" });
    const t = await forItem();
    assert.equal(t.scope, "NONE");

    const forOther = await resolveStockTolerance({
      cafeId, branchId, inventoryItemId: otherItemId, category: "ألبان",
    });
    assert.equal(forOther.scope, "ITEM", "and it does apply to its own item");
  });
});
