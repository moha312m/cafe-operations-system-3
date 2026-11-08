"use client";

import { Suspense, useState, useMemo } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useApp } from "@/components/app-shell";
import { useAccountingData } from "@/components/accounting/use-accounting-data";
import { money } from "@/lib/client";
import { dateStrInTz } from "@/lib/date-range";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  TrendingUp,
  TrendingDown,
  DollarSign,
  PieChart,
  Percent,
  Wallet,
  Building2,
  Calendar,
  Printer,
  ChevronDown,
  ChevronRight,
  ExternalLink,
} from "lucide-react";
import type { ExecutivePnlResult, PnlSection, PnlLine } from "@/lib/accounting/pnl";

function getMonthDates(offset: number = 0) {
  const d = new Date();
  d.setMonth(d.getMonth() + offset);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const lastDay = new Date(year, d.getMonth() + 1, 0).getDate();
  return {
    from: `${year}-${month}-01`,
    to: `${year}-${month}-${String(lastDay).padStart(2, "0")}`,
  };
}

function PnlContent() {
  const { cafe, user } = useApp();
  const currency = cafe?.currency ?? "EGP";
  const searchParams = useSearchParams();

  const thisMonth = useMemo(() => getMonthDates(0), []);
  const lastMonth = useMemo(() => getMonthDates(-1), []);

  const [from, setFrom] = useState(searchParams.get("from") || thisMonth.from);
  const [to, setTo] = useState(searchParams.get("to") || thisMonth.to);
  const [branchId, setBranchId] = useState(user.branchId || searchParams.get("branchId") || "");
  const [compare, setCompare] = useState(true);
  const [compareFrom, setCompareFrom] = useState(lastMonth.from);
  const [compareTo, setCompareTo] = useState(lastMonth.to);

  // Collapse state for sections
  const [openSections, setOpenSections] = useState<Record<string, boolean>>({
    revenue: true,
    cogs: true,
    expenses: true,
    variances: true,
  });

  const toggleSection = (id: string) => {
    setOpenSections((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const queryParams = new URLSearchParams({
    from,
    to,
    ...(branchId ? { branchId } : {}),
    ...(compare ? { compareFrom, compareTo } : {}),
  });

  const { data, error, loading, reload } = useAccountingData<ExecutivePnlResult>(
    `/api/accounting/pnl?${queryParams.toString()}`
  );

  const [initializing, setInitializing] = useState(false);
  const handleInitializeBooks = async () => {
    setInitializing(true);
    try {
      const res = await fetch("/api/accounting/pnl", { method: "POST" });
      if (res.ok) {
        await reload();
      }
    } finally {
      setInitializing(false);
    }
  };

  const handlePreset = (type: "thisMonth" | "lastMonth" | "today") => {
    const today = dateStrInTz(new Date());
    if (type === "thisMonth") {
      setFrom(thisMonth.from);
      setTo(thisMonth.to);
      setCompareFrom(lastMonth.from);
      setCompareTo(lastMonth.to);
    } else if (type === "lastMonth") {
      setFrom(lastMonth.from);
      setTo(lastMonth.to);
      const twoMonthsAgo = getMonthDates(-2);
      setCompareFrom(twoMonthsAgo.from);
      setCompareTo(twoMonthsAgo.to);
    } else if (type === "today") {
      setFrom(today);
      setTo(today);
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const yStr = dateStrInTz(yesterday);
      setCompareFrom(yStr);
      setCompareTo(yStr);
    }
  };

  const fmt = (n: number | undefined) => (n === undefined ? "—" : money(n, currency));

  if (loading) {
    return (
      <div className="space-y-4 py-8 text-center">
        <div className="mx-auto h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
        <p className="text-sm text-muted-foreground">جارٍ تحميل قائمة الأرباح والخسائر وحساب المؤشرات المالية…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-xl border border-destructive/20 bg-destructive/10 p-6 text-center text-destructive">
        <p className="font-semibold">{error}</p>
        <Button variant="outline" className="mt-3" onClick={() => void reload()}>
          إعادة المحاولة
        </Button>
      </div>
    );
  }

  if (data && !data.configured) {
    return (
      <Card className="border-caramel-line bg-caramel-soft/40 p-8 text-center">
        <CardHeader>
          <CardTitle className="text-xl">الدفاتر المحاسبية غير مهيأة بعد</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="mx-auto max-w-md text-sm text-muted-foreground">
            تعتمد قائمة الأرباح والخسائر وميزان المراجعة على شجرة حسابات قياسية وقيد مزدوج. يمكنك تهيئة دفاتر الكافيه تلقائياً بنقرة واحدة للبدء فوراً.
          </p>
          <Button onClick={handleInitializeBooks} disabled={initializing} className="px-6">
            {initializing ? "جارٍ التهيئة…" : "تهيئة شجرة حسابات الكافيه والبدء"}
          </Button>
        </CardContent>
      </Card>
    );
  }

  const kpis = data?.kpis;
  const compareKpis = data?.compareKpis;

  return (
    <div className="space-y-6">
      {/* Top Filter and Controls Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-card p-4">
        {/* Preset Buttons */}
        <div className="flex flex-wrap items-center gap-1.5">
          <Button
            size="sm"
            variant={from === thisMonth.from && to === thisMonth.to ? "default" : "outline"}
            onClick={() => handlePreset("thisMonth")}
          >
            الشهر الحالي
          </Button>
          <Button
            size="sm"
            variant={from === lastMonth.from && to === lastMonth.to ? "default" : "outline"}
            onClick={() => handlePreset("lastMonth")}
          >
            الشهر الماضي
          </Button>
          <Button size="sm" variant="outline" onClick={() => handlePreset("today")}>
            اليوم
          </Button>
        </div>

        {/* Date Pickers */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-muted-foreground">من:</span>
            <input
              type="date"
              className="rounded-lg border bg-background px-2.5 py-1 text-sm"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-muted-foreground">إلى:</span>
            <input
              type="date"
              className="rounded-lg border bg-background px-2.5 py-1 text-sm"
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
          </div>

          {/* Branch Filter */}
          {!user.branchId && (data?.branches?.length ?? 0) > 1 && (
            <select
              className="rounded-lg border bg-background px-2.5 py-1 text-sm"
              value={branchId}
              onChange={(e) => setBranchId(e.target.value)}
            >
              <option value="">كل الفروع</option>
              {data?.branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          )}

          {/* Compare Toggle */}
          <label className="flex cursor-pointer items-center gap-1.5 rounded-lg border px-2.5 py-1 text-sm hover:bg-muted/50">
            <input
              type="checkbox"
              checked={compare}
              onChange={(e) => setCompare(e.target.checked)}
              className="rounded"
            />
            <span>مقارنة بالفترة السابقة</span>
          </label>

          {/* Print Button */}
          <Button size="sm" variant="ghost" onClick={() => window.print()} title="طباعة القائمة">
            <Printer className="size-4" />
          </Button>
        </div>
      </div>

      {/* KPI Header Metric Cards (Odoo-Style Highlights) */}
      {kpis && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {/* 1. Net Revenue */}
          <Card className="border-t-4 border-t-emerald-500">
            <CardHeader className="pb-1 pt-3">
              <CardTitle className="text-xs font-medium text-muted-foreground">صافي الإيرادات (Net Sales)</CardTitle>
            </CardHeader>
            <CardContent className="pb-3">
              <div className="text-xl font-bold tabular-nums text-foreground">{fmt(kpis.netRevenue)}</div>
              {compareKpis && (
                <div className="mt-1 flex items-center gap-1 text-xs">
                  {kpis.netRevenue >= compareKpis.netRevenue ? (
                    <span className="flex items-center text-emerald-600 font-medium">
                      <TrendingUp className="me-0.5 size-3" />
                      +{(((kpis.netRevenue - compareKpis.netRevenue) / (compareKpis.netRevenue || 1)) * 100).toFixed(1)}%
                    </span>
                  ) : (
                    <span className="flex items-center text-red-600 font-medium">
                      <TrendingDown className="me-0.5 size-3" />
                      {(((kpis.netRevenue - compareKpis.netRevenue) / (compareKpis.netRevenue || 1)) * 100).toFixed(1)}%
                    </span>
                  )}
                  <span className="text-muted-foreground">مقارنة بالسابق</span>
                </div>
              )}
            </CardContent>
          </Card>

          {/* 2. COGS */}
          <Card className="border-t-4 border-t-amber-500">
            <CardHeader className="pb-1 pt-3">
              <CardTitle className="text-xs font-medium text-muted-foreground">تكلفة الخامات (COGS)</CardTitle>
            </CardHeader>
            <CardContent className="pb-3">
              <div className="text-xl font-bold tabular-nums text-foreground">{fmt(kpis.cogs)}</div>
              <div className="mt-1 text-xs text-muted-foreground">
                تمثل <span className="font-semibold text-amber-700 dark:text-amber-400">{kpis.cogsPercent}%</span> من الإيراد
              </div>
            </CardContent>
          </Card>

          {/* 3. Gross Profit & Margin */}
          <Card className="border-t-4 border-t-blue-500">
            <CardHeader className="pb-1 pt-3">
              <CardTitle className="text-xs font-medium text-muted-foreground">مجمل الربح (Gross Profit)</CardTitle>
            </CardHeader>
            <CardContent className="pb-3">
              <div className="text-xl font-bold tabular-nums text-foreground">{fmt(kpis.grossProfit)}</div>
              <div className="mt-1 text-xs text-muted-foreground">
                هامش مجمل: <span className="font-semibold text-blue-700 dark:text-blue-400">{kpis.grossMarginPercent}%</span>
              </div>
            </CardContent>
          </Card>

          {/* 4. Operating Expenses */}
          <Card className="border-t-4 border-t-purple-500">
            <CardHeader className="pb-1 pt-3">
              <CardTitle className="text-xs font-medium text-muted-foreground">المصروفات التشغيلية (OpEx)</CardTitle>
            </CardHeader>
            <CardContent className="pb-3">
              <div className="text-xl font-bold tabular-nums text-foreground">{fmt(kpis.operatingExpenses)}</div>
              <div className="mt-1 text-xs text-muted-foreground">
                تمثل <span className="font-semibold text-purple-700 dark:text-purple-400">{kpis.operatingExpensesPercent}%</span>
              </div>
            </CardContent>
          </Card>

          {/* 5. Net Profit (Bottom Line) */}
          <Card className={`col-span-2 sm:col-span-1 border-t-4 ${kpis.netProfit >= 0 ? "border-t-emerald-600 bg-emerald-500/5" : "border-t-red-600 bg-red-500/5"}`}>
            <CardHeader className="pb-1 pt-3">
              <CardTitle className="text-xs font-medium text-muted-foreground">صافي الربح النهائي (Net Profit)</CardTitle>
            </CardHeader>
            <CardContent className="pb-3">
              <div className={`text-xl font-bold tabular-nums ${kpis.netProfit >= 0 ? "text-emerald-700 dark:text-emerald-300" : "text-red-700 dark:text-red-300"}`}>
                {fmt(kpis.netProfit)}
              </div>
              <div className="mt-1 text-xs text-muted-foreground">
                هامش صافي: <span className="font-bold">{kpis.netProfitMarginPercent}%</span>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Main Odoo-Style Hierarchical P&L Table */}
      {data?.sections && (
        <div className="overflow-x-auto rounded-xl border bg-card">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/50 font-semibold">
                <TableHead className="min-w-[280px]">بند الحساب (Account Item)</TableHead>
                <TableHead className="text-end min-w-[120px]">الفترة الحالية ({from} ← {to})</TableHead>
                <TableHead className="text-end min-w-[80px]">النسبة %</TableHead>
                {compare && (
                  <>
                    <TableHead className="text-end min-w-[120px]">الفترة السابقة ({compareFrom} ← {compareTo})</TableHead>
                    <TableHead className="text-end min-w-[100px]">التغير المالي</TableHead>
                    <TableHead className="text-end min-w-[90px]">النمو %</TableHead>
                  </>
                )}
              </TableRow>
            </TableHeader>
            <TableBody className="text-sm">
              {/* 1. REVENUE SECTION */}
              <SectionRows
                section={data.sections.revenue}
                isOpen={openSections.revenue}
                onToggle={() => toggleSection("revenue")}
                compare={compare}
                currency={currency}
                from={from}
                to={to}
                subtotalLabel="صافي الإيرادات (Net Revenue)"
                highlight="bg-emerald-500/10 text-emerald-900 dark:text-emerald-200"
              />

              {/* 2. COGS SECTION */}
              <SectionRows
                section={data.sections.cogs}
                isOpen={openSections.cogs}
                onToggle={() => toggleSection("cogs")}
                compare={compare}
                currency={currency}
                from={from}
                to={to}
                subtotalLabel="إجمالي تكلفة المبيعات (Total COGS)"
                highlight="bg-amber-500/10 text-amber-900 dark:text-amber-200"
              />

              {/* GROSS PROFIT ROW */}
              <TableRow className="border-y-2 border-primary/20 bg-muted/60 font-bold text-base">
                <TableCell colSpan={1}>مجمل الربح (Gross Profit)</TableCell>
                <TableCell className="text-end tabular-nums">{fmt(kpis?.grossProfit)}</TableCell>
                <TableCell className="text-end tabular-nums text-primary font-semibold">{kpis?.grossMarginPercent}%</TableCell>
                {compare && (
                  <>
                    <TableCell className="text-end tabular-nums">{fmt(compareKpis?.grossProfit)}</TableCell>
                    <TableCell className="text-end tabular-nums text-muted-foreground">
                      {fmt((kpis?.grossProfit ?? 0) - (compareKpis?.grossProfit ?? 0))}
                    </TableCell>
                    <TableCell className="text-end tabular-nums font-semibold">
                      {compareKpis?.grossProfit ? (
                        <span className={(kpis?.grossProfit ?? 0) >= compareKpis.grossProfit ? "text-emerald-600" : "text-red-600"}>
                          {(((kpis?.grossProfit ?? 0) - compareKpis.grossProfit) / (compareKpis.grossProfit || 1) * 100).toFixed(1)}%
                        </span>
                      ) : "—"}
                    </TableCell>
                  </>
                )}
              </TableRow>

              {/* 3. OPERATING EXPENSES SECTION */}
              <SectionRows
                section={data.sections.expenses}
                isOpen={openSections.expenses}
                onToggle={() => toggleSection("expenses")}
                compare={compare}
                currency={currency}
                from={from}
                to={to}
                subtotalLabel="إجمالي المصروفات التشغيلية (Total OpEx)"
                highlight="bg-purple-500/10 text-purple-900 dark:text-purple-200"
              />

              {/* OPERATING PROFIT ROW */}
              <TableRow className="bg-muted/40 font-semibold">
                <TableCell colSpan={1}>الربح التشغيلي (Operating Profit / EBITDA)</TableCell>
                <TableCell className="text-end tabular-nums">{fmt(kpis?.operatingProfit)}</TableCell>
                <TableCell className="text-end tabular-nums text-muted-foreground">{kpis?.operatingMarginPercent}%</TableCell>
                {compare && (
                  <>
                    <TableCell className="text-end tabular-nums">{fmt((compareKpis?.grossProfit ?? 0) - (compareKpis?.operatingExpenses ?? 0))}</TableCell>
                    <TableCell colSpan={2} />
                  </>
                )}
              </TableRow>

              {/* 4. VARIANCES & OTHER ADJUSTMENTS */}
              <SectionRows
                section={data.sections.variances}
                isOpen={openSections.variances}
                onToggle={() => toggleSection("variances")}
                compare={compare}
                currency={currency}
                from={from}
                to={to}
                subtotalLabel="صافي الفروقات والتسويات (Net Variances)"
              />

              {/* FINAL NET PROFIT / BOTTOM LINE ROW */}
              <TableRow className="border-t-2 border-emerald-600 bg-emerald-600/10 font-bold text-lg">
                <TableCell colSpan={1} className="text-emerald-950 dark:text-emerald-100">
                  ★ صافي الربح النهائي (Net Profit / Bottom Line)
                </TableCell>
                <TableCell className="text-end tabular-nums text-emerald-700 dark:text-emerald-300">
                  {fmt(kpis?.netProfit)}
                </TableCell>
                <TableCell className="text-end tabular-nums text-emerald-700 dark:text-emerald-300">
                  {kpis?.netProfitMarginPercent}%
                </TableCell>
                {compare && (
                  <>
                    <TableCell className="text-end tabular-nums">{fmt(compareKpis?.netProfit)}</TableCell>
                    <TableCell className="text-end tabular-nums">
                      {fmt((kpis?.netProfit ?? 0) - (compareKpis?.netProfit ?? 0))}
                    </TableCell>
                    <TableCell className="text-end tabular-nums">
                      {compareKpis?.netProfit ? (
                        <span className={(kpis?.netProfit ?? 0) >= compareKpis.netProfit ? "text-emerald-600" : "text-red-600"}>
                          {(((kpis?.netProfit ?? 0) - compareKpis.netProfit) / (Math.abs(compareKpis.netProfit) || 1) * 100).toFixed(1)}%
                        </span>
                      ) : "—"}
                    </TableCell>
                  </>
                )}
              </TableRow>
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

function SectionRows({
  section,
  isOpen,
  onToggle,
  compare,
  currency,
  from,
  to,
  subtotalLabel,
  highlight,
}: {
  section: PnlSection;
  isOpen: boolean;
  onToggle: () => void;
  compare: boolean;
  currency: string;
  from: string;
  to: string;
  subtotalLabel: string;
  highlight?: string;
}) {
  const fmt = (n: number | undefined) => (n === undefined ? "—" : money(n, currency));

  return (
    <>
      {/* Section Header Row */}
      <TableRow
        onClick={onToggle}
        className="cursor-pointer bg-muted/30 font-semibold hover:bg-muted/50 transition-colors"
      >
        <TableCell colSpan={compare ? 6 : 3} className="py-2.5">
          <div className="flex items-center gap-2">
            {isOpen ? <ChevronDown className="size-4 text-muted-foreground" /> : <ChevronRight className="size-4 text-muted-foreground" />}
            <span>{section.title}</span>
            <span className="text-xs text-muted-foreground">({section.lines.length} حسابات)</span>
          </div>
        </TableCell>
      </TableRow>

      {/* Individual Account Lines (Shown if section is open) */}
      {isOpen &&
        section.lines.map((l) => (
          <TableRow key={l.accountId || l.code || l.name} className="hover:bg-muted/20">
            <TableCell className="ps-8">
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground tabular-nums">{l.code}</span>
                <Link
                  href={`/accounting/ledger?account=${l.accountId}&from=${from}&to=${to}`}
                  className="font-medium text-primary hover:underline flex items-center gap-1 group"
                  title="النزول لحركات دفتر الأستاذ (Drill-down)"
                >
                  <span>{l.name}</span>
                  <ExternalLink className="size-3 opacity-0 group-hover:opacity-100 transition-opacity" />
                </Link>
              </div>
            </TableCell>
            <TableCell className="text-end tabular-nums">{fmt(l.amount)}</TableCell>
            <TableCell className="text-end tabular-nums text-muted-foreground">{l.percentOfRevenue}%</TableCell>
            {compare && (
              <>
                <TableCell className="text-end tabular-nums text-muted-foreground">{fmt(l.compareAmount)}</TableCell>
                <TableCell className="text-end tabular-nums text-muted-foreground">{fmt(l.changeAmount)}</TableCell>
                <TableCell className="text-end tabular-nums">
                  {l.changePercent !== null && l.changePercent !== undefined ? (
                    <span className={l.changePercent >= 0 ? "text-emerald-600" : "text-red-600"}>
                      {l.changePercent >= 0 ? `+${l.changePercent}%` : `${l.changePercent}%`}
                    </span>
                  ) : (
                    "—"
                  )}
                </TableCell>
              </>
            )}
          </TableRow>
        ))}

      {/* Section Subtotal Row */}
      <TableRow className={`font-semibold ${highlight ?? "bg-muted/40"}`}>
        <TableCell className="ps-6">{subtotalLabel}</TableCell>
        <TableCell className="text-end tabular-nums">{fmt(section.total)}</TableCell>
        <TableCell className="text-end tabular-nums">{section.percentOfRevenue}%</TableCell>
        {compare && (
          <>
            <TableCell className="text-end tabular-nums">{fmt(section.compareTotal)}</TableCell>
            <TableCell className="text-end tabular-nums">{fmt(section.changeAmount)}</TableCell>
            <TableCell className="text-end tabular-nums">
              {section.changePercent !== null && section.changePercent !== undefined ? (
                <span className={section.changePercent >= 0 ? "text-emerald-600" : "text-red-600"}>
                  {section.changePercent >= 0 ? `+${section.changePercent}%` : `${section.changePercent}%`}
                </span>
              ) : (
                "—"
              )}
            </TableCell>
          </>
        )}
      </TableRow>
    </>
  );
}

export default function PnlPage() {
  return (
    <Suspense fallback={<p className="p-8 text-center text-muted-foreground">جارٍ تحميل قائمة الأرباح والخسائر…</p>}>
      <PnlContent />
    </Suspense>
  );
}
