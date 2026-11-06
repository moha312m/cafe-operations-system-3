// Print, CSV and XLSX for the handover accountability report. Every table is
// built once from the masked payload, and each renderer only formats it, so a
// total can never differ between the screen and an export. Totals rows are
// the payload's own totals, not a re-addition.
import { csvCell } from "@/lib/report-output";
import { buildXlsx, type XlsxFormat, type XlsxSheetCell } from "@/lib/xlsx";
import { ROLE_LABELS } from "@/lib/permissions";
import {
  EXCEPTION_LABELS, MODE_LABELS,
  type AccountabilityReport, type EmployeeSummary, type IngredientLine, type LedgerRow, type Person,
} from "@/lib/reports/handover-accountability";
import {
  CASE_STATUS_LABELS as CASE_STATUS, HANDOVER_STATUS_LABELS as HANDOVER_STATUS, PLACE_STATUS_LABELS,
  HIDDEN, NOT_RECORDED, UNIT_LABELS, excelSerial, formatAmount, formatCount, formatDateStr, formatDateTime, formatQuantity,
} from "@/lib/reports/handover-accountability-format";

/** A typed cell: numbers stay numbers; a missing figure carries its reason. */
export type Cell =
  | { kind: "text"; value: string }
  | { kind: "money" | "qty" | "int"; value: number; unit?: string | null }
  | { kind: "datetime" | "date"; value: string }
  | { kind: "missing"; value: typeof HIDDEN | typeof NOT_RECORDED | "—" };
export type Table = { key: TableKey; title: string; columns: string[]; rows: Cell[][]; totals: Cell[] | null };
export const TABLE_KEYS = ["employees", "ledger", "ingredients", "exceptions"] as const;
export type TableKey = (typeof TABLE_KEYS)[number];

const text = (value: string | null | undefined): Cell => (value ? { kind: "text", value } : { kind: "missing", value: "—" });
const int = (value: number): Cell => ({ kind: "int", value });
const qty = (value: number | null, unit: string | null): Cell => (value === null ? { kind: "missing", value: NOT_RECORDED } : { kind: "qty", value, unit });
const dt = (value: string): Cell => ({ kind: "datetime", value });
/** Money where null means "not recorded" — unless the viewer may not see it. */
function amount(value: number | null, hidden = false): Cell {
  if (hidden) return { kind: "missing", value: HIDDEN };
  return value === null ? { kind: "missing", value: NOT_RECORDED } : { kind: "money", value };
}
/** Money where null means "does not apply" (no disposition on a non-direct close). */
const optional = (value: number | null): Cell => (value === null ? { kind: "missing", value: "—" } : { kind: "money", value });
const name = (p: Person | null) => (p ? p.name + (p.active ? "" : " (غير نشط)") : "—");
const blank: Cell = { kind: "text", value: "" };

