// ── Handover report: one model, three outputs (screen tables, XLSX, print HTML) ──
// Built from the SAME payload the detail screen reads (`handoverDetailPayload`), so the
// report can never show an outgoing quantity the viewer was not allowed to see, and the
// money it prints is exactly the screen's. Quantities are never summed across units, and
// a value the viewer may not see is written as "غير متاح" — never as zero.
import { buildXlsx, type XlsxCell, type XlsxSheet } from "@/lib/xlsx";
import { csvCell } from "@/lib/report-output";
import { HANDOVER_STATUS_LABEL } from "@/components/handovers/handover-labels";
import { DISPOSITION_LABEL } from "@/components/stock-counts/stock-count-labels";
import type { handoverDetailPayload } from "@/lib/handover-detail-payload";

export type HandoverPayload = Awaited<ReturnType<typeof handoverDetailPayload>>;
export type ReportMeta = { businessName: string; currency: string; timezone: string; generatedAt: Date; viewerName: string };
export type ReportTable = { key: string; title: string; note?: string; columns: string[]; rows: XlsxCell[][] };
export type HandoverReport = { identity: [string, XlsxCell][]; tables: ReportTable[] };

const HIDDEN = "مخفي";
const NA = "غير متاح";
const TARGET: Record<string, string> = { SHIFT_TO_SHIFT: "وردية لوردية", BRANCH_CUSTODY: "عهدة الفرع" };
const PAYMENT: Record<string, string> = { CASH: "نقدي", CARD: "بطاقة", WALLET: "محفظة", MIXED: "دفع مقسّم" };
const ORDER_STATUS: Record<string, string> = { PENDING_WAITER_APPROVAL: "مستني موافقة", CONFIRMED: "مؤكد", PREPARING: "بيتحضر", READY: "جاهز", SERVED: "اتقدم", CANCELLED: "ملغي", COMPLETED: "مكتمل" };
const PAYMENT_STATUS: Record<string, string> = { UNPAID: "غير مدفوع", PARTIALLY_PAID: "مدفوع جزئيًا", PAID: "مدفوع", REFUNDED: "مسترد", PARTIALLY_REFUNDED: "مسترد جزئيًا" };
const num = (v: unknown): number | null => (v === null || v === undefined || v === "" || !Number.isFinite(Number(String(v))) ? null : Number(String(v)));
type ReportLine = { id: string; unit: string; disposition: string; inventoryItem: { name: string }; countedQuantity?: unknown; varianceQuantity?: unknown };

export const stamp = (at: Date | string | null | undefined, tz: string) =>
  at ? new Intl.DateTimeFormat("sv-SE", { timeZone: tz, dateStyle: "short", timeStyle: "short" }).format(new Date(at)) : "لم يتم";

