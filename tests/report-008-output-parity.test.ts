// REPORT-008: print, CSV and XLSX come from one table model, so every total
// matches across them; numbers stay numeric and text never becomes a formula.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { inflateRawSync } from "node:zlib";
import { reportOutputFiles, reportOutputModel, type ReportOutput } from "../src/lib/report-output";
import { db, teardownTaggedCafe } from "./helpers/db";
import { countCafe, COUNT_PASSWORD } from "./helpers/count";
import { as, login, requireServer } from "./helpers/http";
import { dateStrInTz } from "@/lib/date-range";

after(async () => { await db.$disconnect(); });

function unzip(buf: Buffer) {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(end >= 0, "zip end record");
  const count = buf.readUInt16LE(end + 10);
  let at = buf.readUInt32LE(end + 16);
  const files = new Map<string, string>();
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(at), 0x02014b50);
    const size = buf.readUInt32LE(at + 20), nameLen = buf.readUInt16LE(at + 28), extra = buf.readUInt16LE(at + 30), comment = buf.readUInt16LE(at + 32);
    const local = buf.readUInt32LE(at + 42), name = buf.subarray(at + 46, at + 46 + nameLen).toString("utf8");
    const dataAt = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    files.set(name, inflateRawSync(buf.subarray(dataAt, dataAt + size)).toString("utf8"));
    at += 46 + nameLen + extra + comment;
  }
  return files;
}

const unxml = (s: string) => s.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll("&amp;", "&");
function sheetCells(sheetXml: string) {
  const rows: (string | number | boolean)[][] = [];
  for (const [, r, body] of sheetXml.matchAll(/<row r="(\d+)">(.*?)<\/row>/g)) {
    const row: (string | number | boolean)[] = [];
    for (const [, col, attrs, inner] of body.matchAll(/<c r="([A-Z]+)\d+"([^>]*)>(.*?)<\/c>/g)) {
      const index = [...col].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
      row[index] = attrs.includes('t="inlineStr"') ? unxml(inner.match(/<t[^>]*>([\s\S]*)<\/t>/)![1])
        : attrs.includes('t="b"') ? inner.includes(">1<") : Number(inner.match(/<v>(.*)<\/v>/)![1]);
    }
    rows[Number(r) - 1] = row;
  }
  return rows;
}

const sample: ReportOutput = {
  title: "تقرير اختبار",
  reporting: { mode: "business", windows: [{ branchId: "b1", startLocal: "2026-10-24T08:00", endLocal: "2026-10-25T02:00", timezone: "Africa/Cairo", from: "2026-10-24T05:00Z", to: "2026-10-24T23:00Z", warnings: [] }], branches: [{ id: "b1", name: "فرع <الدقي>" }] },
  labels: { "totals.revenue": "الإيراد" },
  metrics: { totals: { revenue: "1234.50", orders: 3, cashDifference: -5 }, purchases: { unpaidAsOf: "2026-10-24T20:00:00.000Z" } },
  rows: [
    { section: "byBranch", branchName: "=HYPERLINK(\"http://x\")", revenue: "100.10", orders: 1 },
    { section: "byBranch", branchName: "+فرع", revenue: "200.20", orders: 2 },
    { section: "items", product: "@شاي", variant: null, quantity: 3, revenue: "-0.30" },
    { section: "items", product: "-قهوة", variant: "كبير", quantity: 1, revenue: 9.99, phone: "01001234567", big: "1234567890123456789" },
  ],
  generatedAt: "2026-10-24T20:00:00.000Z",
};