export function reportTables(r: AccountabilityReport): Table[] {
  const hide = !r.visibility.ingredientValues;
  const t = r.employeeTotals;
  const employees: Table = {
    key: "employees", title: "حسب الموظف",
    columns: ["الموظف", "الدور", "شيفتات أقفلها", "استلامات استلمها", "النقدية المتوقعة", "النقدية المعدودة", "عجز نقدي", "زيادة نقدية", "صافي النقدية", "إقفال بدون عدّ",
      "توريد مُعلن", "توريد مؤكد", "بانتظار التأكيد", "متنازع عليه", "عجز توريد بعد الحل", "أصناف بفرق", "عجز خامات", "زيادة خامات", "صافي الخامات", "خامات بلا تكلفة",
      "فروق مشتركة (عدد)", "مشترك خامات (كامل، غير مقسّم)", "مشترك نقدية (كامل، غير مقسّم)", "تنبيهات"],
    rows: r.employees.map((e: EmployeeSummary) => [
      text(name(e.employee)), text(ROLE_LABELS[e.employee.role] ?? e.employee.role), int(e.shiftsClosed), int(e.handoversReceived),
      amount(e.cash.expected), amount(e.cash.counted), amount(e.cash.shortage), amount(e.cash.overage), amount(e.cash.net), int(e.cash.notCounted),
      amount(e.deliveries.declared), amount(e.deliveries.confirmed), amount(e.deliveries.pending), amount(e.deliveries.disputed), amount(e.deliveries.resolvedShortfall),
      int(e.stock.items), amount(e.stock.shortageValue, hide), amount(e.stock.overageValue, hide), amount(e.stock.net, hide), int(e.stock.unpriced),
      int(e.shared.count), amount(e.shared.stockValue, hide), amount(e.shared.cashAmount), text(e.flags.map((f) => f.label).join("، ")),
    ]),
    totals: [text("الإجمالي"), blank, int(t.shiftsClosed), int(t.handoversReceived),
      amount(t.cash.expected), amount(t.cash.counted), amount(t.cash.shortage), amount(t.cash.overage), amount(t.cash.net), int(t.cash.notCounted),
      amount(t.deliveries.declared), amount(t.deliveries.confirmed), amount(t.deliveries.pending), amount(t.deliveries.disputed), amount(t.deliveries.resolvedShortfall),
      int(t.stock.items), amount(t.stock.shortageValue, hide), amount(t.stock.overageValue, hide), amount(t.stock.net, hide), int(t.stock.unpriced),
      // Shared figures are listed against every person involved, so a column sum would count them twice.
      int(r.kpis.sharedCount), amount(r.kpis.sharedStockOverage === null ? null : r.kpis.sharedStockOverage - r.kpis.sharedStockShortage!, hide),
      amount(r.kpis.sharedCashOverage - r.kpis.sharedCashShortage), blank],
  };
  const lt = r.ledgerTotals;
  const ledger: Table = {
    key: "ledger", title: "سجل الاستلامات",
    columns: ["التاريخ والوقت", "يوم العمل", "الفرع", "الشيفت", "النوع", "المُسلِّم", "المستلم", "طريقة التسليم", "حالة التسليم",
      "المتوقع", "المعدود", "الفرق", "عجز", "زيادة", "سبب الفرق", "باقٍ في الدرج", "مُورَّد", "توريد بانتظار التأكيد", "توريد متنازع عليه", "فرق عند الاستلام (مشترك)",
      "أصناف بفرق", "عجز خامات", "زيادة خامات", "أصناف لم تُعدّ", "مشاكل مفتوحة", "استلام المكان", "الحالة"],
    rows: r.ledger.map((row: LedgerRow) => {
      const c = row.cash, opening = row.kind === "OPENING";
      return [
        dt(row.at), { kind: "date", value: row.businessDate }, text(row.branch.name), int(row.shift.number), text(opening ? "فتح" : "إقفال"),
        text(name(row.outgoing)), text(name(row.incoming)), text(row.mode ? MODE_LABELS[row.mode] : null), text(row.handoverStatus ? HANDOVER_STATUS[row.handoverStatus] ?? row.handoverStatus : null),
        opening ? optional(null) : amount(c.expected), opening ? optional(null) : amount(c.counted), opening ? optional(null) : amount(c.variance),
        opening ? optional(null) : amount(c.shortage), opening ? optional(null) : amount(c.overage), text(c.reason),
        row.mode === "DIRECT" ? amount(c.retained) : optional(c.retained), row.mode === "DIRECT" ? amount(c.delivered) : optional(c.delivered),
        optional(c.deliveries.pendingCount ? c.deliveries.pending : null), optional(c.deliveries.disputedCount ? c.deliveries.disputed : null), optional(c.receiving),
        int(row.stock.items), amount(row.stock.shortageValue, hide), amount(row.stock.overageValue, hide), int(row.stock.notCounted), int(row.issues.open),
        text(row.place ? PLACE_STATUS_LABELS[row.place.status] ?? row.place.status : NOT_RECORDED),
        text(row.statuses.map((s) => s.label).join("، ")),
      ];
    }),
    totals: [text("الإجمالي"), blank, blank, int(lt.rows), blank, blank, blank, blank, blank,
      amount(lt.expected), amount(lt.counted), amount(lt.overage - lt.shortage), amount(lt.shortage), amount(lt.overage), blank,
      amount(lt.retained), amount(lt.delivered), blank, blank, amount(lt.receiving),
      int(lt.stockItems), amount(lt.stockShortage, hide), amount(lt.stockOverage, hide), blank, blank, blank, blank],
  };
  const it = r.ingredientTotals;
  const ingredients: Table = {
    key: "ingredients", title: "فروق الخامات",
    columns: ["التاريخ والوقت", "الفرع", "الصنف", "الوحدة", "الكمية المتوقعة", "الكمية المعدودة", "الفرق", "تكلفة الوحدة", "أساس التكلفة", "قيمة الفرق",
      "المسؤول", "مشترك بين", "الشيفتات", "حالة الحالة"],
    rows: r.ingredients.map((l: IngredientLine) => [
      dt(l.at), text(l.branch.name), text(l.item.name), text(l.unit ? UNIT_LABELS[l.unit] ?? l.unit : null),
      qty(l.expected, l.unit), qty(l.counted, l.unit), qty(l.difference, l.unit),
      amount(l.unitCost, hide), text(l.costBasis === "COUNT_TIME" ? "بتكلفة وقت العدّ" : NOT_RECORDED), amount(l.value, hide),
      text(l.employee ? name(l.employee) : l.basis === "BRANCH" ? "عهدة الفرع" : "فرق مشترك غير منسوب"),
      text(l.participants.map((p) => name(p)).join("، ")), text(l.shifts.map((n) => "#" + n).join("، ")), text(CASE_STATUS[l.caseStatus] ?? l.caseStatus),
    ]),
    totals: [text("الإجمالي"), blank, int(it.lines), blank, blank, blank, blank, blank, blank, amount(it.net, hide), blank, blank, blank, blank],
  };
  const exceptions: Table = {
    key: "exceptions", title: "الاستثناءات",
    columns: ["التاريخ والوقت", "الفرع", "الشيفت", "الاستثناء", "الأشخاص", "المبلغ", "ملاحظة", "متأخر أكثر من 24 ساعة"],
    rows: r.exceptions.map((e) => [
      dt(e.at), text(e.branch.name), e.shiftNumber === null ? optional(null) : int(e.shiftNumber), text(EXCEPTION_LABELS[e.kind]),
      text(e.people.map((p) => name(p)).join("، ")), optional(e.amount), text(e.note), text(e.stale ? "نعم" : "لا"),
    ]),
    totals: [text("العدد"), blank, blank, int(r.exceptions.length), blank, blank, blank, blank],
  };
  return [employees, ledger, ingredients, exceptions];
}

