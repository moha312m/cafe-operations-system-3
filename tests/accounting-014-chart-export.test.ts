// ACCOUNTING-014 (Step 4B.2B): the chart export files — shape, text codes, filtered scope
// with its labelled context rows, mapping statuses, CSV quoting and formula protection,
// and a real parse of the generated workbook. Pure: no database or server.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as XLSX from "xlsx";
import { buildChartRows, type ChartAccountInput } from "@/lib/accounting/chart-view";
import { chartCsv, chartTable, chartWorkbook, mappingTable, summaryTable, tableCsv, exportQuery } from "@/lib/accounting/chart-export";

const acct = (code: string, name: string, over: Partial<ChartAccountInput> = {}): ChartAccountInput => ({
  id: `id-${code}`, code, name, type: "EXPENSE", normalBalance: "DEBIT", systemKey: null, isPostable: true, isActive: true, parentId: null, ...over,
});
const chart = [
  acct("0100", "مصروفات تشغيل", { isPostable: false }),
  acct("0110", "نظافة, ومستلزمات \"أولى\"", { parentId: "id-0100" }),
  acct("0120", "=HYPERLINK(\"http://x\",\"اضغط\")", { parentId: "id-0100", isActive: false }),
  acct("0130", "سطر أول\nسطر ثانٍ", { parentId: "id-0100" }),
  acct("2000", "الخصوم", { type: "LIABILITY", normalBalance: "CREDIT", isPostable: false }),
];
const meta = { businessName: "كافيه تجريبي", exportedAt: "2026-11-04 12:00:00", scope: "full" as const, query: "" };

test("chart table: text codes, hierarchy level, group/posting, side, status and context labels", () => {
  const rows = buildChartRows(chart, "نظافة");
  const table = chartTable(rows);
  assert.deepEqual(table[0], ["الكود", "اسم الحساب", "النوع", "كود الحساب الأب", "اسم الحساب الأب", "المستوى", "رئيسي / قابل للترحيل", "الجانب الطبيعي", "الحالة", "صف في النتائج"]);
  assert.equal(table.length, 3, "header + the match + its parent as context");
  assert.deepEqual(table[1].slice(0, 2), ["0100", "مصروفات تشغيل"]);
  assert.equal(table[1][9], "سياق (حساب أب)");
  assert.equal(table[2][0], "0110"); assert.equal(typeof table[2][0], "string", "leading zero survives as text");
  assert.equal(table[2][5], 2); assert.equal(typeof table[2][5], "number");
  assert.equal(table[2][9], "نتيجة");
  assert.deepEqual(table[1].slice(6, 9), ["رئيسي (مجموعة)", "مدين", "نشط"]);
  assert.equal(buildChartRows(chart).length, chart.length, "the full scope is every account, however it is paged or collapsed");
});

test("summary names the business, time, scope, filter and the context rows it includes", () => {
  const filtered = summaryTable({ ...meta, scope: "filtered", query: "نظافة" }, buildChartRows(chart, "نظافة"), 4);
  const get = (label: string) => filtered.find((r) => r[0] === label)?.[1];
  assert.equal(get("النشاط"), "كافيه تجريبي");
  assert.equal(get("نطاق التصدير"), "نتائج البحث الحالية");
  assert.equal(get("البحث المطبّق"), "نظافة");
  assert.match(String(get("صفوف سياق (الحسابات الأب) مشمولة")), /نعم — 1 صف/);
  assert.equal(get("عدد الحسابات في الملف"), 2);
  assert.equal(get("صفوف ربط التصنيفات"), 4);
  const full = summaryTable(meta, buildChartRows(chart));
  assert.equal(full.find((r) => r[0] === "نطاق التصدير")?.[1], "دليل الحسابات كاملًا");
  assert.equal(full.find((r) => r[0] === "منها موقوفة")?.[1], 1);
  assert.equal(full.find((r) => r[0] === "صفوف ربط التصنيفات"), undefined, "no mapping rows claimed when the sheet is absent");
});

test("CSV: BOM, CRLF, quoting of commas, quotes and newlines, formula neutralised, numbers bare", () => {
  const csv = chartCsv(undefined, buildChartRows(chart));
  assert.ok(csv.startsWith("﻿\"الكود\""), "UTF-8 BOM then the Arabic header");
  const lines = csv.split("\r\n");
  assert.equal(lines.at(-1), "", "ends with CRLF");
  assert.match(csv, /"نظافة, ومستلزمات ""أولى"""/, "comma and embedded quotes stay inside one quoted cell");
  assert.match(csv, /"سطر أول\nسطر ثانٍ"/, "a newline stays inside one quoted cell");
  assert.match(csv, /"'=HYPERLINK\(""http:\/\/x"",""اضغط""\)"/, "a formula-looking name is neutralised");
  assert.match(csv, /"0110"/, "codes are quoted text");
  assert.match(csv, /,2,"قابل للترحيل"/, "the level is a bare number");
  assert.equal(tableCsv([["a", null, true, 1.5]]), "﻿\"a\",\"\",\"true\",1.5\r\n");
});

