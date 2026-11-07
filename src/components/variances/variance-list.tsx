"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { money } from "@/lib/client";
import { UNIT_LABEL } from "@/lib/inventory";
import { TONE_SIDE, TONE_SURFACE, TONE_TOP, type Tone } from "@/components/ui/tone";
import { STATUS_LABEL, type VarianceStatus, type VarianceType } from "./variance-labels";
import { CASE_TYPE_LABEL, NO_REASON, formatVarianceRow, signedFigure, type FormattedVariance, type VarianceRow } from "./variance-format";

export type { VarianceRow } from "./variance-format";

/**
 * The board's totals from `GET /api/variances`, over EVERY case the filters
 * match (not only the rows drawn). Money is a string; an unvalued stock case
 * adds nothing to the impact and is counted on its own.
 */
export type VarianceBoardSummary = {
  openCount: number;
  openByType: Partial<Record<VarianceType, number>>;
  totalCashShortageAmount: string;
  totalCashOverageAmount: string;
  totalStockFinancialImpact: string;
  stockCaseCount: number;
  unvaluedStockCount: number;
};

const CLOSED: readonly VarianceStatus[] = ["RESOLVED", "WAIVED"];
const TYPES: VarianceType[] = ["CASH", "TENDER", "STOCK", "OPENING_EXCEPTION"];

export function VarianceSummary({ summary, currency }: { summary: VarianceBoardSummary | null; currency: string }) {
  if (!summary) return null;
  const split = TYPES.filter((type) => summary.openByType[type]).map((type) => `${CASE_TYPE_LABEL[type]} ${summary.openByType[type]}`).join(" · ");
  const cards: { key: string; label: string; value: string; hint: string | null; tone: Tone; className?: string }[] = [
    { key: "open", label: "حالات مفتوحة", value: String(summary.openCount), hint: split || null, tone: "tide" },
    { key: "shortage", label: "عجز نقدية/تحصيل", value: money(summary.totalCashShortageAmount, currency), hint: null, tone: "clay", className: "text-red-700 dark:text-red-300" },
    { key: "overage", label: "زيادة نقدية/تحصيل", value: money(summary.totalCashOverageAmount, currency), hint: null, tone: "sage", className: "text-emerald-700 dark:text-emerald-300" },
    {
      key: "stock", label: "فروق المخزون", value: String(summary.stockCaseCount), tone: "caramel", className: "text-amber-700 dark:text-amber-300",
      hint: `الأثر المالي ${money(summary.totalStockFinancialImpact, currency)}${summary.unvaluedStockCount ? ` · ${summary.unvaluedStockCount} بدون تقييم` : ""}`,
    },
  ];
  return (
    <dl className="grid grid-cols-2 gap-2 lg:grid-cols-4" data-testid="variance-summary">
      {cards.map((card) => (
        <div key={card.key} className={`min-w-0 rounded-lg border p-3 ${TONE_SURFACE[card.tone]} ${TONE_TOP[card.tone]}`} data-testid={`variance-summary-${card.key}`}>
          <dt className="text-xs font-medium opacity-80">{card.label}</dt>
          <dd className={`mt-0.5 text-2xl font-bold tabular-nums ${card.className ?? ""}`}>{card.value}</dd>
          {card.hint && <dd className="mt-0.5 text-xs opacity-80">{card.hint}</dd>}
        </div>
      ))}
    </dl>
  );
}

const unitLabel = (unit: string | null) => (unit ? UNIT_LABEL[unit as keyof typeof UNIT_LABEL] ?? unit : "");

/** A figure as the row shows it: money with the currency, a quantity with its unit. */
export function figure(f: FormattedVariance, value: string | null, currency: string): string {
  if (value === null) return "—";
  return f.isMoney ? money(value, currency) : `${value} ${unitLabel(f.unit)}`.trim();
}

