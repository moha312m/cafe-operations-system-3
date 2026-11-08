import test from "node:test";
import assert from "node:assert/strict";
import { getDefaultParentId, suggestNextCode } from "@/components/accounting/chart-setup-dialogs";
import type { ChartRow } from "@/lib/accounting/chart-view";

function makeRow(partial: Partial<ChartRow>): ChartRow {
  return {
    id: partial.id ?? "id-" + Math.random(),
    code: partial.code ?? "1000",
    name: partial.name ?? "Test",
    type: partial.type ?? "EXPENSE",
    normalBalance: partial.normalBalance ?? "DEBIT",
    systemKey: partial.systemKey ?? null,
    isPostable: partial.isPostable ?? false,
    isActive: partial.isActive ?? true,
    parentId: partial.parentId ?? null,
    parentCode: partial.parentCode ?? null,
    parentName: partial.parentName ?? null,
    depth: partial.depth ?? 0,
    childCount: partial.childCount ?? 0,
    matched: partial.matched ?? true,
    ledgerEligible: partial.ledgerEligible ?? false,
  };
}

test("getDefaultParentId: EXPENSE prefers 5400, then 5000, then root", () => {
  const h5000 = makeRow({ id: "id-5000", code: "5000", name: "التكاليف والمصروفات", type: "EXPENSE", isPostable: false });
  const h5400 = makeRow({ id: "id-5400", code: "5400", name: "مصروفات التشغيل", type: "EXPENSE", isPostable: false, parentId: "id-5000" });

  // Both present: prefers 5400
  assert.equal(getDefaultParentId("EXPENSE", [h5000, h5400]), "id-5400");

  // Only 5000 present: selects 5000
  assert.equal(getDefaultParentId("EXPENSE", [h5000]), "id-5000");

  // Custom root header: selects root
  const hCustom = makeRow({ id: "id-custom", code: "5999", name: "مصروفات خاصة", type: "EXPENSE", isPostable: false, parentId: null });
  assert.equal(getDefaultParentId("EXPENSE", [hCustom]), "id-custom");

  // Empty headers list: returns ""
  assert.equal(getDefaultParentId("EXPENSE", []), "");
});

test("getDefaultParentId: ASSET, LIABILITY, EQUITY, REVENUE standard headers", () => {
  const h1000 = makeRow({ id: "id-1000", code: "1000", name: "الأصول", type: "ASSET", isPostable: false });
  const h2000 = makeRow({ id: "id-2000", code: "2000", name: "الخصوم", type: "LIABILITY", isPostable: false });
  const h3000 = makeRow({ id: "id-3000", code: "3000", name: "حقوق الملكية", type: "EQUITY", isPostable: false });
  const h4000 = makeRow({ id: "id-4000", code: "4000", name: "الإيرادات", type: "REVENUE", isPostable: false });

  const all = [h1000, h2000, h3000, h4000];

  assert.equal(getDefaultParentId("ASSET", all), "id-1000");
  assert.equal(getDefaultParentId("LIABILITY", all), "id-2000");
  assert.equal(getDefaultParentId("EQUITY", all), "id-3000");
  assert.equal(getDefaultParentId("REVENUE", all), "id-4000");
});

test("suggestNextCode: suggests next available 4-digit code per type", () => {
  const existingRows = [
    makeRow({ code: "5000", type: "EXPENSE" }),
    makeRow({ code: "5100", type: "EXPENSE" }),
    makeRow({ code: "5410", type: "EXPENSE" }),
    makeRow({ code: "1000", type: "ASSET" }),
    makeRow({ code: "1100", type: "ASSET" }),
    makeRow({ code: "2000", type: "LIABILITY" }),
  ];

  // For EXPENSE with 5410 taken, suggests 5420
  const nextExpense = suggestNextCode("EXPENSE", existingRows);
  assert.equal(nextExpense, "5420");

  // For ASSET with 1100 taken, suggests 1110 (or next free)
  const nextAsset = suggestNextCode("ASSET", existingRows);
  assert.equal(nextAsset, "1110");

  // For LIABILITY with 2000 taken, suggests 2100
  const nextLiability = suggestNextCode("LIABILITY", existingRows);
  assert.equal(nextLiability, "2100");

  // For REVENUE empty, suggests 4100
  const nextRevenue = suggestNextCode("REVENUE", existingRows);
  assert.equal(nextRevenue, "4100");
});