export function buildHandoverReport(p: HandoverPayload, meta: ReportMeta): HandoverReport {
  const tz = meta.timezone, cur = meta.currency;
  const branchCustody = p.target === "BRANCH_CUSTODY";
  const o = p.overview, m = o.money;
  const incoming = p.workflow.incomingShift;
  // The same shift the screen follows: the handover's incoming shift, else the one waiting on a custody gate.
  const focusReadiness = p.workflow.readiness.find((r) => r.shiftId === incoming?.id) ?? p.workflow.readiness.find((r) => r.gate !== null) ?? null;

  const identity: [string, XlsxCell][] = [
    ["التقرير", "تقرير تسليم الشيفت"],
    ["رقم التسليم", p.handoverId],
    ["النشاط", meta.businessName],
    ["الفرع", p.workflow.branchName],
    ["الشيفت المُسلّم", `#${p.financialSummary?.shiftNumber ?? o.shiftNumber}`],
    ["المُسلّم", o.signatures.outgoingName],
    ["الجهة المستلمة", branchCustody ? "عهدة الفرع (توقيع باسم الفرع بدون موظف مستلم)" : (p.financialSummary?.incomingName ?? incoming?.cashier.name ?? "لم يُحدد بعد")],
    ["الشيفت المستلم", incoming ? `#${incoming.shiftNumber} — ${incoming.cashier.name}` : focusReadiness ? `#${focusReadiness.shiftNumber} — ${focusReadiness.cashierName} (شيفت منتظر، لم يُسلَّم له شيء)` : "لم يُحدد بعد"],
    ["نوع التسليم", (p.target && TARGET[p.target]) ?? p.target ?? "غير محدد"],
    ["حالة التسليم", HANDOVER_STATUS_LABEL[p.status] ?? p.status],
    ["جاهزية الشيفت المستلم", focusReadiness ? (focusReadiness.operational ? "جاهز للتشغيل" : "غير جاهز بعد") : "غير متاحة"],
    ["الإقفال المالي", stamp(o.financiallyClosedAt, tz)],
    ["تقديم العهدة", stamp(o.signatures.submittedAt, tz)],
    ["اكتمال التسليم", stamp(o.signatures.completedAt, tz)],
    ["وقت إنشاء التقرير", stamp(meta.generatedAt, tz)],
    ["أنشأه", meta.viewerName],
    ["المنطقة الزمنية", tz],
    ["العملة", cur],
    ["نطاق التقرير", "لقطة التسليم وقت الإقفال والتوقيع، مع جاهزية الشيفت من بيانات التشغيل الحالية (مُعلَّمة في ورقتها). الكميات تظهر حسب صلاحيتك وقاعدة العدّ المستقل."],
  ];

  const tables: ReportTable[] = [];

  // Cash and payments — the screen's own figures; absent (not zero) without financial access.
  if (!m) {
    tables.push({ key: "cash", title: "المال والمدفوعات", note: o.financialAccess ? "لا يوجد إقفال مالي مكتمل." : "تفاصيل المال لصاحب صلاحية تقارير الشيفت فقط.", columns: ["البند", `المبلغ (${cur})`], rows: [] });
  } else {
    const amt = (label: string, v: string | null) => [label, num(v) ?? NA] as XlsxCell[];
    tables.push({
      key: "cash", title: "المال والمدفوعات", note: `الأرقام بالعملة ${cur} كما اتسجلت وقت الإقفال. للقراءة فقط.`,
      columns: ["البند", `المبلغ (${cur})`],
      rows: [
        amt("صافي المبيعات", m.sales), amt("المرتجعات", m.refunds), amt("الخصومات", m.discounts), amt("نقد بداية الشيفت", m.openingCash),
        amt("الدرج المتوقع", m.expectedDrawer), amt("المعدود عند الإقفال", m.closingCount), amt("فرق الكاش عند الإقفال", m.closingDifference),
        ["سبب فرق الكاش", m.closingReason ?? (num(m.closingDifference) ? "غير مسجل" : "—")],
        amt("المحوّل المقترح للشيفت التالي", m.proposedTransfer), amt("الكاش المستلم عند الاستلام", m.receivedCash), amt("فرق الاستلام", m.receiptDifference),
        ["عدد الطلبات", m.orderCount],
      ],
    });
    tables.push({
      key: "payments", title: "تسوية طرق الدفع", columns: ["الطريقة", `صافي الحركة (${cur})`, `المتوقع (${cur})`, `المسجل (${cur})`, `الفرق (${cur})`, "الحالة", "السبب"],
      rows: m.payments.map((r) => [PAYMENT[r.method] ?? r.method, num(r.netSales) ?? NA, num(r.expected) ?? NA, num(r.actual) ?? NA, num(r.variance) ?? NA, r.status ?? "—", r.reason ?? "—"]),
    });
  }

  // Inventory — outgoing/expected figures only once the server disclosed them (p.acknowledged).
  const acks = new Map(p.workflow.acknowledgements.map((a) => [a.stockCountLineId, a]));
  const lines = (p.count?.lines ?? []) as ReportLine[];
  const disclosed = p.acknowledged;
  tables.push({
    key: "inventory", title: "الجرد",
    note: p.count === null ? "لا يوجد جرد مربوط بالتسليم." : disclosed ? "الكميات بوحدة كل صنف؛ لا تُجمع كميات بوحدات مختلفة." : "كميات المُسلّم مخفية حتى يوقّع صاحب الاستلام (قاعدة العدّ المستقل).",
    columns: ["الصنف", "الوحدة", "حالة السطر", "جرد المُسلّم", "الفرق عن المتوقع", branchCustody ? "توقيع الفرع" : "قرار الاستلام", "عدّ المستلم", "المُسلَّم", "فرق الاستلام"],
    rows: lines.map((l) => {
      const a = acks.get(l.id);
      const decision = !a ? (l.disposition === "PENDING" ? "غير معدود — خارج التوقيع" : branchCustody ? "لم يُوقّع بعد" : "لم يُسجّل استلام") : a.decision === "DISPUTED" ? "معترض عليه" : branchCustody ? "موقّع باسم الفرع" : "مُستلَم";
      return [
        l.inventoryItem.name, l.unit, DISPOSITION_LABEL[l.disposition as keyof typeof DISPOSITION_LABEL] ?? l.disposition,
        disclosed ? (num(l.countedQuantity) ?? "—") : HIDDEN, disclosed ? (num(l.varianceQuantity) ?? "—") : HIDDEN,
        decision,
        a ? (a.incomingCountedQuantity == null ? "بدون عدّ مستقل" : num(a.incomingCountedQuantity) ?? "—") : "—",
        a ? (num(a.handedOverQuantity) ?? "—") : "—",
        a && a.incomingCountedQuantity != null ? (num(a.varianceQuantity) ?? "—") : "—",
      ];
    }),
  });

  // Carried orders.
  tables.push({
    key: "orders", title: "الطلبات المنقولة مع التسليم",
    note: o.operations === null ? "تفاصيل الطلبات تحتاج صلاحية عرض الطلبات." : "الحالة وقت التسليم، والحالة الحالية للتتبع.",
    columns: ["رقم الطلب", "الحالة وقت التسليم", "الدفع وقت التسليم", `المتبقي وقت التسليم (${cur})`, "الحالة الآن", "الدفع الآن"],
    rows: (o.operations ?? []).map((r) => [String(r.orderNumber), ORDER_STATUS[r.statusAtHandover] ?? r.statusAtHandover, PAYMENT_STATUS[r.paymentStatusAtHandover] ?? r.paymentStatusAtHandover, num(r.remainingAtHandover) ?? NA, ORDER_STATUS[r.order.status] ?? r.order.status, PAYMENT_STATUS[r.order.paymentStatus] ?? r.order.paymentStatus]),
  });

  // Current operational readiness — labelled as such, never mixed with the snapshot.
  tables.push({
    key: "readiness", title: "جاهزية الشيفت (بيانات تشغيلية حالية)", note: `الوضع وقت إنشاء التقرير (${stamp(meta.generatedAt, tz)}) وليس لقطة وقت التسليم.`,
    columns: ["الشيفت", "الكاشير", "المتطلب", "الحالة", "التفصيل"],
    rows: p.workflow.readiness.flatMap((s) => s.requirements.map((r) => [`#${s.shiftNumber}`, s.cashierName, r.label, r.state === "done" ? "تم" : r.state === "pending" ? "مطلوب" : "غير مطلوب", r.detail ?? "—"])),
  });

  // Activity and signatures — recorded events only.
  const sig = o.signatures;
  tables.push({
    key: "activity", title: "النشاط والتوقيعات", note: "من السجل الفعلي؛ التسليمات القديمة قد لا يكون لها سجل لبعض الخطوات.",
    columns: ["الوقت", "الحدث", "المنفّذ", "تفصيل / سبب"],
    rows: [
      ...p.activity.map((e) => [stamp(e.at, tz), e.label, e.actor ?? "—", e.detail ?? "—"]),
      ["", "— التوقيعات المسجلة —", "", ""],
      [stamp(sig.submittedAt, tz), "تقديم العهدة", sig.outgoingName, "—"],
      [stamp(sig.acceptedAt, tz), branchCustody ? "قبول باسم الفرع" : "قبول المستلم", branchCustody ? "الفرع (توقيع مسؤول)" : (sig.incomingName ?? "لم يُسجل"), "—"],
      [stamp(sig.completedAt, tz), "اكتمال التسليم", "—", "—"],
      [stamp(sig.cashVerifiedAt, tz), "تحقق النقدية", sig.cashVerifiedBy ?? "لم يُسجل", "—"],
    ],
  });
  return { identity, tables };
}

