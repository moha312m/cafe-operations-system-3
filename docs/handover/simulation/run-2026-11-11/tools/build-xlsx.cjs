// Builds findings-ar.xlsx from logs/findings.jsonl (updates merged into their base finding).
// Uses the repo's own "xlsx" dependency (no new dependency).
const path = require("path");
const fs = require("fs");
const XLSX = require("C:/Dev/cafe-ops-handover-integration/node_modules/xlsx");

const RUN = path.resolve(__dirname, "..");
const raw = fs.readFileSync(path.join(RUN, "logs", "findings.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const byId = new Map();
for (const f of raw) {
  if (f.update && byId.has(f.id)) {
    const base = byId.get(f.id);
    for (const [k, v] of Object.entries(f)) {
      if (k === "update" || k === "id") continue;
      if (["actual", "evidence", "when"].includes(k)) base[k] = base[k] ? `${base[k]} || ${v}` : v;
      else base[k] = v;
    }
  } else if (!f.update) byId.set(f.id, { ...f });
}
const order = { "حرجة": 0, "عالية": 1, "متوسطة": 2, "منخفضة": 3 };
const rows = [...byId.values()].sort((a, b) => (order[a.severity] ?? 9) - (order[b.severity] ?? 9) || a.id.localeCompare(b.id));
fs.writeFileSync(path.join(RUN, "logs", "findings-merged.json"), JSON.stringify(rows, null, 1));

const header = ["الرقم", "الخطورة", "النوع", "العنوان", "اليوم/الوردية/المشهد", "الدور", "خطوات إعادة الإنتاج", "ما يجب أن يحدث في كافيه حقيقي", "ما حدث", "الدليل", "الأثر على النقدية/المخزون/المساءلة", "الإصلاح المقترح", "درجة الثقة", "قرار/ملاحظة"];
const data = [header, ...rows.map((f) => [f.id, f.severity, f.type, f.title_ar, f.when, f.role, f.steps, f.expected, f.actual, f.evidence, f.effect, f.fix, f.confidence, f.decision ?? ""])];
const ws = XLSX.utils.aoa_to_sheet(data);
ws["!autofilter"] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: data.length - 1, c: header.length - 1 } }) };
ws["!cols"] = [8, 9, 18, 40, 16, 16, 50, 45, 70, 45, 45, 45, 14, 30].map((w) => ({ wch: w }));
ws["!freeze"] = { xSplit: 0, ySplit: 1 };
const wb = XLSX.utils.book_new();
wb.Workbook = { Views: [{ RTL: true }] };
XLSX.utils.book_append_sheet(wb, ws, "سجل الملاحظات");

const counts = {};
for (const f of rows) counts[f.severity] = (counts[f.severity] ?? 0) + 1;
const summary = [["الخطورة", "العدد"], ...Object.keys(order).map((k) => [k, counts[k] ?? 0]), ["الإجمالي", rows.length]];
const ws2 = XLSX.utils.aoa_to_sheet(summary);
ws2["!cols"] = [{ wch: 14 }, { wch: 8 }];
XLSX.utils.book_append_sheet(wb, ws2, "ملخص");
XLSX.writeFile(wb, path.join(RUN, "findings-ar.xlsx"));
console.log("rows", rows.length, JSON.stringify(counts));