test("XLSX opens as a real workbook: three sheets, text codes, no formulas, filter, frozen header, RTL", () => {
  const rows = buildChartRows(chart);
  const mapping = mappingTable([{ category: { code: "S_CLEAN", nameAr: "نظافة" }, history: [{ effectiveFrom: "2026-10-01", accountCode: "0110", accountName: "نظافة" }] }], "2026-11-04");
  const buffer = chartWorkbook(meta, rows, mapping);
  const book = XLSX.read(buffer, { type: "buffer", cellFormula: true, cellStyles: true });
  assert.deepEqual(book.SheetNames, ["الملخص", "دليل الحسابات", "ربط التصنيفات"]);
  const sheet = book.Sheets["دليل الحسابات"];
  assert.equal(sheet["A2"].t, "s"); assert.equal(sheet["A2"].v, "0100", "leading zero preserved");
  assert.equal(sheet["F3"].t, "n"); assert.equal(sheet["F3"].v, 2, "level is a number");
  const formulaCell = sheet["B4"];
  assert.equal(formulaCell.t, "s"); assert.equal(formulaCell.f, undefined, "never a formula");
  assert.equal(formulaCell.v, "=HYPERLINK(\"http://x\",\"اضغط\")", "text kept verbatim in the workbook");
  assert.equal(sheet["!ref"], "A1:J6");
  assert.equal(sheet["!autofilter"]?.ref, "A1:J6", "header filter over the whole table");
  assert.equal(book.Sheets["ربط التصنيفات"]["C2"].v, "0110");
  const files = (XLSX.read(buffer, { type: "buffer", bookFiles: true }) as unknown as { files: Record<string, { content: Buffer }> }).files;
  const xml = (name: string) => Buffer.from(files[name].content).toString("utf8");
  for (const n of [1, 2, 3]) {
    assert.match(xml(`xl/worksheets/sheet${n}.xml`), /<sheetView rightToLeft="1"/, `sheet ${n} is right-to-left`);
    assert.match(xml(`xl/worksheets/sheet${n}.xml`), /<pane ySplit="1"[^>]*state="frozen"/, `sheet ${n} header is frozen`);
    assert.match(xml(`xl/worksheets/sheet${n}.xml`), /<cols>/, `sheet ${n} has column widths`);
  }
  assert.ok(!/<f>/.test(xml("xl/worksheets/sheet2.xml")), "no formula element anywhere");
  const summary = XLSX.utils.sheet_to_json<string[]>(book.Sheets["الملخص"], { header: 1 });
  assert.deepEqual(summary[0], ["البند", "القيمة"]);
  assert.ok(summary.some((r) => r[0] === "النشاط" && r[1] === "كافيه تجريبي"));
  assert.ok(!JSON.stringify(summary).includes("id-0100"), "no internal ids");
  assert.ok(!JSON.stringify(XLSX.utils.sheet_to_json(sheet, { header: 1 })).includes("id-"), "no internal ids in the chart sheet either");
});

test("mapping statuses: in force, scheduled, earlier, ended, scheduled end and unmapped", () => {
  const table = mappingTable([
    { category: { code: "A", nameAr: "أ" }, history: [{ effectiveFrom: "2026-09-01", accountCode: "5410", accountName: "نظافة" }, { effectiveFrom: "2026-10-01", accountCode: "5411", accountName: "نظافة 2" }, { effectiveFrom: "2026-12-01", accountCode: "5412", accountName: "نظافة 3" }] },
    { category: { code: "B", nameAr: "ب" }, history: [{ effectiveFrom: "2026-09-01", accountCode: "5420", accountName: "صيانة" }, { effectiveFrom: "2026-10-15", accountCode: null, accountName: null }] },
    { category: { code: "C", nameAr: "ج" }, history: [{ effectiveFrom: "2026-09-01", accountCode: "5430", accountName: "أجور" }, { effectiveFrom: "2026-12-15", accountCode: null, accountName: null }] },
    { category: { code: "D", nameAr: "د" }, history: [] },
  ], "2026-11-04");
  assert.deepEqual(table.slice(1).map((r) => [r[1], r[2], r[5]]), [
    ["A", "5410", "سابق"], ["A", "5411", "ساري"], ["A", "5412", "مجدول"],
    ["B", "5420", "سابق"], ["B", "", "منتهي"],
    ["C", "5430", "ساري"], ["C", "", "إنهاء مجدول"],
    ["D", "", "غير مربوط"],
  ]);
});

test("export query contract", () => {
  assert.equal(exportQuery.parse({ format: "xlsx" }).scope, "full");
  assert.equal(exportQuery.parse({ format: "csv", dataset: "mapping" }).dataset, "mapping");
  assert.throws(() => exportQuery.parse({ format: "pdf" }));
  assert.throws(() => exportQuery.parse({ format: "csv", extra: "1" }));
  assert.throws(() => exportQuery.parse({ format: "csv", q: "x".repeat(61) }));
});
