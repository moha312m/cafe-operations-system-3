"use client";

import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { money } from "@/lib/client";
import { TONE_SIDE, TONE_SURFACE, TONE_TOP, type Tone } from "@/components/ui/tone";
import {
  STATUS_LABEL,
  TYPE_LABEL,
  type VarianceStatus,
  type VarianceType,
} from "./variance-labels";

/**
 * One row of `GET /api/variances`.
 *
 * Every Decimal column arrives as a STRING, not a number — Prisma serialises
 * it that way, and `financialImpact: null` means the money could not be
 * valued at all, which is a different statement from zero. Both are printed
 * as what they are.
 */
export type VarianceRow = {
  id: string;
  type: VarianceType;
  status: VarianceStatus;
  quantityVariance: string | null;
  amountVariance: string | null;
  financialImpact: string | null;
  financialImpactAvailable: boolean;
  blocking: boolean;
  openedAt: string;
  stockCountLine: {
    id: string;
    inventoryItem: { id: string; name: string; unit: string };
  } | null;
};

const CLOSED: readonly VarianceStatus[] = ["RESOLVED", "WAIVED"];
const IN_PROGRESS: readonly VarianceStatus[] = ["UNDER_INVESTIGATION", "RESPONSIBILITY_ASSIGNED", "APPROVED"];

/**
 * Four counters over the cases already on screen (so they follow the filters).
 * Counting only: no figure here is a money total, since an unvalued case has
 * no amount and adding the others would understate it.
 */
export function VarianceSummary({ cases }: { cases: VarianceRow[] }) {
  const cards: { key: string; label: string; value: number; tone: Tone }[] = [
    { key: "all", label: "كل الحالات في القائمة", value: cases.length, tone: "tide" },
    { key: "open", label: "مفتوحة", value: cases.filter((c) => c.status === "OPEN").length, tone: "clay" },
    { key: "progress", label: "قيد المتابعة", value: cases.filter((c) => IN_PROGRESS.includes(c.status)).length, tone: "caramel" },
    { key: "closed", label: "مقفولة أو متجاوَز عنها", value: cases.filter((c) => CLOSED.includes(c.status)).length, tone: "sage" },
  ];
  return (
    <dl className="grid grid-cols-2 gap-2 lg:grid-cols-4" data-testid="variance-summary">
      {cards.map((card) => (
        <div key={card.key} className={`min-w-0 rounded-lg border p-3 ${TONE_SURFACE[card.tone]} ${TONE_TOP[card.tone]}`}>
          <dt className="text-xs font-medium opacity-80">{card.label}</dt>
          <dd className="mt-0.5 text-2xl font-bold tabular-nums">{card.value}</dd>
        </div>
      ))}
    </dl>
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
            <TableHead>النوع</TableHead>
            <TableHead>الحالة</TableHead>
            <TableHead>الصنف</TableHead>
            <TableHead>فرق الكمية</TableHead>
            <TableHead>الأثر المالي</TableHead>
            <TableHead>فُتحت</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {cases.map((c) => (
            <TableRow
              key={c.id}
              onClick={() => onSelect(c.id)}
              className={`cursor-pointer ${selectedId === c.id ? "bg-muted/60" : ""}`}
              data-testid="variance-row"
            >
              <TableCell className={c.status === "OPEN" ? `${TONE_SIDE.clay} bg-clay-soft/50` : CLOSED.includes(c.status) ? `${TONE_SIDE.sage} bg-sage-soft/50` : ""}>
                <div className="flex items-center gap-2">
                  {TYPE_LABEL[c.type] ?? c.type}
                  {c.blocking && (
                    <Badge className={`border ${TONE_SURFACE.clay} hover:bg-clay-soft`}>
                      موقفة
                    </Badge>
                  )}
                </div>
              </TableCell>
              <TableCell>{STATUS_LABEL[c.status] ?? c.status}</TableCell>
              <TableCell className="text-muted-foreground">
                {c.stockCountLine?.inventoryItem.name ?? "—"}
              </TableCell>
              <TableCell className="tabular-nums">
                {c.quantityVariance ?? "—"}
              </TableCell>
              <TableCell className="tabular-nums">
                {/* Unavailable is not zero, and printing 0 here would be a
                    figure nobody computed. */}
                {c.financialImpactAvailable && c.financialImpact !== null
                  ? money(c.financialImpact, currency)
                  : "غير متاح"}
              </TableCell>
              <TableCell className="text-muted-foreground">
                {new Date(c.openedAt).toLocaleString("ar-EG", {
                  dateStyle: "short",
                  timeStyle: "short",
                })}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