export function DifferenceCell({ f, currency }: { f: FormattedVariance; currency: string }) {
  if (f.difference === null) return <span className="text-muted-foreground">—</span>;
  const signed = signedFigure(f.difference, f.isMoney ? 2 : 3) ?? "—";
  const sign = f.direction === "SHORTAGE" ? "−" : f.direction === "OVERAGE" ? "+" : "";
  const tone = f.direction === "SHORTAGE" ? "border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-300" : f.direction === "OVERAGE" ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" : "";
  return (
    <div className="space-y-0.5">
      <div className="flex flex-wrap items-center gap-1.5">
        {f.directionLabel && <Badge className={`border ${tone}`}>{f.directionLabel}</Badge>}
        <span className="font-medium tabular-nums">{f.isMoney ? `${sign}${money(signed.replace(/^[−+]/, ""), currency)}` : `${signed} ${unitLabel(f.unit)}`.trim()}</span>
      </div>
      {!f.isMoney && <div className="text-xs text-muted-foreground">{f.costImpact !== null ? `التكلفة ${money(f.costImpact, currency)}` : "التكلفة غير متاحة"}</div>}
    </div>
  );
}

export function VarianceList({
  cases,
  currency,
  selectedId,
  onSelect,
}: {
  cases: VarianceRow[];
  currency: string;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  if (cases.length === 0) {
    return (
      <p className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
        مفيش حالات فروقات بالفلاتر دي
      </p>
    );
  }

  return (
    <div className="overflow-x-auto rounded-xl border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>الفرع / الشيفت</TableHead>
            <TableHead>الموظف المسؤول</TableHead>
            <TableHead>النوع</TableHead>
            <TableHead>المتوقع</TableHead>
            <TableHead>الفعلي</TableHead>
            <TableHead>الفرق</TableHead>
            <TableHead>السبب المسجل</TableHead>
            <TableHead>الحالة</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {cases.map((c) => {
            const f = formatVarianceRow(c);
            return (
              <TableRow
                key={c.id}
                onClick={() => onSelect(c.id)}
                className={`cursor-pointer align-top ${selectedId === c.id ? "bg-muted/60" : ""}`}
                data-testid="variance-row"
              >
                <TableCell className={c.status === "OPEN" ? `${TONE_SIDE.clay} bg-clay-soft/50` : CLOSED.includes(c.status) ? `${TONE_SIDE.sage} bg-sage-soft/50` : ""}>
                  <div className="font-medium">{f.branchName ?? "—"}</div>
                  <div className="text-xs text-muted-foreground">
                    {f.shiftNumber !== null ? `شيفت #${f.shiftNumber} · ` : ""}
                    {new Date(f.date).toLocaleString("ar-EG", { dateStyle: "short", timeStyle: "short" })}
                  </div>
                </TableCell>
                <TableCell>{f.employeeName ?? <span className="text-muted-foreground">غير محدد</span>}</TableCell>
                <TableCell>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge variant="outline">{f.typeLabel}</Badge>
                    {c.blocking && <Badge className={`border ${TONE_SURFACE.clay} hover:bg-clay-soft`}>موقفة</Badge>}
                  </div>
                </TableCell>
                <TableCell className="tabular-nums">{figure(f, f.expected, currency)}</TableCell>
                <TableCell className="tabular-nums">{figure(f, f.actual, currency)}</TableCell>
                <TableCell><DifferenceCell f={f} currency={currency} /></TableCell>
                <TableCell className={`max-w-48 truncate ${f.reason === NO_REASON ? "text-muted-foreground" : ""}`} title={f.reason}>{f.reason}</TableCell>
                <TableCell>
                  <div className="space-y-1.5">
                    <div>{STATUS_LABEL[c.status] ?? c.status}</div>
                    <Button size="sm" variant="outline" onClick={(e) => { e.stopPropagation(); onSelect(c.id); }} data-testid="variance-open-detail">التفاصيل / اتخاذ قرار</Button>
                  </div>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
