"use client";

import { Suspense, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Percent,
  PieChart,
  Printer,
  TrendingDown,
  TrendingUp,
  Wallet,
} from "lucide-react";
import { toast } from "sonner";
import { useApp } from "@/components/app-shell";
import { useAccountingData } from "@/components/accounting/use-accounting-data";
import { EmptyState, LoadingState, Panel, StatCard } from "@/components/cafe/ui";
import { Button } from "@/components/ui/button";
import { nativeFieldClassName } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, money } from "@/lib/client";
import { dateStrInTz } from "@/lib/date-range";
import { cn } from "@/lib/utils";
import type { ExecutivePnlResult, PnlSection } from "@/lib/accounting/pnl";
import type { ShadowReport } from "@/lib/accounting/shadow-projection";

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
  const { cafe, user, canKey } = useApp();
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
    `/api/accounting/pnl?${queryParams.toString()}`,
  );

  const [initializing, setInitializing] = useState(false);
  const [projecting, setProjecting] = useState(false);

  const handleInitializeBooks = async () => {
    setInitializing(true);
    try {
      await api("/api/accounting/pnl", { method: "POST" });
      toast.success("تم تهيئة الدفاتر المحاسبية بنجاح");
      await reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "تعذّر تهيئة الدفاتر");
    } finally {
      setInitializing(false);
    }
  };

  const handleProject = async () => {
    if (!window.confirm(`ترحيل تجريبي لكل الفروع من ${from} إلى ${to}؟`)) return;
    setProjecting(true);
    try {
      const result = await api<ShadowReport>("/api/accounting/projection", { method: "POST", body: { from, to } });
      const summary = `تم ترحيل ${result.posted} قيد، و${result.replayed} سبق ترحيلها`;
      if (result.exceptions.length) {
        toast.warning(`${summary}. ${result.exceptions.length} حالة تحتاج مراجعة في صفحة التحكم والمطابقة.`);
      } else {
        toast.success(summary);
      }
      await reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "تعذّر تشغيل الترحيل التجريبي");
    } finally {
      setProjecting(false);
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
    } else {
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
    return <LoadingState label="جارٍ تحميل قائمة الأرباح والخسائر وحساب المؤشرات المالية…" />;
  }

  if (error) {
    return (
      <div role="alert" className="workspace-state text-destructive">
        <p className="font-semibold">{error}</p>
        <Button variant="outline" onClick={() => void reload()}>
          إعادة المحاولة
        </Button>
      </div>
    );
  }

  if (data && !data.configured) {
    return (
      <Panel title="الدفاتر المحاسبية غير مهيأة بعد">
        <div className="space-y-4">
          <EmptyState
            icon="📊"
            message="يلزم تهيئة دفاتر الكافيه أولًا قبل عرض قائمة الأرباح والخسائر وميزان المراجعة."
          />
          {!user.branchId && canKey("accounting.setup") && (
            <div className="flex justify-center">
              <Button onClick={handleInitializeBooks} disabled={initializing}>
                {initializing ? "جارٍ التهيئة…" : "تهيئة شجرة حسابات الكافيه"}
              </Button>
            </div>
          )}
        </div>
      </Panel>
    );
  }

  const kpis = data?.kpis;
  const compareKpis = data?.compareKpis;
  const primeCostPercent =
    kpis && kpis.netRevenue > 0
      ? Number((((kpis.cogs + kpis.operatingExpenses) / kpis.netRevenue) * 100).toFixed(1))
      : 0;
  const revenueDelta =
    kpis && compareKpis
      ? Number((((kpis.netRevenue - compareKpis.netRevenue) / (Math.abs(compareKpis.netRevenue) || 1)) * 100).toFixed(1))
      : null;

  return (
    <div className="space-y-5">
      <div className="workspace-toolbar space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
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

          <div className="flex flex-wrap items-center gap-2">
            <label className="flex cursor-pointer items-center gap-2 rounded-xl border border-input bg-card px-3 py-2 text-sm text-foreground hover:bg-muted/50">
              <input
                type="checkbox"
                checked={compare}
                onChange={(e) => setCompare(e.target.checked)}
                className="size-4 rounded accent-primary"
              />
              <span>مقارنة بالفترة السابقة</span>
            </label>

            <Button size="sm" variant="outline" onClick={() => window.print()} title="طباعة القائمة">
              <Printer className="size-4" />
              <span>طباعة</span>
            </Button>

            {!user.branchId && !branchId && canKey("accounting.project") && (
              <Button size="sm" variant="outline" onClick={handleProject} disabled={projecting || !from || !to || from > to}>
                {projecting ? "جارٍ الترحيل…" : "تشغيل الترحيل التجريبي"}
              </Button>
            )}
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="space-y-1">
            <Label htmlFor="pnl-from">من تاريخ</Label>
            <input
              id="pnl-from"
              type="date"
              dir="ltr"
              className={nativeFieldClassName}
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="pnl-to">إلى تاريخ</Label>
            <input
              id="pnl-to"
              type="date"
              dir="ltr"
              className={nativeFieldClassName}
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
          </div>
          {!user.branchId && (data?.branches?.length ?? 0) > 1 && (
            <div className="space-y-1">
              <Label htmlFor="pnl-branch">نطاق الفرع</Label>
              <select
                id="pnl-branch"
                className={nativeFieldClassName}
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
            </div>
          )}
          <div className="flex items-end pb-2 text-xs text-muted-foreground">
            القائمة تعرض القيود المرحلة فعليًا في الدفاتر فقط؛ النسب تحسب مقارنةً بصافي الإيرادات.
          </div>
        </div>
      </div>

      {kpis && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
          <StatCard
            label="صافي الإيرادات"
            value={fmt(kpis.netRevenue)}
            accent="emerald"
            icon={<TrendingUp className="size-5" />}
            hint={
              revenueDelta !== null ? (
                <span className={revenueDelta >= 0 ? "text-sage-ink font-medium" : "text-clay-ink font-medium"}>
                  {revenueDelta >= 0 ? `+${revenueDelta}%` : `${revenueDelta}%`} عن الفترة السابقة
                </span>
              ) : undefined
            }
          />
          <StatCard
            label="تكلفة المبيعات والهالك"
            value={fmt(kpis.cogs)}
            accent="amber"
            icon={<PieChart className="size-5" />}
            hint={<span>{kpis.cogsPercent}% من صافي الإيراد</span>}
          />
          <StatCard
            label="مجمل الربح"
            value={fmt(kpis.grossProfit)}
            accent="blue"
            icon={<Percent className="size-5" />}
            hint={<span>هامش المجمل {kpis.grossMarginPercent}%</span>}
          />
          <StatCard
            label="المصروفات التشغيلية"
            value={fmt(kpis.operatingExpenses)}
            accent="slate"
            icon={<Wallet className="size-5" />}
            hint={<span>{kpis.operatingExpensesPercent}% من صافي الإيراد</span>}
          />
          <StatCard
            label="نسبة التكلفة الأولية"
            value={`${primeCostPercent}%`}
            accent={primeCostPercent > 65 ? "red" : "amber"}
            icon={<PieChart className="size-5" />}
            hint={<span>تكلفة الخامات + المصروف التشغيلي</span>}
          />
          <StatCard
            label="صافي الربح النهائي"
            value={fmt(kpis.netProfit)}
            accent={kpis.netProfit >= 0 ? "emerald" : "red"}
            icon={kpis.netProfit >= 0 ? <TrendingUp className="size-5" /> : <TrendingDown className="size-5" />}
            hint={<span>هامش الصافي {kpis.netProfitMarginPercent}%</span>}
          />
        </div>
      )}

      {data?.sections && (
        <Panel title="قائمة الأرباح والخسائر التفصيلية" bodyClassName="p-0">
          <div className="overflow-x-auto">
            <Table className="workspace-table">
              <TableHeader>
                <TableRow>
                  <TableHead className="min-w-[260px]">البند المحاسبي</TableHead>
                  <TableHead className="min-w-[120px] text-end">الفترة الحالية ({from} ← {to})</TableHead>
                  <TableHead className="min-w-[80px] text-end">النسبة %</TableHead>
                  {compare && (
                    <>
                      <TableHead className="min-w-[120px] text-end">الفترة السابقة ({compareFrom} ← {compareTo})</TableHead>
                      <TableHead className="min-w-[100px] text-end">التغير</TableHead>
                      <TableHead className="min-w-[85px] text-end">النمو %</TableHead>
                    </>
                  )}
                </TableRow>
              </TableHeader>
              <TableBody className="text-sm">
                <SectionRows
                  section={data.sections.revenue}
                  isOpen={openSections.revenue}
                  onToggle={() => toggleSection("revenue")}
                  compare={compare}
                  currency={currency}
                  from={from}
                  to={to}
                  branchId={branchId}
                  subtotalLabel="صافي الإيرادات"
                  highlightClass="bg-sage-soft text-sage-ink"
                />
                <SectionRows
                  section={data.sections.cogs}
                  isOpen={openSections.cogs}
                  onToggle={() => toggleSection("cogs")}
                  compare={compare}
                  currency={currency}
                  from={from}
                  to={to}
                  branchId={branchId}
                  subtotalLabel="إجمالي تكلفة البضاعة المباعة"
                  highlightClass="bg-caramel-soft text-caramel-ink"
                />

                <TableRow className="border-y border-border bg-muted/50 font-bold text-base">
                  <TableCell>مجمل الربح</TableCell>
                  <TableCell className="text-end tabular-figures">{fmt(kpis?.grossProfit)}</TableCell>
                  <TableCell className="text-end tabular-figures text-primary">{kpis?.grossMarginPercent}%</TableCell>
                  {compare && (
                    <>
                      <TableCell className="text-end tabular-figures">{fmt(compareKpis?.grossProfit)}</TableCell>
                      <TableCell className="text-end tabular-figures text-muted-foreground">
                        {fmt((kpis?.grossProfit ?? 0) - (compareKpis?.grossProfit ?? 0))}
                      </TableCell>
                      <TableCell className="text-end tabular-figures font-semibold">
                        {compareKpis?.grossProfit ? (
                          <span className={(kpis?.grossProfit ?? 0) >= compareKpis.grossProfit ? "text-sage-ink" : "text-clay-ink"}>
                            {(((kpis?.grossProfit ?? 0) - compareKpis.grossProfit) / (Math.abs(compareKpis.grossProfit) || 1) * 100).toFixed(1)}%
                          </span>
                        ) : "—"}
                      </TableCell>
                    </>
                  )}
                </TableRow>

                <SectionRows
                  section={data.sections.expenses}
                  isOpen={openSections.expenses}
                  onToggle={() => toggleSection("expenses")}
                  compare={compare}
                  currency={currency}
                  from={from}
                  to={to}
                  branchId={branchId}
                  subtotalLabel="إجمالي المصروفات التشغيلية"
                  highlightClass="bg-tide-soft text-tide-ink"
                />

                <TableRow className="bg-muted/35 font-semibold">
                  <TableCell>الربح التشغيلي</TableCell>
                  <TableCell className="text-end tabular-figures">{fmt(kpis?.operatingProfit)}</TableCell>
                  <TableCell className="text-end tabular-figures text-muted-foreground">{kpis?.operatingMarginPercent}%</TableCell>
                  {compare && (
                    <>
                      <TableCell className="text-end tabular-figures">
                        {fmt((compareKpis?.grossProfit ?? 0) - (compareKpis?.operatingExpenses ?? 0))}
                      </TableCell>
                      <TableCell colSpan={2} />
                    </>
                  )}
                </TableRow>

                <SectionRows
                  section={data.sections.variances}
                  isOpen={openSections.variances}
                  onToggle={() => toggleSection("variances")}
                  compare={compare}
                  currency={currency}
                  from={from}
                  to={to}
                  branchId={branchId}
                  subtotalLabel="صافي الفروقات والتسويات"
                  highlightClass="bg-muted/30 text-foreground"
                />

                <TableRow
                  className={cn(
                    "border-t-2 font-bold text-base",
                    (kpis?.netProfit ?? 0) >= 0
                      ? "border-sage-line bg-sage-soft text-sage-ink"
                      : "border-clay-line bg-clay-soft text-clay-ink",
                  )}
                >
                  <TableCell>صافي الربح النهائي</TableCell>
                  <TableCell className="text-end tabular-figures">{fmt(kpis?.netProfit)}</TableCell>
                  <TableCell className="text-end tabular-figures">{kpis?.netProfitMarginPercent}%</TableCell>
                  {compare && (
                    <>
                      <TableCell className="text-end tabular-figures">{fmt(compareKpis?.netProfit)}</TableCell>
                      <TableCell className="text-end tabular-figures">
                        {fmt((kpis?.netProfit ?? 0) - (compareKpis?.netProfit ?? 0))}
                      </TableCell>
                      <TableCell className="text-end tabular-figures">
                        {compareKpis?.netProfit ? (
                          <span>
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
        </Panel>
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
  branchId,
  subtotalLabel,
  highlightClass,
}: {
  section: PnlSection;
  isOpen: boolean;
  onToggle: () => void;
  compare: boolean;
  currency: string;
  from: string;
  to: string;
  branchId: string;
  subtotalLabel: string;
  highlightClass: string;
}) {
  const fmt = (n: number | undefined) => (n === undefined ? "—" : money(n, currency));

  return (
    <>
      <TableRow onClick={onToggle} className="cursor-pointer bg-muted/30 font-semibold transition-colors hover:bg-muted/50">
        <TableCell colSpan={compare ? 6 : 3} className="py-2.5">
          <div className="flex items-center gap-2">
            {isOpen ? <ChevronDown className="size-4 text-muted-foreground" /> : <ChevronRight className="size-4 text-muted-foreground" />}
            <span>{section.title}</span>
            <span className="text-xs font-normal text-muted-foreground">({section.lines.length} حساب)</span>
          </div>
        </TableCell>
      </TableRow>

      {isOpen &&
        section.lines.map((l) => {
          const ledgerParams = new URLSearchParams({
            account: l.accountId,
            from,
            to,
            ...(branchId ? { branchId } : {}),
          });
          return (
            <TableRow key={l.accountId || l.code || l.name} className="hover:bg-muted/20">
              <TableCell className="ps-8">
                <div className="flex items-center gap-2">
                  <span dir="ltr" className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground tabular-figures">
                    {l.code}
                  </span>
                  <Link
                    href={`/accounting/ledger?${ledgerParams.toString()}`}
                    className="group flex items-center gap-1 font-medium text-primary hover:underline"
                    title="فتح سجل دفتر الأستاذ لهذا الحساب"
                  >
                    <span>{l.name}</span>
                    <ExternalLink className="size-3 opacity-0 transition-opacity group-hover:opacity-100" />
                  </Link>
                </div>
              </TableCell>
              <TableCell className="text-end tabular-figures">{fmt(l.amount)}</TableCell>
              <TableCell className="text-end tabular-figures text-muted-foreground">{l.percentOfRevenue}%</TableCell>
              {compare && (
                <>
                  <TableCell className="text-end tabular-figures text-muted-foreground">{fmt(l.compareAmount)}</TableCell>
                  <TableCell className="text-end tabular-figures text-muted-foreground">{fmt(l.changeAmount)}</TableCell>
                  <TableCell className="text-end tabular-figures">
                    {l.changePercent !== null && l.changePercent !== undefined ? (
                      <span className={l.changePercent >= 0 ? "text-sage-ink" : "text-clay-ink"}>
                        {l.changePercent >= 0 ? `+${l.changePercent}%` : `${l.changePercent}%`}
                      </span>
                    ) : "—"}
                  </TableCell>
                </>
              )}
            </TableRow>
          );
        })}

      <TableRow className={cn("font-semibold", highlightClass)}>
        <TableCell className="ps-6">{subtotalLabel}</TableCell>
        <TableCell className="text-end tabular-figures">{fmt(section.total)}</TableCell>
        <TableCell className="text-end tabular-figures">{section.percentOfRevenue}%</TableCell>
        {compare && (
          <>
            <TableCell className="text-end tabular-figures">{fmt(section.compareTotal)}</TableCell>
            <TableCell className="text-end tabular-figures">{fmt(section.changeAmount)}</TableCell>
            <TableCell className="text-end tabular-figures">
              {section.changePercent !== null && section.changePercent !== undefined ? (
                <span>{section.changePercent >= 0 ? `+${section.changePercent}%` : `${section.changePercent}%`}</span>
              ) : "—"}
            </TableCell>
          </>
        )}
      </TableRow>
    </>
  );
}

export default function PnlPage() {
  return (
    <Suspense fallback={<LoadingState label="جارٍ تحميل قائمة الأرباح والخسائر…" />}>
      <PnlContent />
    </Suspense>
  );
}
