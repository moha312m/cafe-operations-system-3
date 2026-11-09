"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/client";
import { useApp } from "@/components/app-shell";
import { HistoricalSalesImportDialog } from "@/components/historical-sales/historical-sales-import-dialog";

type HistoricalReport = {
  year: number;
  totals: { lines: number; revenue: number; discount: number; firstDate: string | null; lastDate: string | null };
  monthly: { month: string; lines: number; revenue: number; discount: number }[];
  products: { sku: string; name: string; unit: string; lines: number; quantity: number; revenue: number }[];
  methods: { method: string; lines: number; revenue: number }[];
};
type SaleLines = {
  page: number; pageSize: number; total: number;
  rows: { sourceRow: number; saleLocalDate: string; invoiceNo: string; sku: string;
    productName: string; quantity: number; quantityUnit: string; unitPrice: number;
    discount: number; total: number; paymentMethod: string | null; customerName: string | null }[];
};

const amount = (value: number) => new Intl.NumberFormat("ar-EG", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);

export default function HistoricalSalesPage() {
  const { user, cafe } = useApp();
  const [year, setYear] = useState(() => new Date().getFullYear());
  const [report, setReport] = useState<HistoricalReport | null>(null);
  const [month, setMonth] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [saleLines, setSaleLines] = useState<SaleLines | null>(null);
  const [error, setError] = useState("");
  const [importOpen, setImportOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      setError("");
      setReport(await api<HistoricalReport>(`/api/reports/historical-sales?year=${year}`));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "تعذر تحميل التقرير");
      setReport(null);
    }
  }, [year]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void load(); }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  useEffect(() => {
    const timer = window.setTimeout(async () => {
      try {
        const params = new URLSearchParams({ year: String(year), page: String(page) });
        if (month) params.set("month", month);
        if (query.trim()) params.set("q", query.trim());
        setSaleLines(await api<SaleLines>(`/api/reports/historical-sales/lines?${params}`));
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "تعذر تحميل سطور البيع");
      }
    }, query ? 250 : 0);
    return () => window.clearTimeout(timer);
  }, [year, month, query, page]);

  if (user.role !== "CAFE_OWNER" && user.role !== "SUPER_ADMIN") return <p>التقرير متاح للمالك فقط.</p>;

  return (
    <div className="max-w-6xl space-y-5" dir="rtl">
      <Link href="/reports" className="inline-flex items-center gap-1 text-sm text-primary underline">
        <span>←</span>
        <span>الرجوع للتقارير</span>
      </Link>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">المبيعات التاريخية المستوردة</h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            عرض وتحليل مبيعات نظامك القديم بمختلف السنوات دون المساس بالكاش أو المخزون الحالي.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setImportOpen(true)}
            className="inline-flex min-h-10 items-center gap-1.5 rounded-xl bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90 shadow-sm transition"
          >
            <span>📤</span>
            <span>استيراد مبيعات النظام القديم</span>
          </button>
          <label className="flex items-center gap-2 text-sm">
            <span>السنة</span>
            <input
              className="rounded-lg border px-2.5 py-1.5 text-sm bg-background font-medium"
              type="number"
              min="2020"
              max="2099"
              value={year}
              onChange={(event) => {
                setYear(Number(event.target.value));
                setMonth("");
                setPage(1);
              }}
            />
          </label>
        </div>
      </div>

      {error && <p role="alert" className="text-destructive text-sm font-medium">{error}</p>}

      {/* Empty State Banner when no records exist */}
      {report && report.totals.lines === 0 && (
        <div className="rounded-2xl border-2 border-dashed p-10 text-center space-y-3 bg-muted/20">
          <div className="text-5xl">📊</div>
          <h3 className="text-lg font-bold">لا توجد مبيعات تاريخية مسجلة لسنة {year}</h3>
          <p className="text-xs text-muted-foreground max-w-md mx-auto leading-relaxed">
            يمكنك بسهولة رفع ملف Excel أو CSV يحتوي على مبيعات نظامك السابق لعرض التحليلات الشهرية، مقارنة الفترات، وتحديد الأصناف الأكثر مبيعاً.
          </p>
          <button
            type="button"
            onClick={() => setImportOpen(true)}
            className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground hover:opacity-90 shadow"
          >
            <span>📤</span>
            <span>رفع ملف مبيعات قديمة الآن</span>
          </button>
        </div>
      )}

      {report && report.totals.lines > 0 && (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="rounded-xl border bg-card p-4">
              <div className="text-xs text-muted-foreground">إجمالي المبيعات المسجلة</div>
              <strong className="text-2xl font-bold tabular-nums text-emerald-600 dark:text-emerald-400 mt-1 block" dir="ltr">
                {amount(report.totals.revenue)} ج.م
              </strong>
            </div>
            <div className="rounded-xl border bg-card p-4">
              <div className="text-xs text-muted-foreground">عدد سطور البيع</div>
              <strong className="text-2xl font-bold tabular-nums mt-1 block">
                {report.totals.lines.toLocaleString("ar-EG")}
              </strong>
            </div>
            <div className="rounded-xl border bg-card p-4">
              <div className="text-xs text-muted-foreground">الفترة الزمنية</div>
              <strong className="text-sm font-semibold tabular-nums mt-1 block">
                {report.totals.firstDate ?? "—"} إلى {report.totals.lastDate ?? "—"}
              </strong>
            </div>
          </div>

          <section className="space-y-2">
            <h2 className="text-lg font-semibold">المبيعات شهريًا لعام {year}</h2>
            <div className="overflow-x-auto rounded-xl border bg-card">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/40 text-start">
                    <th className="p-3 text-start">الشهر</th>
                    <th className="p-3 text-start">المبيعات</th>
                    <th className="p-3 text-start">الخصومات</th>
                    <th className="p-3 text-start">سطور البيع</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {report.monthly.map((row) => (
                    <tr key={row.month}>
                      <td className="p-3 font-medium">{row.month}</td>
                      <td className="p-3 tabular-nums" dir="ltr">{amount(row.revenue)} ج.م</td>
                      <td className="p-3 tabular-nums" dir="ltr">{amount(row.discount)} ج.م</td>
                      <td className="p-3 tabular-nums">{row.lines.toLocaleString("ar-EG")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="space-y-2">
            <h2 className="text-lg font-semibold">طرق الدفع في ملف المصدر</h2>
            <div className="overflow-x-auto rounded-xl border bg-card">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/40 text-start">
                    <th className="p-3 text-start">الطريقة</th>
                    <th className="p-3 text-start">إجمالي المبيعات</th>
                    <th className="p-3 text-start">عدد الحركات</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {report.methods.map((row) => (
                    <tr key={row.method}>
                      <td className="p-3 font-medium">{row.method}</td>
                      <td className="p-3 tabular-nums" dir="ltr">{amount(row.revenue)} ج.م</td>
                      <td className="p-3 tabular-nums">{row.lines.toLocaleString("ar-EG")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="space-y-2">
            <h2 className="text-lg font-semibold">أعلى 30 منتجًا بالمبيعات</h2>
            <div className="overflow-x-auto rounded-xl border bg-card">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/40 text-start">
                    <th className="p-3 text-start">SKU</th>
                    <th className="p-3 text-start">المنتج</th>
                    <th className="p-3 text-start">الكمية</th>
                    <th className="p-3 text-start">إجمالي المبيعات</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {report.products.map((row) => (
                    <tr key={`${row.sku}-${row.unit}`}>
                      <td className="p-3 tabular-nums text-muted-foreground">{row.sku}</td>
                      <td className="p-3 font-medium">{row.name}</td>
                      <td className="p-3 tabular-nums">{amount(row.quantity)} {row.unit}</td>
                      <td className="p-3 tabular-nums" dir="ltr">{amount(row.revenue)} ج.م</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <p className="text-xs text-muted-foreground">
            حساب الكافيه: {cafe?.name ?? "—"}. هذه المبيعات محفوظة بصفتها بيانات تاريخية مستقلة للتحليل والمقارنة.
          </p>

          <section className="space-y-3">
            <h2 className="text-lg font-semibold">كل سطور البيع المستوردة</h2>
            <div className="flex flex-wrap gap-2">
              <select
                className="rounded-lg border px-3 py-1.5 text-xs bg-background"
                value={month}
                onChange={(event) => {
                  setMonth(event.target.value);
                  setPage(1);
                }}
              >
                <option value="">كل شهور السنة</option>
                {report.monthly.map((row) => (
                  <option value={row.month} key={row.month}>
                    {row.month}
                  </option>
                ))}
              </select>
              <input
                className="min-w-64 rounded-lg border px-3 py-1.5 text-xs bg-background"
                placeholder="ابحث بالـSKU أو اسم المنتج أو الفاتورة"
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setPage(1);
                }}
              />
            </div>

            {saleLines && (
              <>
                <p className="text-xs text-muted-foreground">{saleLines.total.toLocaleString("ar-EG")} سطر مطابق</p>
                <div className="overflow-x-auto rounded-xl border bg-card">
                  <table className="w-full text-xs text-start whitespace-nowrap">
                    <thead>
                      <tr className="border-b bg-muted/40 text-start">
                        <th className="p-2.5 text-start">التاريخ</th>
                        <th className="p-2.5 text-start">الفاتورة</th>
                        <th className="p-2.5 text-start">SKU</th>
                        <th className="p-2.5 text-start">المنتج</th>
                        <th className="p-2.5 text-start">الكمية</th>
                        <th className="p-2.5 text-start">سعر الوحدة</th>
                        <th className="p-2.5 text-start">الخصم</th>
                        <th className="p-2.5 text-start">الإجمالي</th>
                        <th className="p-2.5 text-start">الدفع</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {saleLines.rows.map((row) => (
                        <tr key={row.sourceRow}>
                          <td className="p-2.5 tabular-nums">{row.saleLocalDate}</td>
                          <td className="p-2.5">{row.invoiceNo}</td>
                          <td className="p-2.5 tabular-nums text-muted-foreground">{row.sku}</td>
                          <td className="p-2.5 font-medium">{row.productName}</td>
                          <td className="p-2.5 tabular-nums">{amount(row.quantity)} {row.quantityUnit}</td>
                          <td className="p-2.5 tabular-nums" dir="ltr">{amount(row.unitPrice)}</td>
                          <td className="p-2.5 tabular-nums" dir="ltr">{amount(row.discount)}</td>
                          <td className="p-2.5 tabular-nums font-semibold" dir="ltr">{amount(row.total)}</td>
                          <td className="p-2.5 text-muted-foreground">{row.paymentMethod ?? "غير محدد"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <div className="flex items-center gap-3">
                  <button
                    className="rounded-lg border px-3 py-1.5 text-xs font-medium disabled:opacity-40"
                    disabled={page <= 1}
                    onClick={() => setPage((value) => value - 1)}
                  >
                    السابق
                  </button>
                  <span className="text-xs">
                    صفحة {page.toLocaleString("ar-EG")} من {Math.max(1, Math.ceil(saleLines.total / saleLines.pageSize)).toLocaleString("ar-EG")}
                  </span>
                  <button
                    className="rounded-lg border px-3 py-1.5 text-xs font-medium disabled:opacity-40"
                    disabled={page * saleLines.pageSize >= saleLines.total}
                    onClick={() => setPage((value) => value + 1)}
                  >
                    التالي
                  </button>
                </div>
              </>
            )}
          </section>
        </>
      )}

      {/* Historical Sales Import Wizard Dialog */}
      <HistoricalSalesImportDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        onImported={() => {
          void load();
        }}
      />
    </div>
  );
}
