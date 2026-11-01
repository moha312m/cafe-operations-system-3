"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/client";
import { useApp } from "@/components/app-shell";

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
  return <div className="max-w-6xl space-y-5">
    <Link href="/reports" className="underline">الرجوع للتقارير</Link>
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h1 className="text-2xl font-semibold">المبيعات التاريخية المستوردة</h1>
      <label className="flex items-center gap-2">السنة <input className="rounded border px-2 py-1" type="number" min="2020" max="2099" value={year} onChange={event => { setYear(Number(event.target.value)); setMonth(""); setPage(1); }} /></label>
    </div>
    <p className="rounded border p-3 text-sm">المصدر: تقرير مبيعات Next Cup الخارجي. المبالغ بعملة الملف الأصلية، وهي غير مذكورة صراحةً فيه. هذه البيانات للعرض والتحليل فقط؛ لا تدخل في إيراد POS الحالي أو كاش الشيفت أو خصم المخزون.</p>
    {error && <p role="alert" className="text-red-600">{error}</p>}
    {report && <>
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="rounded border p-3"><div className="text-sm">إجمالي المبيعات المسجلة</div><strong className="text-xl">{amount(report.totals.revenue)}</strong></div>
        <div className="rounded border p-3"><div className="text-sm">عدد سطور البيع</div><strong className="text-xl">{report.totals.lines.toLocaleString("ar-EG")}</strong></div>
        <div className="rounded border p-3"><div className="text-sm">الفترة</div><strong>{report.totals.firstDate ?? "—"} إلى {report.totals.lastDate ?? "—"}</strong></div>
      </div>
      <section className="space-y-2"><h2 className="text-lg font-semibold">شهريًا</h2>
        <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr className="border-b text-right"><th>الشهر</th><th>المبيعات</th><th>الخصومات</th><th>سطور البيع</th></tr></thead><tbody>
          {report.monthly.map(row => <tr className="border-b" key={row.month}><td>{row.month}</td><td>{amount(row.revenue)}</td><td>{amount(row.discount)}</td><td>{row.lines.toLocaleString("ar-EG")}</td></tr>)}
        </tbody></table></div>
      </section>
      <section className="space-y-2"><h2 className="text-lg font-semibold">طرق الدفع في ملف المصدر</h2>
        <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr className="border-b text-right"><th>الطريقة</th><th>إجمالي السطور</th><th>سطور البيع</th></tr></thead><tbody>
          {report.methods.map(row => <tr className="border-b" key={row.method}><td>{row.method}</td><td>{amount(row.revenue)}</td><td>{row.lines.toLocaleString("ar-EG")}</td></tr>)}
        </tbody></table></div>
      </section>
      <section className="space-y-2"><h2 className="text-lg font-semibold">أعلى 30 منتجًا بالمبيعات</h2>
        <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr className="border-b text-right"><th>SKU</th><th>المنتج</th><th>الكمية</th><th>المبيعات</th></tr></thead><tbody>
          {report.products.map(row => <tr className="border-b" key={`${row.sku}-${row.unit}`}><td>{row.sku}</td><td>{row.name}</td><td>{amount(row.quantity)} {row.unit}</td><td>{amount(row.revenue)}</td></tr>)}
        </tbody></table></div>
      </section>
      <p className="text-xs text-muted-foreground">حساب الكافيه الحالي: {cafe?.name ?? "—"}. رقم الفاتورة في المصدر يتكرر بأيام مختلفة، لذلك التقرير يعرض السطور الأصلية ولا يفترض عدد فواتير أو تحصيلات بنكية.</p>
      <section className="space-y-3">
        <h2 className="text-lg font-semibold">كل سطور البيع المستوردة</h2>
        <div className="flex flex-wrap gap-2">
          <select className="rounded border px-2 py-1" value={month} onChange={event => { setMonth(event.target.value); setPage(1); }}>
            <option value="">كل شهور السنة</option>
            {report.monthly.map(row => <option value={row.month} key={row.month}>{row.month}</option>)}
          </select>
          <input className="min-w-64 rounded border px-2 py-1" placeholder="ابحث بالـSKU أو المنتج أو الفاتورة" value={query} onChange={event => { setQuery(event.target.value); setPage(1); }} />
        </div>
        {saleLines && <>
          <p className="text-sm">{saleLines.total.toLocaleString("ar-EG")} سطر مطابق</p>
          <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr className="border-b text-right"><th>التاريخ</th><th>الفاتورة</th><th>SKU</th><th>المنتج</th><th>الكمية</th><th>سعر الوحدة</th><th>الخصم</th><th>الإجمالي</th><th>الدفع</th></tr></thead><tbody>
            {saleLines.rows.map(row => <tr className="border-b" key={row.sourceRow}><td className="whitespace-nowrap">{row.saleLocalDate}</td><td>{row.invoiceNo}</td><td>{row.sku}</td><td>{row.productName}</td><td>{amount(row.quantity)} {row.quantityUnit}</td><td>{amount(row.unitPrice)}</td><td>{amount(row.discount)}</td><td>{amount(row.total)}</td><td>{row.paymentMethod ?? "غير محدد"}</td></tr>)}
          </tbody></table></div>
          <div className="flex items-center gap-3">
            <button className="rounded border px-3 py-1 disabled:opacity-40" disabled={page <= 1} onClick={() => setPage(value => value - 1)}>السابق</button>
            <span>صفحة {page.toLocaleString("ar-EG")} من {Math.max(1, Math.ceil(saleLines.total / saleLines.pageSize)).toLocaleString("ar-EG")}</span>
            <button className="rounded border px-3 py-1 disabled:opacity-40" disabled={page * saleLines.pageSize >= saleLines.total} onClick={() => setPage(value => value + 1)}>التالي</button>
          </div>
        </>}
      </section>
    </>}
  </div>;
}