/** The «الملخص» rows: what the report covers and the rules it applied. */
export function summaryRows(r: AccountabilityReport): [string, Cell][] {
  const k = r.kpis, hide = !r.visibility.ingredientValues;
  return [
    ["التقرير", text("تقرير الاستلام والمسؤولية")],
    ["الفترة", text(`${r.period.label}: ${formatDateStr(r.period.from)} — ${formatDateStr(r.period.to)}`)],
    ["أساس اليوم", text(r.period.dayBasis)],
    ["الفرع", text(r.branch?.name ?? "كل الفروع المسموح بها")],
    ["العملة", text(r.currency)],
    ["الموظف", text(r.employeeFilter?.name ?? "كل الموظفين")],
    ["الاستثناءات فقط", text(r.exceptionsOnly ? "نعم" : "لا")],
    ["أنشأه", text(r.generatedBy.name)],
    ["وقت الإنشاء (القاهرة)", dt(r.generatedAt)],
    ["عدد الإقفالات", int(k.closes)],
    ["عدد التسليمات", int(k.handovers)],
    ["مطابق", int(k.matched)],
    ["فتح بدون استلام مسجل", int(k.openingsWithoutReceipt)],
    ["إقفال بدون عدّ", int(k.closesWithoutCount)],
    ["عجز نقدي", amount(k.cashShortage)],
    ["زيادة نقدية", amount(k.cashOverage)],
    ["صافي النقدية", amount(k.cashNet)],
    ["عجز خامات (منسوب)", amount(k.ingredientShortage, hide)],
    ["زيادة خامات (منسوبة)", amount(k.ingredientOverage, hide)],
    ["صافي الخامات (منسوب)", amount(k.ingredientNet, hide)],
    ["فروق خامات بلا تكلفة", int(k.ingredientUnpriced)],
    ["فروق مشتركة غير منسوبة (عدد)", int(k.sharedCount)],
    ["عجز خامات مشترك", amount(k.sharedStockShortage, hide)],
    ["زيادة خامات مشتركة", amount(k.sharedStockOverage, hide)],
    ["عجز استلام نقدي مشترك", amount(k.sharedCashShortage)],
    ["زيادة استلام نقدي مشتركة", amount(k.sharedCashOverage)],
    ["نزاعات توريد مفتوحة", int(k.openDisputes)],
    ["توريدات بانتظار التأكيد", int(k.pendingDeliveries)],
    ["منها أقدم من 24 ساعة", int(k.staleDeliveries)],
    ["مشاكل تسليم مفتوحة", int(k.openIssues)],
    ["تسليمات بخامات لم تُعدّ", int(k.stockNotCounted)],
    ["قاعدة 1", text("عجز/زيادة الإقفال يُنسب لكاشير الشيفت (صاحب الدرج).")],
    ["قاعدة 2", text("فرق الخامات يُنسب لصاحب العهدة الوحيد؛ لو أكثر من شخص أو فجوة بين عدّين أو عهدة الفرع فهو «مشترك غير منسوب» ولا يُقسَّم.")],
    ["قاعدة 3", text("قيمة الفرق بتكلفة الوحدة المسجلة وقت العدّ.")],
    ["قاعدة 4", text("نزاعات التوريد تظهر منفصلة ولا تُضاف لعجز الكاشير.")],
    ["قاعدة 5", text("العجز والزيادة منفصلان دائمًا والصافي بجانبهما.")],
    ["قاعدة 6", text("اليوم = يوم إقفال الشيفت بتوقيت القاهرة.")],
    ["قاعدة 7", text("«لم يُسجَّل» ليس صفرًا: لا يدخل الإجماليات ويُعد استثناءً. «مخفي» = غير مسموح لك بعرضه.")],
    ["قاعدة 8", text("فرق عدّ النقدية عند الاستلام بين شخصين يظهر مشتركًا باسميهما.")],
  ];
}

