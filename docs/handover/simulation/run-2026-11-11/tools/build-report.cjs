// Builds report-ar.html = narrative (tools/narrative-ar.html, sections 1–11) + appendix 12 generated from the register.
const fs = require("fs");
const path = require("path");
const RUN = path.resolve(__dirname, "..");
const rows = JSON.parse(fs.readFileSync(path.join(RUN, "logs", "findings-merged.json"), "utf8"));
const narrative = fs.readFileSync(path.join(__dirname, "narrative-ar.html"), "utf8");
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const sevClass = { "حرجة": "crit", "عالية": "high", "متوسطة": "med", "منخفضة": "low" };
const appendix = rows.map((f) => `
<article class="finding ${sevClass[f.severity] || ""}">
  <h4><span class="tag">${esc(f.id)}</span> ${esc(f.title_ar)}</h4>
  <table class="kv">
    <tr><th>الخطورة</th><td>${esc(f.severity)}</td><th>النوع</th><td>${esc(f.type)}</td></tr>
    <tr><th>متى</th><td>${esc(f.when)}</td><th>الدور</th><td>${esc(f.role)}</td></tr>
    <tr><th>الخطوات</th><td colspan="3">${esc(f.steps)}</td></tr>
    <tr><th>المفترض</th><td colspan="3">${esc(f.expected)}</td></tr>
    <tr><th>ما حدث</th><td colspan="3">${esc(f.actual)}</td></tr>
    <tr><th>الأثر</th><td colspan="3">${esc(f.effect)}</td></tr>
    <tr><th>الإصلاح المقترح</th><td colspan="3">${esc(f.fix)}</td></tr>
    <tr><th>الثقة</th><td>${esc(f.confidence)}</td><th>الدليل</th><td class="ev">${esc(f.evidence)}</td></tr>
    ${f.decision ? `<tr><th>قرار</th><td colspan="3">${esc(f.decision)}</td></tr>` : ""}
  </table>
</article>`).join("\n");

const html = `<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>تقرير محاكاة التشغيل — تسليم الورديات</title>
<style>
  :root { --ink:#1d2622; --muted:#5b6660; --line:#d9ded9; --bg:#fbfaf7; --head:#14402f; --crit:#a3241b; --high:#b85c00; --med:#7a6a00; --low:#3d6b52; }
  @page { size: A4; margin: 16mm 14mm; }
  * { box-sizing: border-box; }
  body { font-family: "Segoe UI", Tahoma, "Noto Naskh Arabic", Arial, sans-serif; color: var(--ink); background: var(--bg); line-height: 1.75; font-size: 14.5px; margin: 0; }
  main { max-width: 980px; margin: 0 auto; padding: 24px 16px 48px; }
  h1 { color: var(--head); font-size: 26px; margin: 0 0 4px; }
  h2 { color: var(--head); font-size: 20px; border-bottom: 2px solid var(--head); padding-bottom: 4px; margin-top: 34px; page-break-after: avoid; }
  h3 { font-size: 16.5px; margin: 20px 0 6px; }
  h4 { font-size: 15px; margin: 0 0 6px; }
  p, li { margin: 4px 0; }
  .meta { color: var(--muted); font-size: 13px; }
  table { border-collapse: collapse; width: 100%; margin: 8px 0 14px; font-size: 13.5px; page-break-inside: avoid; }
  th, td { border: 1px solid var(--line); padding: 5px 8px; vertical-align: top; text-align: right; }
  thead th, .kv th { background: #eef2ef; font-weight: 600; white-space: nowrap; }
  td.num, th.num { text-align: left; direction: ltr; font-variant-numeric: tabular-nums; }
  .verdict { font-size: 20px; font-weight: 700; padding: 10px 14px; border: 2px solid var(--crit); color: var(--crit); display: inline-block; border-radius: 6px; }
  .tag { display: inline-block; font-size: 12px; background: #eef2ef; border: 1px solid var(--line); padding: 0 6px; border-radius: 4px; direction: ltr; }
  .finding { border: 1px solid var(--line); border-inline-start: 5px solid var(--line); background: #fff; padding: 10px 12px; margin: 10px 0; page-break-inside: avoid; }
  .finding.crit { border-inline-start-color: var(--crit); } .finding.high { border-inline-start-color: var(--high); }
  .finding.med { border-inline-start-color: var(--med); } .finding.low { border-inline-start-color: var(--low); }
  .ev { font-size: 12px; color: var(--muted); word-break: break-word; }
  .sev-crit { color: var(--crit); font-weight: 700; } .sev-high { color: var(--high); font-weight: 700; }
  .note { background: #fff7e6; border: 1px solid #f0d9a8; padding: 8px 12px; border-radius: 4px; }
  @media print { body { background: #fff; font-size: 12.5px; } main { padding: 0; } a { color: inherit; text-decoration: none; } }
</style>
</head>
<body><main>
${narrative}
<h2 id="s12">12. ملحق: سجل الملاحظات الكامل والأدلة</h2>
<p>كل ملاحظة بأدلتها. الأرقام المرجعية (مثل cmwc…) هي أرقام السجلات في قاعدة بيانات التجربة، والأدلة التفصيلية في مجلد التشغيل: <span class="tag">logs/timeline.jsonl</span> و<span class="tag">evidence/</span> و<span class="tag">diaries/</span> و<span class="tag">screens/</span>.</p>
${appendix}
</main></body></html>`;
fs.writeFileSync(path.join(RUN, "report-ar.html"), html);
console.log("report-ar.html written", html.length, "chars,", rows.length, "findings");
