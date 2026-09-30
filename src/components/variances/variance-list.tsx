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
              <TableCell>
                <div className="flex items-center gap-2">
                  {TYPE_LABEL[c.type] ?? c.type}
                  {c.blocking && (
                    <Badge className="bg-amber-100 text-amber-800 hover:bg-amber-100">
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
