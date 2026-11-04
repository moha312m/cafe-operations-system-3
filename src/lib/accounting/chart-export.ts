// ── Chart of accounts export (Step 4B.2B) ─────────────────────────────
// Read-only files for planning: an Excel workbook (summary, chart, optional
// mapping) and a UTF-8 CSV. No internal ids, no formulas, no upload path: a file
// edited elsewhere is not an import. Account codes are text everywhere; text
// that could start a formula is neutralised in CSV (as in the sales reports) and
// is never written as a formula in XLSX.
import { z } from "zod";
import { buildXlsx, type XlsxCell, type XlsxSheet } from "@/lib/xlsx";
import { csvCell } from "@/lib/report-output";
import type { ChartRow } from "@/lib/accounting/chart-view";

export const exportQuery = z.object({
  format: z.enum(["xlsx", "csv"]),
  scope: z.enum(["full", "filtered"]).default("full"),
  q: z.string().trim().max(60).optional(),
  /** CSV carries one table; this picks which. XLSX ignores it. */
  dataset: z.enum(["chart", "mapping"]).default("chart"),
  /** XLSX only: add the mapping worksheet. */
  includeMapping: z.enum(["0", "1"]).default("0"),
}).strict();
export type ExportQuery = z.infer<typeof exportQuery>;

const TYPE_LABELS: Record<string, string> = { ASSET: "أصول", LIABILITY: "خصوم", EQUITY: "حقوق ملكية", REVENUE: "إيرادات", EXPENSE: "مصروفات" };
const SIDE_LABELS: Record<string, string> = { DEBIT: "مدين", CREDIT: "دائن" };

export type ExportMeta = { businessName: string; exportedAt: string; scope: "full" | "filtered"; query: string };
export const CHART_COLUMNS = ["الكود", "اسم الحساب", "النوع", "كود الحساب الأب", "اسم الحساب الأب", "المستوى", "رئيسي / قابل للترحيل", "الجانب الطبيعي", "الحالة", "صف في النتائج"] as const;
export const MAPPING_COLUMNS = ["تصنيف المصروف", "كود التصنيف", "كود الحساب", "اسم الحساب", "ساري من", "الحالة"] as const;

export function chartTable(rows: readonly ChartRow[]): XlsxCell[][] {
  return [
    [...CHART_COLUMNS],
    ...rows.map((r) => [
      r.code, r.name, TYPE_LABELS[r.type] ?? r.type, r.parentCode ?? "", r.parentName ?? "", r.depth + 1,
      r.isPostable ? "قابل للترحيل" : "رئيسي (مجموعة)", SIDE_LABELS[r.normalBalance] ?? r.normalBalance, r.isActive ? "نشط" : "موقوف",
      r.matched ? "نتيجة" : "سياق (حساب أب)",
    ]),
  ];
}

export type MappingExportInput = {
  category: { code: string; nameAr: string };
  history: { effectiveFrom: string; accountCode: string | null; accountName: string | null }[];
};

/** One row per mapping interval; a category with none is listed as unmapped. */
export function mappingTable(categories: readonly MappingExportInput[], today: string): XlsxCell[][] {
  const out: XlsxCell[][] = [[...MAPPING_COLUMNS]];
  for (const { category, history } of categories) {
    if (history.length === 0) { out.push([category.nameAr, category.code, "", "", "", "غير مربوط"]); continue; }
    const sorted = [...history].sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
    const inForce = sorted.filter((h) => h.effectiveFrom <= today).at(-1);
    for (const h of sorted) {
      const status = h.effectiveFrom > today ? (h.accountCode ? "مجدول" : "إنهاء مجدول") : h === inForce ? (h.accountCode ? "ساري" : "منتهي") : "سابق";
      out.push([category.nameAr, category.code, h.accountCode ?? "", h.accountName ?? "", h.effectiveFrom, status]);
    }
  }
  return out;
}

export function summaryTable(meta: ExportMeta, rows: readonly ChartRow[], mappingRows?: number): XlsxCell[][] {
  const contextRows = rows.filter((r) => !r.matched).length;
  return [
    ["البند", "القيمة"],
    ["النشاط", meta.businessName],
    ["وقت التصدير (توقيت القاهرة)", meta.exportedAt],
    ["نطاق التصدير", meta.scope === "full" ? "دليل الحسابات كاملًا" : "نتائج البحث الحالية"],
    ["البحث المطبّق", meta.query || "بدون"],
    ["صفوف سياق (الحسابات الأب) مشمولة", meta.scope === "filtered" ? (contextRows ? `نعم — ${contextRows} صف لإظهار موضع النتائج في الشجرة` : "لا يوجد") : "غير منطبق"],
    ["عدد الحسابات في الملف", rows.length],
    ["منها رئيسية (مجموعات)", rows.filter((r) => !r.isPostable).length],
    ["منها قابلة للترحيل", rows.filter((r) => r.isPostable).length],
    ["منها موقوفة", rows.filter((r) => !r.isActive).length],
    ...(mappingRows === undefined ? [] : [["صفوف ربط التصنيفات", mappingRows] as XlsxCell[]]),
    ["ملاحظة", "للقراءة والتخطيط فقط. تعديل الملف خارج النظام لا يغيّر الدليل، ولا يوجد رفع أو استيراد."],
  ];
}

export function chartWorkbook(meta: ExportMeta, rows: readonly ChartRow[], mapping?: XlsxCell[][]): Buffer {
  const sheets: XlsxSheet[] = [
    { name: "الملخص", readable: true, headerRows: [0], rows: summaryTable(meta, rows, mapping ? mapping.length - 1 : undefined) },
    { name: "دليل الحسابات", readable: true, headerRows: [0], filter: true, rows: chartTable(rows) },
  ];
  if (mapping) sheets.push({ name: "ربط التصنيفات", readable: true, headerRows: [0], filter: true, rows: mapping });
  return buildXlsx(sheets);
}

/** UTF-8 with BOM, CRLF, every cell quoted; numbers stay bare and risky text is neutralised by csvCell. */
export function tableCsv(table: readonly XlsxCell[][]): string {
  const cell = (v: XlsxCell) => csvCell(v === null || v === undefined ? "" : typeof v === "boolean" ? String(v) : v);
  return "﻿" + table.map((row) => row.map(cell).join(",")).join("\r\n") + "\r\n";
}

/** The chart table (or a given table) as CSV. */
export function chartCsv(table?: readonly XlsxCell[][], rows?: readonly ChartRow[]): string {
  return tableCsv(table ?? chartTable(rows ?? []));
}
