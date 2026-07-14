"use client";

import { money } from "@/lib/client";
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
import { cn } from "@/lib/utils";

export type PreviewRow = {
  rowNumber: number;
  category: string;
  productName: string;
  price: number | null;
  variantName?: string;
  addonName?: string;
  branchName?: string;
  status: "ready" | "error";
  existing: boolean;
  errors: string[];
};

// معاينة المنيو — the parsed rows with their validation state; rows can
// be excluded from the import individually.
export function MenuImportPreviewTable({
  rows,
  ignored,
  onToggleIgnore,
}: {
  rows: PreviewRow[];
  ignored: Set<number>;
  onToggleIgnore: (rowNumber: number) => void;
}) {
  return (
    <div className="max-h-80 overflow-y-auto rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>الصف</TableHead>
            <TableHead>القسم</TableHead>
            <TableHead>المنتج</TableHead>
            <TableHead>السعر</TableHead>
            <TableHead>تفاصيل</TableHead>
            <TableHead>الحالة</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => {
            const isIgnored = ignored.has(row.rowNumber);
            return (
              <TableRow
                key={row.rowNumber}
                className={cn(isIgnored && "opacity-40 line-through")}
              >
                <TableCell className="tabular-nums">{row.rowNumber}</TableCell>
                <TableCell>{row.category || "—"}</TableCell>
                <TableCell className="font-medium">
                  {row.productName || "—"}
                </TableCell>
                <TableCell className="tabular-nums">
                  {row.price !== null ? money(row.price, "EGP") : "—"}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {[
                    row.variantName && `حجم: ${row.variantName}`,
                    row.addonName && `إضافة: ${row.addonName}`,
                    row.branchName && `فرع: ${row.branchName}`,
                  ]
                    .filter(Boolean)
                    .join(" · ") || "—"}
                </TableCell>
                <TableCell>
                  {row.status === "ready" ? (
                    <Badge variant={row.existing ? "outline" : "secondary"}>
                      {row.existing ? "جاهز — منتج موجود" : "جاهز للاستيراد"}
                    </Badge>
                  ) : (
                    <Badge variant="destructive" title={row.errors.join(" · ")}>
                      يوجد خطأ
                    </Badge>
                  )}
                  {row.status === "error" && (
                    <p className="mt-0.5 max-w-56 text-xs text-destructive">
                      {row.errors.join(" · ")}
                    </p>
                  )}
                </TableCell>
                <TableCell className="text-end">
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2 text-xs"
                    onClick={() => onToggleIgnore(row.rowNumber)}
                  >
                    {isIgnored ? "رجّع الصف" : "تجاهل الصف"}
                  </Button>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
