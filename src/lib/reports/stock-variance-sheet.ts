// ── Stock count variances workbook ───────────────────────────────────
// One download for "what did the counts find, and what did it cost":
//   الملخص       the period in a few figures, with the value of count differences
//   الفروقات     every counted line that differed, one row each
//   حسب الصنف    the same lines added up per item, biggest loss first
//
// Only CONFIRMED and LOCKED counts are read. Before confirmation the expected
// figure is hidden from the person counting (blind count), and a file must
// not become the way around that.
//
// Value comes from the stock movement's recorded cost or the captured count
// cost. The workbook reports stock application separately from journal
// posting. A line with neither cost is unvalued. A shortage is negative and
// a surplus is positive. Totals are kept on the summary sheet.
import type { InventoryUnit, Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { buildXlsx, type XlsxSheetCell } from "@/lib/xlsx";
import { UNIT_LABEL } from "@/lib/inventory";
import { addDays, dateStrInTz, zonedDayStart } from "@/lib/date-range";
import { excelSerial } from "@/lib/reports/handover-accountability-format";
import { round2, round3 } from "@/lib/costing";

const CONTEXT_LABEL = { NONE: "جرد عادي", HANDOVER: "جرد تسليم", BRANCH_OPENING_VERIFICATION: "جرد فتح فرع" } as const;
const TYPE_LABEL: Record<string, string> = { FULL: "جرد كامل", CRITICAL: "أصناف حرجة" };
const DISPOSITION_LABEL: Record<string, string> = {
  PENDING: "لسه ما اتعدش", COUNTED: "اتعد", WITHIN_TOLERANCE: "داخل السماحية", OUTSIDE_TOLERANCE: "خارج السماحية",
  RECOUNT_REQUIRED: "محتاج إعادة عد", RESOLVED_WITHIN_TOLERANCE: "اترجع للسماحية", VARIANCE_CONFIRMED: "فرق معتمد", VARIANCE_RECORDED: "فرق مسجّل",
};

export type VarianceSheetLine = {
  confirmedAt: Date;
  branch: string;
  count: string;
  context: string;
  item: string;
  itemId: string;
  unit: InventoryUnit;
  expected: number;
  counted: number;
  difference: number;
  unitCost: number | null;
  value: number | null;
  status: string;
  reason: string | null;
  note: string | null;
  counter: string | null;
  posted: boolean;
};

export type VarianceSheet = {
  from: string;
  to: string;
  branch: string | null;
  currency: string;
  counts: number;
  lines: VarianceSheetLine[];
};

export async function loadVarianceSheet(args: { cafeId: string; branchId?: string | null; from: string; to: string; sessionId?: string | null }): Promise<VarianceSheet> {
  const where: Prisma.StockCountSessionWhereInput = {
    cafeId: args.cafeId,
    status: { in: ["CONFIRMED", "LOCKED"] },
    ...(args.branchId ? { branchId: args.branchId } : {}),
    ...(args.sessionId ? { id: args.sessionId } : { confirmedAt: { gte: zonedDayStart(args.from), lt: zonedDayStart(addDays(args.to, 1)) } }),
  };
  const [cafe, branch, sessions] = await Promise.all([
    db.cafe.findUniqueOrThrow({ where: { id: args.cafeId }, select: { currency: true } }),
    args.branchId ? db.branch.findUnique({ where: { id: args.branchId }, select: { name: true } }) : null,
    db.stockCountSession.findMany({
      where,
      orderBy: { confirmedAt: "asc" },
      select: {
        id: true, type: true, accountabilityContext: true, confirmedAt: true, createdAt: true,
        branch: { select: { name: true } },
        lines: {
          where: { varianceQuantity: { not: 0 } },
          select: {
            inventoryItemId: true, unit: true, expectedQuantity: true, countedQuantity: true, effectiveCountedQuantity: true, varianceQuantity: true,
            unitCostSnapshot: true, disposition: true, reasonNote: true,
            reasonCode: { select: { label: true } },
            counter: { select: { name: true } },
            inventoryItem: { select: { name: true } },
            rebase: { select: { ledgerTransaction: { select: { quantity: true, totalCost: true } } } },
          },
        },
      },
    }),
  ]);
  const lines: VarianceSheetLine[] = [];
  for (const s of sessions) {
    const at = s.confirmedAt ?? s.createdAt;
    for (const l of s.lines) {
      if (l.varianceQuantity === null || l.expectedQuantity === null) continue;
      const difference = round3(Number(l.varianceQuantity));
      const movement = l.rebase?.ledgerTransaction;
      const snapshot = l.unitCostSnapshot === null ? null : Number(l.unitCostSnapshot);
      const value = movement?.totalCost != null
        ? round2(Math.abs(Number(movement.totalCost)) * Math.sign(Number(movement.quantity) || difference))
        : snapshot !== null && snapshot > 0 ? round2(difference * snapshot) : null;
      lines.push({
        confirmedAt: at,
        branch: s.branch.name,
        count: `${TYPE_LABEL[s.type] ?? s.type} — ${s.id.slice(-6).toUpperCase()}`,
        context: CONTEXT_LABEL[s.accountabilityContext],
        item: l.inventoryItem.name,
        itemId: l.inventoryItemId,
        unit: l.unit,
        expected: round3(Number(l.expectedQuantity)),
        counted: round3(Number(l.effectiveCountedQuantity ?? l.countedQuantity ?? 0)),
        difference,
        unitCost: value !== null && difference !== 0 ? round2(Math.abs(value / difference)) : snapshot,
        value,
        status: DISPOSITION_LABEL[l.disposition] ?? l.disposition,
        reason: l.reasonCode?.label ?? null,
        note: l.reasonNote,
        counter: l.counter?.name ?? null,
        posted: !!l.rebase,
      });
    }
  }
  // One count is reported for its own day, not for the period the page had picked.
  const day = args.sessionId && sessions[0] ? dateStrInTz(sessions[0].confirmedAt ?? sessions[0].createdAt) : null;
  const branchName = branch?.name ?? (args.sessionId ? sessions[0]?.branch.name : undefined) ?? null;
  return { from: day ?? args.from, to: day ?? args.to, branch: branchName, currency: cafe.currency, counts: sessions.length, lines };
}

const money = (value: number | null, bold = false): XlsxSheetCell => (value === null ? "من غير تكلفة" : { value, format: "money", bold });
const qty = (value: number, bold = false): XlsxSheetCell => ({ value, format: "qty", bold });
const int = (value: number): XlsxSheetCell => ({ value, format: "int" });
const bold = (value: string): XlsxSheetCell => ({ value, bold: true });

export function varianceSheetTotals(sheet: VarianceSheet) {
  const shortages = sheet.lines.filter((l) => l.difference < 0), surpluses = sheet.lines.filter((l) => l.difference > 0);
  const sum = (ls: VarianceSheetLine[]) => round2(ls.reduce((n, l) => n + (l.value ?? 0), 0));
  const shortageValue = sum(shortages), surplusValue = sum(surpluses);
  return {
    shortageItems: shortages.length, surplusItems: surpluses.length,
    shortageValue, surplusValue, net: round2(shortageValue + surplusValue),
    unvalued: sheet.lines.filter((l) => l.value === null).length,
    notPosted: sheet.lines.filter((l) => !l.posted).length,
  };
}

export function varianceSheetXlsx(sheet: VarianceSheet): Buffer {
  const t = varianceSheetTotals(sheet);
  const c = ` (${sheet.currency})`;
  const summary: XlsxSheetCell[][] = [
    [bold("شيت فروقات الجرد"), ""],
    ["الفرع", sheet.branch ?? "كل الفروع"],
    ["الفترة", `${sheet.from} إلى ${sheet.to}`],
    ["عدد الجرود المؤكدة", int(sheet.counts)],
    ["", ""],
    ["أصناف فيها عجز", int(t.shortageItems)],
    ["قيمة العجز" + c, money(t.shortageValue)],
    ["أصناف فيها زيادة", int(t.surplusItems)],
    ["قيمة الزيادة" + c, money(t.surplusValue)],
    [bold("صافي قيمة الفروقات" + c), money(t.net, true)],
    ["", ""],
    ["سطور من غير تكلفة", int(t.unvalued), t.unvalued ? "راجع مستندات التكلفة" : ""],
    ["سطور من غير حركة جرد في المخزون", int(t.notPosted), t.notPosted ? "راجع الخطوة التالية حسب نوع الجرد" : ""],
    ["", ""],
    ["ملحوظة", "العجز بالسالب والزيادة بالموجب. القيمة بتكلفة الحركة أو بتكلفة الجرد المسجلة. تسجيل الحركة في المخزون لا يؤكد الترحيل للحسابات. راجع قيود اليومية لمعرفة الأثر على الربح."],
  ];

  const detailHeader = ["التاريخ", "الفرع", "الجرد", "نوع الجرد", "الصنف", "الوحدة", "المتوقع", "المعدود", "الفرق", "النوع", "تكلفة الوحدة" + c, "قيمة الفرق" + c, "الحالة", "السبب", "ملاحظة", "اتعد بواسطة", "اتسجل في المخزون", "الخطوة التالية"];
  const nextStep = (line: VarianceSheetLine) => {
    if (line.posted) return "راجع قيود اليومية لمعرفة حالة الترحيل";
    if (line.context === CONTEXT_LABEL.HANDOVER) return "مراجعة التسليم، وتسوية مخزون بصلاحية إذا لزم";
    if (line.context === CONTEXT_LABEL.BRANCH_OPENING_VERIFICATION) return "راجع التحقق الافتتاحي من العهدة";
    return "راجع الجرد العادي واستخدم «تطبيق الفروقات على المخزون» لو محتاج تعدّل الرصيد";
  };
  const detail: XlsxSheetCell[][] = [detailHeader, ...sheet.lines.map((l) => [
    { value: excelSerial(l.confirmedAt), format: "datetime" as const }, l.branch, l.count, l.context, l.item, UNIT_LABEL[l.unit] ?? l.unit,
    qty(l.expected), qty(l.counted), qty(l.difference), l.difference < 0 ? "عجز" : "زيادة",
    l.unitCost === null ? "من غير تكلفة" : money(l.unitCost), money(l.value), l.status, l.reason, l.note, l.counter, l.posted ? "نعم" : "—", nextStep(l),
  ])];

  const byItem = new Map<string, { item: string; unit: InventoryUnit; times: number; short: number; surplus: number; value: number; unvalued: number }>();
  for (const l of sheet.lines) {
    const row = byItem.get(l.itemId) ?? { item: l.item, unit: l.unit, times: 0, short: 0, surplus: 0, value: 0, unvalued: 0 };
    row.times++;
    if (l.difference < 0) row.short = round3(row.short + l.difference); else row.surplus = round3(row.surplus + l.difference);
    if (l.value === null) row.unvalued++; else row.value = round2(row.value + l.value);
    byItem.set(l.itemId, row);
  }
  const items = [...byItem.values()].sort((a, b) => a.value - b.value || a.item.localeCompare(b.item, "ar"));
  const perItem: XlsxSheetCell[][] = [
    ["الصنف", "الوحدة", "عدد مرات الفرق", "إجمالي العجز", "إجمالي الزيادة", "صافي الكمية", "صافي القيمة" + c, "سطور من غير تكلفة"],
    ...items.map((r) => [r.item, UNIT_LABEL[r.unit] ?? r.unit, int(r.times), qty(r.short), qty(r.surplus), qty(round3(r.short + r.surplus)), money(r.unvalued === r.times ? null : r.value), int(r.unvalued)]),
  ];

  return buildXlsx([
    { name: "الملخص", rows: summary, readable: true },
    { name: "الفروقات", rows: detail, headerRows: [0], readable: true, filter: true },
    { name: "حسب الصنف", rows: perItem, headerRows: [0], readable: true, filter: true },
  ]);
}

export function varianceSheetFileName(sheet: VarianceSheet) {
  const branch = (sheet.branch ?? "كل-الفروع").replace(/[\\/:*?"<>|\s]+/g, "-");
  return `فروقات-الجرد_${branch}_${sheet.from}_${sheet.to}.xlsx`;
}