// ─────────────────────────────── Renderers ───────────────────────────────

/** Screen/print text. */
export function display(c: Cell): string {
  switch (c.kind) {
    case "text": case "missing": return c.value;
    case "money": return formatAmount(c.value);
    case "qty": return formatQuantity(c.value, c.unit ?? null);
    case "int": return formatCount(c.value);
    case "datetime": return formatDateTime(c.value);
    case "date": return formatDateStr(c.value);
  }
}

/** CSV keeps numbers machine-readable: no grouping, fixed decimals. */
function csvValue(c: Cell): string | number {
  switch (c.kind) {
    case "money": return Number(c.value.toFixed(2));
    case "qty": return Number(c.value.toFixed(3));
    case "int": return c.value;
    case "datetime": return formatDateTime(c.value);
    case "date": return formatDateStr(c.value);
    default: return c.value;
  }
}
export function tableCsv(table: Table): string {
  const line = (cells: (string | number)[]) => cells.map((v) => csvCell(v)).join(",");
  return "﻿" + [line(table.columns), ...table.rows.map((r) => line(r.map(csvValue))), ...(table.totals ? [line(table.totals.map(csvValue))] : [])].join("\r\n") + "\r\n";
}

const XLSX_FORMAT: Partial<Record<Cell["kind"], XlsxFormat>> = { money: "money", qty: "qty", int: "int" };
function xlsxValue(c: Cell, bold = false): XlsxSheetCell {
  if (c.kind === "datetime") return { value: excelSerial(c.value), format: "datetime", bold };
  if (c.kind === "date") return { value: (Date.parse(c.value + "T00:00:00Z") - Date.UTC(1899, 11, 30)) / 86400000, format: "date", bold };
  const format = XLSX_FORMAT[c.kind];
  if (format) return { value: c.value as number, format, bold };
  return { value: c.value as string, format: "text", bold };
}
export function reportXlsx(r: AccountabilityReport): Buffer {
  const tables = reportTables(r);
  const summary = summaryRows(r);
  return buildXlsx([
    { name: "الملخص", readable: true, filter: true, headerRows: [0], rows: [["البند", "القيمة"], ...summary.map(([label, c]) => [{ value: label, format: "text" as const }, xlsxValue(c)])] },
    ...tables.map((t) => ({
      name: t.title, readable: true, filter: true, headerRows: [0],
      rows: [t.columns, ...t.rows.map((row) => row.map((c) => xlsxValue(c))), ...(t.totals ? [t.totals.map((c) => xlsxValue(c, true))] : [])],
    })),
  ]);
}

const escape = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const numeric = (c: Cell) => c.kind === "money" || c.kind === "qty" || c.kind === "int";