test("CSV, print and XLSX carry the same tables and totals", () => {
  const model = reportOutputModel(sample);
  const files = reportOutputFiles(sample);
  const zip = unzip(Buffer.from(files.xlsx, "base64"));
  const workbook = zip.get("xl/workbook.xml")!;
  const names = [...workbook.matchAll(/<sheet name="([^"]+)"/g)].map((m) => unxml(m[1]));
  assert.deepEqual(names, ["الملخص", "حسب الفرع", "الأصناف"]);

  const summary = sheetCells(zip.get("xl/worksheets/sheet1.xml")!);
  assert.deepEqual(summary[0], ["البند", "القيمة", "المفتاح"]);
  const revenueRow = summary.find((r) => r[2] === "totals.revenue")!;
  assert.deepEqual(revenueRow, ["الإيراد", 1234.5, "totals.revenue"], "labelled, and money is a number");
  assert.deepEqual(summary.find((r) => r[2] === "totals.cashDifference"), ["totals.cashDifference", -5, "totals.cashDifference"]);

  for (const [i, table] of model.tables.entries()) {
    const sheet = sheetCells(zip.get(`xl/worksheets/sheet${i + 2}.xml`)!);
    assert.deepEqual(sheet[0], table.columns);
    const revenueCol = table.columns.indexOf("revenue");
    const total = (rows: unknown[][]) => rows.reduce((s, r) => s + Math.round(Number(r[revenueCol] ?? 0) * 100), 0);
    assert.equal(total(sheet.slice(1)), total(table.rows), `${table.title}: XLSX total`);
    const csvBlock = files.csv.split("\r\n\r\n")[i + 1].split("\r\n").slice(2).map((line) => line.split(","));
    assert.equal(total(csvBlock), total(table.rows), `${table.title}: CSV total`);
  }
  assert.ok(files.html.includes("300.3") || files.html.includes("100.1"), "print shows the rows");
});

test("text that looks like a formula stays text in every output", () => {
  const files = reportOutputFiles(sample);
  for (const bad of ['"=HYPERLINK', '"+فرع', '"@شاي', '"-قهوة']) assert.ok(!files.csv.includes(bad), `${bad} escaped in CSV`);
  assert.ok(files.csv.includes(`"'=HYPERLINK`));
  assert.ok(files.csv.includes(",-0.3,"), "a negative number stays a bare number");
  const zip = unzip(Buffer.from(files.xlsx, "base64"));
  for (const [name, body] of zip) assert.ok(!/<f[ >]/.test(body), `${name} has no formula`);
  const items = sheetCells(zip.get("xl/worksheets/sheet3.xml")!);
  assert.equal(items[2][0], "-قهوة");
  assert.equal(items[2][items[0].indexOf("phone")], "01001234567", "a leading zero keeps the value text");
  assert.equal(items[2][items[0].indexOf("big")], "1234567890123456789", "digits past float precision stay text");
  assert.ok(!files.html.includes("<الدقي>"), "print escapes HTML");
});

test("sheets are right-to-left and the export is deterministic", () => {
  const a = reportOutputFiles(sample).xlsx, b = reportOutputFiles(sample).xlsx;
  assert.equal(a, b);
  const zip = unzip(Buffer.from(a, "base64"));
  assert.ok(zip.get("xl/worksheets/sheet1.xml")!.includes('rightToLeft="1"'));
});

test("the daily report exports the figures it shows, labelled", { timeout: 30000 }, async () => {
  await requireServer();
  const fx = await countCafe("REPORT008");
  try {
    await login(fx.owner.email, COUNT_PASSWORD);
    const report = await as<{ outputSnapshot: string; totals: { revenueExTax: number } }>(fx.owner.email, `/api/reports/daily?date=${dateStrInTz(new Date())}&branchId=${fx.branchId}`);
    assert.equal(report.status, 200, report.text);
    const out = await as<{ csv: string; html: string; xlsx: string }>(fx.owner.email, "/api/reports/output", { method: "POST", body: JSON.stringify({ snapshot: report.body.outputSnapshot }) });
    assert.equal(out.status, 200, out.text);
    const summary = sheetCells(unzip(Buffer.from(out.body.xlsx, "base64")).get("xl/worksheets/sheet1.xml")!);
    assert.deepEqual(summary.find((r) => r[2] === "totals.revenueExTax"), ["المبيعات بدون ضريبة", report.body.totals.revenueExTax, "totals.revenueExTax"]);
    assert.ok(out.body.csv.includes('"المبيعات بدون ضريبة"'));
  } finally {
    await teardownTaggedCafe(fx.cafeId);
  }
});