test("getDefaultParentId: edge cases and cross-type header lists", () => {
  // Only ASSET headers present when asking for EXPENSE
  const h1000 = makeRow({ id: "id-1000", code: "1000", name: "الأصول", type: "ASSET", isPostable: false });
  assert.equal(getDefaultParentId("EXPENSE", [h1000]), "");

  // Multiple non-standard headers: picks root header (parentId === null)
  const hRoot = makeRow({ id: "id-root", code: "5800", name: "مصروفات عامة", type: "EXPENSE", isPostable: false, parentId: null });
  const hChild = makeRow({ id: "id-child", code: "5810", name: "مصروفات فرعية", type: "EXPENSE", isPostable: false, parentId: "id-root" });
  assert.equal(getDefaultParentId("EXPENSE", [hChild, hRoot]), "id-root");

  // When all headers have a parent (no root), falls back to first matching
  const hOrphan = makeRow({ id: "id-orphan", code: "5820", name: "مجموعة يتيمة", type: "EXPENSE", isPostable: false, parentId: "missing-parent" });
  assert.equal(getDefaultParentId("EXPENSE", [hOrphan]), "id-orphan");
});

test("suggestNextCode: standard DEFAULT_CHART accounts across all types", () => {
  const defaultChartRows = [
    // ASSET
    makeRow({ code: "1000", type: "ASSET", isPostable: false }),
    makeRow({ code: "1110", type: "ASSET", isPostable: true }),
    makeRow({ code: "1120", type: "ASSET", isPostable: true }),
    makeRow({ code: "1130", type: "ASSET", isPostable: true }),
    makeRow({ code: "1140", type: "ASSET", isPostable: true }),
    makeRow({ code: "1150", type: "ASSET", isPostable: true }),
    makeRow({ code: "1160", type: "ASSET", isPostable: true }),
    makeRow({ code: "1170", type: "ASSET", isPostable: true }),
    makeRow({ code: "1200", type: "ASSET", isPostable: true }),
    makeRow({ code: "1210", type: "ASSET", isPostable: true }),
    makeRow({ code: "1300", type: "ASSET", isPostable: true }),
    // LIABILITY
    makeRow({ code: "2000", type: "LIABILITY", isPostable: false }),
    makeRow({ code: "2100", type: "LIABILITY", isPostable: true }),
    makeRow({ code: "2110", type: "LIABILITY", isPostable: true }),
    makeRow({ code: "2200", type: "LIABILITY", isPostable: true }),
    makeRow({ code: "2300", type: "LIABILITY", isPostable: true }),
    // EQUITY
    makeRow({ code: "3000", type: "EQUITY", isPostable: false }),
    makeRow({ code: "3100", type: "EQUITY", isPostable: true }),
    makeRow({ code: "3200", type: "EQUITY", isPostable: true }),
    makeRow({ code: "3300", type: "EQUITY", isPostable: true }),
    // REVENUE
    makeRow({ code: "4000", type: "REVENUE", isPostable: false }),
    makeRow({ code: "4100", type: "REVENUE", isPostable: true }),
    makeRow({ code: "4200", type: "REVENUE", isPostable: true }),
    makeRow({ code: "4300", type: "REVENUE", isPostable: true }),
    makeRow({ code: "4400", type: "REVENUE", isPostable: true }),
    // EXPENSE
    makeRow({ code: "5000", type: "EXPENSE", isPostable: false }),
    makeRow({ code: "5100", type: "EXPENSE", isPostable: true }),
    makeRow({ code: "5110", type: "EXPENSE", isPostable: true }),
    makeRow({ code: "5200", type: "EXPENSE", isPostable: true }),
    makeRow({ code: "5300", type: "EXPENSE", isPostable: true }),
    makeRow({ code: "5900", type: "EXPENSE", isPostable: true }),
  ];

  assert.equal(suggestNextCode("EXPENSE", defaultChartRows), "5410");
  assert.equal(suggestNextCode("ASSET", defaultChartRows), "1100");
  assert.equal(suggestNextCode("LIABILITY", defaultChartRows), "2120");
  assert.equal(suggestNextCode("EQUITY", defaultChartRows), "3110");
  assert.equal(suggestNextCode("REVENUE", defaultChartRows), "4110");
});

test("suggestNextCode: fallback to single-digit increments when multiples of 10 exhausted", () => {
  // Fill all multiples of 10 for EXPENSE from 5410 to 5990
  const denseExpenseRows: ChartRow[] = [];
  for (let c = 5410; c < 5990; c += 10) {
    denseExpenseRows.push(makeRow({ code: String(c), type: "EXPENSE" }));
  }
  const next = suggestNextCode("EXPENSE", denseExpenseRows);
  assert.ok(/^\d{4}$/.test(next), "Fallback code is 4 digits");
  assert.equal(next.startsWith("5"), true, "Code matches type prefix");
});

