// ACCOUNTING-007 (Step 4B.1): the read-only chart of accounts. The shaping and
// draft-mapping rules are pure; ACCOUNTING-008 drives the HTTP route.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildChartRows, buildMappingDraft, chartQuery, normalizeSearch, type ChartAccountInput } from "@/lib/accounting/chart-view";
import { DEFAULT_CHART } from "@/lib/accounting/chart";

const account = (code: string, name: string, extra: Partial<ChartAccountInput> = {}): ChartAccountInput => ({
  id: `id-${code}`, code, name, type: "EXPENSE", normalBalance: "DEBIT", systemKey: null, isPostable: true, isActive: true, parentId: null, ...extra,
});
const chart: ChartAccountInput[] = [
  account("5900", "مصروفات تشغيل أخرى", { parentId: "id-5000" }),
  account("5000", "التكاليف والمصروفات", { isPostable: false }),
  account("5100", "تكلفة المبيعات", { parentId: "id-5000" }),
  account("5300", "فروقات الكاش", { parentId: "id-5000", isActive: false }),
  account("1000", "الأصول", { type: "ASSET", isPostable: false }),
  account("1110", "نقدية درج الكاشير", { type: "ASSET", parentId: "id-1000" }),
];

test("the hierarchy is ordered by code with parents before children and depth set", () => {
  const rows = buildChartRows(chart);
  assert.deepEqual(rows.map((r) => r.code), ["1000", "1110", "5000", "5100", "5300", "5900"]);
  assert.deepEqual(rows.map((r) => r.depth), [0, 1, 0, 1, 1, 1]);
  assert.equal(rows.find((r) => r.code === "5000")!.childCount, 3);
  assert.equal(rows.find((r) => r.code === "5100")!.parentCode, "5000");
});

test("only postable accounts offer a ledger; inactive accounts stay listed and keep theirs", () => {
  const rows = buildChartRows(chart);
  assert.equal(rows.find((r) => r.code === "5000")!.ledgerEligible, false);
  assert.equal(rows.find((r) => r.code === "5300")!.ledgerEligible, true);
  assert.equal(rows.find((r) => r.code === "5300")!.isActive, false);
});

test("search by code or Arabic name keeps the ancestors of a match", () => {
  const byCode = buildChartRows(chart, "1110");
  assert.deepEqual(byCode.map((r) => [r.code, r.matched]), [["1000", false], ["1110", true]]);
  const byName = buildChartRows(chart, "الكاش");
  assert.deepEqual(byName.filter((r) => r.matched).map((r) => r.code), ["1110", "5300"], "نقدية درج الكاشير and فروقات الكاش");
  assert.deepEqual(buildChartRows(chart, "zzz"), []);
});

test("search folds Arabic digits, alef and ta-marbuta variants", () => {
  assert.equal(normalizeSearch("١١١٠"), "1110");
  assert.deepEqual(buildChartRows(chart, "١١١٠").map((r) => r.code), ["1000", "1110"]);
  assert.equal(normalizeSearch("إيجار"), normalizeSearch("ايجار"));
  assert.equal(normalizeSearch("مرافِق"), normalizeSearch("مرافق"));
});

test("an account whose parent is missing or a corrupt parent cycle is still returned and terminates", () => {
  const orphan = account("7000", "يتيم", { parentId: "missing" });
  assert.deepEqual(buildChartRows([orphan]).map((r) => [r.code, r.depth]), [["7000", 0]]);
  const a = account("8000", "أ", { parentId: "id-8100" }), b = account("8100", "ب", { parentId: "id-8000" });
  assert.doesNotThrow(() => buildChartRows([a, b]));
  assert.doesNotThrow(() => buildChartRows([a, b], "أ"));
});

test("the query parameter is validated and unknown keys are refused", () => {
  assert.equal(chartQuery.parse({ q: "  1110 " }).q, "1110");
  assert.equal(chartQuery.parse({}).q, undefined);
  assert.throws(() => chartQuery.parse({ q: "x".repeat(61) }));
  assert.throws(() => chartQuery.parse({ q: "1", other: "x" }));
});

test("the default chart has no account at the proposed 5400–5450 codes (conflicts are reported when there is one)", () => {
  const codes = new Set(DEFAULT_CHART.map((a) => a.code));
  for (const c of ["5400", "5410", "5420", "5430", "5440", "5450"]) assert.equal(codes.has(c), false, c);
});

test("draft mapping proposes five categories, flags wages and leaves the rest visibly unmapped", () => {
  const cats = ["نظافة", "صيانة", "رواتب وأجور", "مرافق", "إيجار", "تسويق"].map((nameAr, i) => ({ id: `c${i}`, code: `C${i}`, nameAr, archivedAt: null }));
  const draft = buildMappingDraft(cats, DEFAULT_CHART.map((a) => ({ code: a.code, name: a.name, isPostable: !a.header, systemKey: a.systemKey ?? null })));
  const by = Object.fromEntries(draft.rows.map((r) => [r.categoryName, r]));
  assert.equal(by["نظافة"].proposal!.code, "5410");
  assert.equal(by["صيانة"].proposal!.code, "5420");
  assert.equal(by["مرافق"].proposal!.code, "5440");
  assert.equal(by["إيجار"].proposal!.code, "5450");
  assert.equal(by["رواتب وأجور"].proposal!.code, "5430");
  assert.equal(by["رواتب وأجور"].status, "PAYROLL_PENDING");
  assert.equal(by["تسويق"].status, "UNMAPPED");
  assert.equal(by["تسويق"].proposal, null);
  assert.deepEqual(draft.summary, { categories: 6, proposed: 4, payrollPending: 1, unmapped: 1, conflicts: 0 });
  assert.equal(draft.proposalsWithoutCategory.length, 0);
});

test("a taken proposed code is a conflict, not an overwrite; an ambiguous name is never guessed; missing categories are listed", () => {
  const taken = [{ code: "5420", name: "حساب المحاسب", isPostable: true, systemKey: null }];
  const cats = [{ id: "a", code: "A", nameAr: "صيانة", archivedAt: null }, { id: "b", code: "B", nameAr: "صيانة ونظافة", archivedAt: new Date() }];
  const draft = buildMappingDraft(cats, taken);
  assert.equal(draft.rows[0].proposal!.codeState.state, "taken");
  assert.equal(draft.summary.conflicts, 1);
  assert.equal(draft.rows[1].status, "AMBIGUOUS");
  assert.equal(draft.rows[1].proposal, null);
  assert.equal(draft.rows[1].archived, true);
  assert.deepEqual(draft.proposalsWithoutCategory.map((p) => p.code), ["5410", "5430", "5440", "5450"]);
  assert.equal(draft.header.code, "5400");
});