export function reportWorkbook(r: HandoverReport): Buffer {
  // Notes live on the summary sheet so every data sheet keeps its header on row 1 (frozen, filterable).
  const notes = r.tables.filter((t) => t.note).map((t) => [`ملاحظة — ${t.title}`, t.note] as XlsxCell[]);
  const sheets: XlsxSheet[] = [{ name: "الملخص", readable: true, headerRows: [0], rows: [["البند", "القيمة"], ...r.identity.map(([k, v]) => [k, v] as XlsxCell[]), ...notes] }];
  for (const t of r.tables) sheets.push({ name: t.title.slice(0, 28), readable: true, headerRows: [0], filter: true, rows: [t.columns, ...t.rows] });
  return buildXlsx(sheets);
}

const esc = (v: XlsxCell) => String(v ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** A standalone print page: Arabic RTL, A4 landscape, repeating table headers, no scripts. */
export function reportHtml(r: HandoverReport): string {
  const title = String(r.identity[0][1]);
  const id = r.identity.map(([k, v]) => `<tr><th>${esc(k)}</th><td dir="auto">${esc(v)}</td></tr>`).join("");
  const sections = r.tables.map((t) => `<section><h2>${esc(t.title)}</h2>${t.note ? `<p class="note">${esc(t.note)}</p>` : ""}${t.rows.length === 0 ? "<p class=\"note\">لا توجد صفوف.</p>" : `<table><thead><tr>${t.columns.map((c) => `<th>${esc(c)}</th>`).join("")}</tr></thead><tbody>${t.rows.map((row) => `<tr>${row.map((c) => `<td dir="auto"${typeof c === "number" ? ' class="n"' : ""}>${esc(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>`}</section>`).join("");
  return `<!doctype html><html dir="rtl" lang="ar"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>
@page{size:A4 landscape;margin:12mm}*{box-sizing:border-box}body{font:14px/1.5 "Segoe UI",Tahoma,Arial,sans-serif;color:#1f2a24;background:#fff;margin:0;padding:16px}
h1{font-size:20px;margin:0 0 8px}h2{font-size:16px;margin:18px 0 6px;border-bottom:2px solid #3b7a6c;padding-bottom:3px}.note{color:#555;font-size:12px;margin:2px 0 6px}
table{width:100%;border-collapse:collapse;table-layout:auto;margin-bottom:8px}th,td{border:1px solid #cfc8bd;padding:4px 7px;text-align:start;vertical-align:top;overflow-wrap:anywhere}th{background:#efeae2}thead{display:table-header-group}tr{break-inside:avoid}td.n{text-align:end;font-variant-numeric:tabular-nums}
.id th{width:22%}section{break-inside:auto}.bar{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}button{font:inherit;padding:6px 14px}@media print{.bar button{display:none}body{padding:0}}
</style><div class="bar"><h1>${esc(title)}</h1><button onclick="window.print()">طباعة</button></div><table class="id"><tbody>${id}</tbody></table>${sections}</html>`;
}

/** CSV of one table (UTF-8 BOM, CRLF, formula-neutralised), for completeness; the workbook is the primary file. */
export function tableCsv(t: ReportTable): string {
  const cell = (v: XlsxCell) => csvCell(v === null || v === undefined ? "" : typeof v === "boolean" ? String(v) : v);
  return "﻿" + [t.columns, ...t.rows].map((row) => row.map(cell).join(",")).join("\r\n") + "\r\n";
}
