"use client";

import { useRef, useState } from "react";
import * as XLSX from "xlsx";
import { toast } from "sonner";
import { api } from "@/lib/client";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  HISTORICAL_SALES_TEMPLATE_HEADERS,
  HISTORICAL_SALES_TEMPLATE_EXAMPLE_ROWS,
  type HistoricalImportStats,
  type ValidatedHistoricalSaleRow,
} from "@/lib/historical-sales-import";

const ACCEPTED = [".xlsx", ".xls", ".csv"];

export function HistoricalSalesImportDialog({
  open,
  onOpenChange,
  onImported,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImported: () => void;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [step, setStep] = useState<"upload" | "preview" | "importing" | "success">("upload");
  const [fileName, setFileName] = useState("");
  const [rawRows, setRawRows] = useState<Record<string, unknown>[]>([]);
  const [stats, setStats] = useState<HistoricalImportStats | null>(null);
  const [sampleRows, setSampleRows] = useState<ValidatedHistoricalSaleRow[]>([]);
  const [errorRows, setErrorRows] = useState<ValidatedHistoricalSaleRow[]>([]);
  const [mode, setMode] = useState<"append" | "replace_year" | "replace_all">("append");
  const [targetYear, setTargetYear] = useState<number | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [resultSummary, setResultSummary] = useState<{
    importedCount: number;
    totalRevenue: number;
    minDate: string | null;
    maxDate: string | null;
  } | null>(null);

  function reset() {
    setStep("upload");
    setFileName("");
    setRawRows([]);
    setStats(null);
    setSampleRows([]);
    setErrorRows([]);
    setMode("append");
    setTargetYear(undefined);
    setBusy(false);
    setResultSummary(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function downloadTemplate(type: "xlsx" | "csv") {
    const sheet = XLSX.utils.aoa_to_sheet([
      [...HISTORICAL_SALES_TEMPLATE_HEADERS],
      ...HISTORICAL_SALES_TEMPLATE_EXAMPLE_ROWS,
    ]);
    sheet["!cols"] = HISTORICAL_SALES_TEMPLATE_HEADERS.map(() => ({ wch: 18 }));
    if (!sheet["!views"]) sheet["!views"] = [];
    sheet["!views"].push({ rightToLeft: true });
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, sheet, "المبيعات");
    if (type === "xlsx") {
      XLSX.writeFile(wb, "قالب-المبيعات-التاريخية.xlsx");
    } else {
      XLSX.writeFile(wb, "قالب-المبيعات-التاريخية.csv");
    }
  }

  async function handleFile(file: File) {
    const ext = file.name.slice(file.name.lastIndexOf(".")).toLowerCase();
    if (!ACCEPTED.includes(ext)) {
      toast.error("صيغة الملف غير مدعومة — يرجى رفع ملف .xlsx أو .xls أو .csv");
      return;
    }

    setBusy(true);
    setFileName(file.name);

    try {
      const buffer = await file.arrayBuffer();
      const wb = XLSX.read(buffer, { type: "array" });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const parsedRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" });

      if (parsedRows.length === 0) {
        toast.error("الملف فارغ أو لا يحتوي على صفوف بيانات");
        setBusy(false);
        return;
      }

      setRawRows(parsedRows);

      // Call Preview API
      const res = await api<{
        success: boolean;
        stats: HistoricalImportStats;
        sampleRows: ValidatedHistoricalSaleRow[];
        errorRows: ValidatedHistoricalSaleRow[];
      }>("/api/reports/historical-sales/preview", {
        method: "POST",
        body: { rows: parsedRows },
      });

      setStats(res.stats);
      setSampleRows(res.sampleRows);
      setErrorRows(res.errorRows);
      if (res.stats.years.length > 0) {
        setTargetYear(res.stats.years[0]);
      }
      setStep("preview");

      if (res.stats.errors > 0) {
        toast.warning(`تم العثور على ${res.stats.errors} صف به ملاحظات`);
      } else {
        toast.success(`تم التعرف على ${res.stats.ready} صف مبيعات بنجاح`);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "فشلت قراءة الملف");
    } finally {
      setBusy(false);
    }
  }

  async function executeImport() {
    if (!rawRows.length) return;
    setBusy(true);
    setStep("importing");

    try {
      const res = await api<{
        success: boolean;
        importedCount: number;
        totalRevenue: number;
        minDate: string | null;
        maxDate: string | null;
      }>("/api/reports/historical-sales/import", {
        method: "POST",
        body: {
          rows: rawRows,
          fileName,
          mode,
          targetYear: mode === "replace_year" ? targetYear : undefined,
        },
      });

      setResultSummary(res);
      setStep("success");
      toast.success(`تم استيراد ${res.importedCount.toLocaleString("ar-EG")} سطر مبيعات بنجاح!`);
      onImported();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "تعذر استيراد المبيعات");
      setStep("preview");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) reset(); onOpenChange(o); }}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-3xl" dir="rtl">
        <DialogHeader>
          <DialogTitle className="text-lg font-bold flex items-center gap-2">
            <span>📤</span>
            <span>استيراد وترحيل مبيعات النظام القديم</span>
          </DialogTitle>
        </DialogHeader>

        {/* STEP 1: UPLOAD & TEMPLATE */}
        {step === "upload" && (
          <div className="space-y-5 py-2">
            <div className="rounded-xl border bg-muted/30 p-4 space-y-2 text-sm leading-relaxed">
              <p className="font-semibold text-foreground">💡 سهولة تامة وأمان كامل لبياناتك:</p>
              <ul className="list-disc list-inside space-y-1 text-xs text-muted-foreground">
                <li>ارفع ملف مبيعاتك السابق من أي نظام كاشير قديم (Next Cup، Foodics، Vendora، Odoo، أو ملف مخصص).</li>
                <li><strong>التعرف التلقائي على الأعمدة:</strong> يتعرف النظام تلقائياً على أعمدة المنتج، السعر، التاريخ، والكمية سواء بالعربية أو الإنجليزية.</li>
                <li><strong>بيانات معزولة وآمنة:</strong> لا تؤثر المبيعات التاريخية على كاش الورديات الحالية أو أرصدة المخزون الفعلية، وتُستخدم للتقارير السنوية والشهرية.</li>
              </ul>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 border-b pb-3">
              <span className="text-sm font-medium">ليس لديك ملف جاهز؟ حمل نموذج استرشادي:</span>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" onClick={() => downloadTemplate("xlsx")}>
                  ⬇️ تحميل قالب Excel
                </Button>
                <Button size="sm" variant="ghost" onClick={() => downloadTemplate("csv")}>
                  ⬇️ قالب CSV
                </Button>
              </div>
            </div>

            <input
              ref={fileInputRef}
              type="file"
              accept={ACCEPTED.join(",")}
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void handleFile(file);
              }}
            />

            <button
              type="button"
              disabled={busy}
              onClick={() => fileInputRef.current?.click()}
              className="flex w-full flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed border-primary/30 p-10 text-center transition hover:border-primary hover:bg-muted/30 disabled:opacity-50"
            >
              <span className="text-5xl">📊</span>
              <div>
                <p className="font-bold text-base">
                  {busy ? "جارٍ قراءة الملف وتحليله…" : "اضغط لاختيار ملف مبيعات أو اسحبه هنا"}
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  يدعم ملفات ‎.xlsx أو ‎.xls أو ‎.csv
                </p>
              </div>
            </button>
          </div>
        )}

        {/* STEP 2: PREVIEW */}
        {step === "preview" && stats && (
          <div className="space-y-5 py-2 text-sm">
            {/* Header info */}
            <div className="rounded-xl border bg-muted/40 p-3.5 flex flex-wrap items-center justify-between gap-2">
              <div>
                <h4 className="font-bold">معاينة الملف: {fileName}</h4>
                <p className="text-xs text-muted-foreground mt-0.5">
                  الفترة الزمنية: <bdi>{stats.minDate ?? "—"}</bdi> إلى <bdi>{stats.maxDate ?? "—"}</bdi>
                </p>
              </div>
              <Button size="sm" variant="outline" onClick={() => setStep("upload")}>
                اختيار ملف آخر
              </Button>
            </div>

            {/* Stats Cards */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 text-center">
              <div className="rounded-xl border p-3 bg-card">
                <div className="text-xs text-muted-foreground">إجمالي المبيعات</div>
                <div className="text-base font-bold tabular-nums text-emerald-600 dark:text-emerald-400 mt-1" dir="ltr">
                  {stats.totalRevenue.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ج.م
                </div>
              </div>
              <div className="rounded-xl border p-3 bg-card">
                <div className="text-xs text-muted-foreground">سطور المبيعات</div>
                <div className="text-base font-bold tabular-nums mt-1">
                  {stats.ready.toLocaleString("ar-EG")} <span className="text-xs font-normal text-muted-foreground">/ {stats.total}</span>
                </div>
              </div>
              <div className="rounded-xl border p-3 bg-card">
                <div className="text-xs text-muted-foreground">المنتجات المميزة</div>
                <div className="text-base font-bold tabular-nums mt-1">
                  {stats.uniqueProducts.toLocaleString("ar-EG")}
                </div>
              </div>
              <div className="rounded-xl border p-3 bg-card">
                <div className="text-xs text-muted-foreground">الفواتير المستخلصة</div>
                <div className="text-base font-bold tabular-nums mt-1">
                  {stats.uniqueInvoices.toLocaleString("ar-EG")}
                </div>
              </div>
            </div>

            {/* Error banner if any */}
            {stats.errors > 0 && (
              <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-800 dark:text-amber-200">
                ⚠️ يوجد {stats.errors} صف به بيانات غير صالحة (مثل تاريخ غير معروف أو كمية سالبة) سيتم تجاوزها تلقائياً واستيراد باقي السطور السليمة ({stats.ready} سطر).
              </div>
            )}

            {/* Sample Table */}
            <div className="space-y-2">
              <h5 className="font-semibold text-xs text-muted-foreground">عينة من السطور التي تم التعرف عليها ({sampleRows.length} سطر):</h5>
              <div className="max-h-56 overflow-auto rounded-xl border">
                <table className="w-full text-xs text-start whitespace-nowrap">
                  <thead className="bg-muted/50 sticky top-0">
                    <tr>
                      <th className="p-2 text-start">المنتج</th>
                      <th className="p-2 text-start">SKU</th>
                      <th className="p-2 text-start">التاريخ</th>
                      <th className="p-2 text-start">الكمية</th>
                      <th className="p-2 text-start">السعر</th>
                      <th className="p-2 text-start">الإجمالي</th>
                      <th className="p-2 text-start">الدفع</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {sampleRows.map((r, i) => (
                      <tr key={i} className={r.status === "error" ? "bg-destructive/10" : ""}>
                        <td className="p-2 font-medium">{r.productName || "—"}</td>
                        <td className="p-2 tabular-nums text-muted-foreground">{r.sku}</td>
                        <td className="p-2 tabular-nums">{r.saleDate}</td>
                        <td className="p-2 tabular-nums">{r.quantity} {r.quantityUnit}</td>
                        <td className="p-2 tabular-nums">{r.unitPrice.toFixed(2)}</td>
                        <td className="p-2 tabular-nums font-semibold" dir="ltr">{r.total.toFixed(2)}</td>
                        <td className="p-2 text-muted-foreground">{r.paymentMethod || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Mode Selector */}
            <div className="rounded-xl border bg-card p-3.5 space-y-2.5">
              <h5 className="font-semibold text-sm">طريقة الحفظ في النظام:</h5>
              <div className="space-y-2 text-xs">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="importMode"
                    checked={mode === "append"}
                    onChange={() => setMode("append")}
                  />
                  <span><strong>إضافة للمبيعات الحالية (مستحسن):</strong> يضيف المبيعات مع تجنب تكرار أي سطر موجود مسبقاً.</span>
                </label>
                {stats.years.length > 0 && (
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="radio"
                      name="importMode"
                      checked={mode === "replace_year"}
                      onChange={() => setMode("replace_year")}
                    />
                    <span><strong>استبدال بيانات سنة:</strong> مسح بيانات سنة{" "}
                      <select
                        className="rounded border px-1.5 py-0.5 text-xs bg-background"
                        value={targetYear ?? stats.years[0]}
                        onChange={(e) => setTargetYear(Number(e.target.value))}
                        disabled={mode !== "replace_year"}
                      >
                        {stats.years.map((y) => (
                          <option key={y} value={y}>{y}</option>
                        ))}
                      </select>
                      {" "}واستبدالها بالملف الجديد.</span>
                  </label>
                )}
              </div>
            </div>

            {/* Action buttons */}
            <div className="flex items-center justify-end gap-2 border-t pt-3">
              <Button variant="outline" onClick={() => setStep("upload")} disabled={busy}>
                إلغاء
              </Button>
              <Button onClick={() => void executeImport()} disabled={busy || stats.ready === 0}>
                اعتماد واستيراد {stats.ready.toLocaleString("ar-EG")} سطر مبيعات
              </Button>
            </div>
          </div>
        )}

        {/* STEP 3: IMPORTING */}
        {step === "importing" && (
          <div className="py-12 text-center space-y-4">
            <div className="size-12 border-4 border-primary border-t-transparent rounded-full animate-spin mx-auto" />
            <p className="font-bold text-base">جارٍ حفظ وسطور المبيعات وتدقيقها في قاعدة البيانات…</p>
            <p className="text-xs text-muted-foreground">يرجى الانتظار، لا تغلق هذه النافذة.</p>
          </div>
        )}

        {/* STEP 4: SUCCESS */}
        {step === "success" && resultSummary && (
          <div className="py-8 text-center space-y-5">
            <div className="size-16 bg-emerald-500/15 text-emerald-600 rounded-full flex items-center justify-center text-3xl mx-auto">
              ✓
            </div>
            <div>
              <h3 className="text-xl font-bold">تم استيراد المبيعات السابقة بنجاح!</h3>
              <p className="text-sm text-muted-foreground mt-1">
                أصبحت بيانات نظامك القديم متاحة الآن للتحليل والمقارنة في لوحة التحكم وتقارير المبيعات.
              </p>
            </div>

            <div className="rounded-xl border bg-card p-4 max-w-md mx-auto grid grid-cols-2 gap-3 text-center text-sm">
              <div>
                <div className="text-xs text-muted-foreground">السطور المستوردة</div>
                <div className="text-lg font-bold tabular-nums text-foreground mt-0.5">
                  {resultSummary.importedCount.toLocaleString("ar-EG")}
                </div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">إجمالي المبيعات</div>
                <div className="text-lg font-bold tabular-nums text-emerald-600 dark:text-emerald-400 mt-0.5" dir="ltr">
                  {resultSummary.totalRevenue.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ج.م
                </div>
              </div>
            </div>

            <div className="flex justify-center gap-2 pt-2">
              <Button onClick={() => { reset(); onOpenChange(false); }}>
                إغلاق النافذة
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
