"use client";

import { useState } from "react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { HistoricalSalesImportDialog } from "@/components/historical-sales/historical-sales-import-dialog";

export function LegacyImportCard() {
  const [importOpen, setImportOpen] = useState(false);

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center justify-between">
            <span className="flex items-center gap-2">
              <span>📥</span>
              <span>ترحيل واستيراد البيانات من النظام القديم (Legacy Data Migration)</span>
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground leading-relaxed">
            إذا كنت تنتقل من نظام سابق (مثل Next Cup أو Foodics أو Vendora أو ملفات Excel/CSV)، يمكنك رفع بياناتك القديمة بسهولة لعرضها في التقارير ومقارنة أدائك السنوي:
          </p>

          <div className="grid gap-3 sm:grid-cols-3">
            <div className="rounded-xl border p-4 bg-muted/20 flex flex-col justify-between space-y-3">
              <div className="space-y-1">
                <div className="text-sm font-bold flex items-center gap-1.5">
                  <span>📊</span>
                  <span>المبيعات التاريخية السابقة</span>
                </div>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  رفع ملفات المبيعات السابقة (Excel/CSV) لعرض الشهور والأصناف الأكثر مبيعاً ونمو الإيرادات دون المساس بالكاش الحالي.
                </p>
              </div>
              <Button size="sm" onClick={() => setImportOpen(true)} className="w-full">
                رفع مبيعات قديمة
              </Button>
            </div>

            <div className="rounded-xl border p-4 bg-muted/20 flex flex-col justify-between space-y-3">
              <div className="space-y-1">
                <div className="text-sm font-bold flex items-center gap-1.5">
                  <span>☕</span>
                  <span>المنيو وقائمة المنتجات</span>
                </div>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  رفع الأصناف والأقسام والأسعار بملف إكسيل واحد بدلاً من إدخالها يدوياً صنفاً بصنف.
                </p>
              </div>
              <Button size="sm" variant="outline" asChild className="w-full">
                <Link href="/menu">استيراد المنيو</Link>
              </Button>
            </div>

            <div className="rounded-xl border p-4 bg-muted/20 flex flex-col justify-between space-y-3">
              <div className="space-y-1">
                <div className="text-sm font-bold flex items-center gap-1.5">
                  <span>🧾</span>
                  <span>المكونات وتكاليف الوصفات</span>
                </div>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  استيراد وصفات تحضير المنتجات وتكاليف الخامات لضبط هوامش الربح وخصم المخزون.
                </p>
              </div>
              <Button size="sm" variant="outline" asChild className="w-full">
                <Link href="/recipe-review">استيراد الوصفات</Link>
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <HistoricalSalesImportDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        onImported={() => {}}
      />
    </>
  );
}