/** A4 landscape; the header row repeats on every page and rows never split. */
export const PRINT_CSS = `@page{size:A4 landscape;margin:12mm 10mm 14mm;@bottom-center{content:"صفحة " counter(page) " من " counter(pages);font-size:9px;color:#555}}
.acc-print{font-size:11px;line-height:1.45;color:#1c2421;background:#fff;padding:12px;font-variant-numeric:tabular-nums}
.acc-print *{box-sizing:border-box}
.acc-print header{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;border-bottom:2px solid #2f5d50;padding-bottom:8px;margin-bottom:10px}
.acc-print h1{font-size:18px;margin:0;font-weight:700}.acc-print h2{font-size:14px;margin:14px 0 6px;color:#2f5d50;break-after:avoid;font-weight:600}.acc-print .meta{color:#444;font-size:11px}
.acc-print .kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:4px 16px;margin-bottom:6px}.acc-print .kpis div{display:flex;justify-content:space-between;gap:8px;border-bottom:1px dotted #ccc;padding:2px 0}
.acc-print table{width:100%;border-collapse:collapse;margin-bottom:8px}.acc-print :is(th,td){border:1px solid #c9c4ba;padding:3px 5px;text-align:start;vertical-align:top;overflow-wrap:anywhere}
.acc-print th{background:#ece7de;font-weight:600}.acc-print thead{display:table-header-group}.acc-print tfoot{display:table-row-group}.acc-print tfoot td{font-weight:700;background:#f6f3ee}.acc-print tr{break-inside:avoid}
.acc-print td.n{text-align:end;white-space:nowrap}.acc-print td.m{color:#777}.acc-print .empty{color:#666}.acc-print .bar{margin-bottom:8px}
@media print{.acc-print .bar{display:none}.acc-print{padding:0}}`;

/** The printable body. The in-app print page wraps it in the app's font; the HTML export wraps it in a bare document. */
export function reportPrintBody(r: AccountabilityReport): string {
  const tables = reportTables(r);
  const period = `${formatDateStr(r.period.from)} — ${formatDateStr(r.period.to)}`;
  const kpis = summaryRows(r).filter(([label]) => !label.startsWith("قاعدة")).slice(8);
  const body = tables.map((t) => `<section><h2>${escape(t.title)}</h2>${t.rows.length ? `<table><thead><tr>${t.columns.map((c) => `<th>${escape(c)}</th>`).join("")}</tr></thead><tbody>${t.rows.map((row) => `<tr>${row.map(td).join("")}</tr>`).join("")}</tbody>${t.totals ? `<tfoot><tr>${t.totals.map(td).join("")}</tr></tfoot>` : ""}</table>` : '<p class="empty">لا توجد بيانات في هذه الفترة.</p>'}</section>`).join("");
  return `<header><div><h1>${escape(REPORT_TITLE)}</h1><div class="meta">${escape(r.period.label)}: ${escape(period)} · ${escape(r.branch?.name ?? "كل الفروع المسموح بها")}${r.employeeFilter ? " · " + escape(r.employeeFilter.name) : ""}</div></div>
<div class="meta">أُنشئ: ${escape(formatDateTime(r.generatedAt))} (القاهرة)<br>بواسطة: ${escape(r.generatedBy.name)}</div></header>
<div class="kpis">${kpis.map(([label, c]) => `<div><span>${escape(label)}</span><b>${escape(display(c))}</b></div>`).join("")}</div>
${body}<p class="meta">«لم يُسجَّل» ليس صفرًا ولا يدخل الإجماليات. «مخفي» غير مسموح بعرضه. الفروق المشتركة لا تُقسَّم على الأشخاص.</p>`;
}
export const REPORT_TITLE = "تقرير الاستلام والمسؤولية";
export function reportHtml(r: AccountabilityReport): string {
  return `<!doctype html><html dir="rtl" lang="ar"><head><meta charset="utf-8"><title>${escape(REPORT_TITLE)} ${escape(r.period.from)} ${escape(r.period.to)}</title><style>body{margin:0;font-family:"IBM Plex Sans Arabic","Segoe UI",Tahoma,sans-serif}${PRINT_CSS}</style></head><body><div class="acc-print"><div class="bar"><button onclick="print()">طباعة</button></div>${reportPrintBody(r)}</div></body></html>`;
}
function td(c: Cell) {
  return `<td${numeric(c) ? ' class="n"' : c.kind === "missing" ? ' class="m"' : ""}>${escape(display(c))}</td>`;
}

export function exportFileName(r: AccountabilityReport, ext: string, table?: string) {
  const branch = (r.branch?.name ?? "كل-الفروع").replace(/[\\/:*?"<>|\s]+/g, "-");
  return `تقرير-المسؤولية_${branch}_${r.period.from}_${r.period.to}${table ? "_" + table : ""}.${ext}`;
}
