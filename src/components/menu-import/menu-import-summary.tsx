"use client";

import * as XLSX from "xlsx";
import { Button } from "@/components/ui/button";

export type ImportSummary = {
  createdProducts: number;
  updatedProducts: number;
  newCategories: number;
  newVariants: number;
  newAddOns: number;
  skippedRows: number;
  failedRows: number;
  priceChanges: number;
};

export type FailedRow = { rowNumber: number; productName: string; reason: string };

// نتيجة الاستيراد — the numbers plus a downloadable error report.
export function MenuImportSummary({
  summary,
  failedRows,
  onClose,
}: {
  summary: ImportSummary;
  failedRows: FailedRow[];
  onClose: () => void;
}) {
  const stats: [string, number][] = [
    ["عدد المنتجات الجديدة", summary.createdProducts],
    ["عدد المنتجات التي تم تحديثها", summary.updatedProducts],
    ["عدد الأقسام الجديدة", summary.newCategories],
    ["عدد الأحجام الجديدة", summary.newVariants],
    ["عدد الإضافات الجديدة", summary.newAddOns],
    ["عدد تغييرات الأسعار", summary.priceChanges],
    ["عدد الصفوف التي تم تجاهلها", summary.skippedRows],
    ["عدد الصفوف التي بها أخطاء", summary.failedRows],
  ];

  function downloadErrorReport() {
    const sheet = XLSX.utils.aoa_to_sheet([
      ["الصف", "المنتج", "سبب الخطأ"],
      ...failedRows.map((r) => [r.rowNumber, r.productName, r.reason]),
    ]);
    sheet["!cols"] = [{ wch: 8 }, { wch: 24 }, { wch: 60 }];
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, "الأخطاء");
    XLSX.writeFile(workbook, "تقرير-أخطاء-الاستيراد.xlsx");
  }

  return (
    <div className="space-y-4">
      <div className="space-y-1 text-center">
        <p className="text-4xl">✅</p>
        <p className="text-lg font-bold">تم الاستيراد بنجاح</p>
      </div>
      <div className="grid grid-cols-2 gap-2">
        {stats.map(([label, value]) => (
          <div
            key={label}
            className="flex items-center justify-between rounded-md border px-3 py-2 text-sm"
          >
            <span className="text-muted-foreground">{label}</span>
            <span className="font-bold tabular-nums">{value}</span>
          </div>
        ))}
      </div>
      {failedRows.length > 0 && (
        <div className="space-y-2 rounded-md border border-destructive/40 bg-destructive/5 p-3">
          <p className="text-sm font-medium text-destructive">
            تم تجاهل {failedRows.length} صف بسبب وجود خطأ
          </p>
          <Button size="sm" variant="outline" onClick={downloadErrorReport}>
            ⬇️ تحميل تقرير الأخطاء
          </Button>
        </div>
      )}
      <Button className="w-full" onClick={onClose}>
        تمام
      </Button>
    </div>
  );
}
