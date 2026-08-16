"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { api, money } from "@/lib/client";
import { t, formatWeekday, formatTime } from "@/lib/i18n";
import { useApp } from "@/components/app-shell";
import { normalizeRangeKey, type RangeKey } from "@/lib/date-range";
import type { OrderStatus, OrderSource } from "@prisma/client";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  PageHeader, StatCard, Panel, BarChart, RankBars, Donut,
  StatusBadge, SourceBadge, EmptyState, LoadingState,
} from "@/components/cafe/ui";

// Applied date filter (mirrors URL query params).
type DateFilter = { range: RangeKey; date?: string; from?: string; to?: string };

type DashboardData = {
  range: string;
  period: { from: string; to: string };
  todayRevenue: number;
  todayOrders: number;
  ordersAll: number;
  completedOrders: number;
  cancelledOrders: number;
  averageOrderValue: number;
  openOrders: number;
  openShifts: number;
  closedShiftsToday: number;
  netCash: number;
  taxTotal: number;
  serviceTotal: number;
  uncollectedTotal: number;
  pendingCount: number;
  partialCount: number;
  prev: { revenue: number; orders: number };
  revenueByDay: { date: string; revenue: number; orders: number }[];
  paymentSplit: { method: string; value: number }[];
  ordersBySource: { source: OrderSource; count: number }[];
  branchPerformance: { name: string; value: number }[];
  topCashiers: { name: string; value: number }[];
  bestBranch: { name: string; value: number } | null;
  bestProduct: { name: string; quantity: number; revenue: number } | null;
  worstProduct: { name: string; quantity: number; revenue: number } | null;
  bestCashier: { name: string; value: number } | null;
  qrOrders: number;
  cashierOrders: number;
  latestClosedShift: {
    shiftNumber: number; closedAt: string; cashier: string; branch: string;
    totalSales: number; cashDifference: number;
  } | null;
  recentOrders: {
    id: string; orderNumber: number; status: OrderStatus; source: OrderSource;
    total: number; paymentStatus: string; remaining: number;
    table: string | null; customer: string | null; branch: string; createdAt: string;
  }[];
  recentShifts: {
    id: string; shiftNumber: number; status: string; openedAt: string; closedAt: string | null;
    totalSales: number; cashDifference: number | null; cashier: string; branch: string;
  }[];
  pendingCollectionOrders: { id: string; orderNumber: number; total: number; remaining: number; branch: string }[];
  topProducts: { name: string; quantity: number; revenue: number }[];
  leastProducts: { name: string; quantity: number; revenue: number }[];
  lowStockItems: { name: string; stock: number; min: number; unit: string }[];
  branches: { id: string; name: string }[];
  inventory?: { lowStockCount: number; outOfStockCount: number };
  recipes?: {
    withoutRecipe: number;
    lowMargin: number;
    topProduct: { name: string; profit: number; margin: number } | null;
  } | null;
  purchases?: { periodTotal: number; unpaidCount: number } | null;
};

const RANGES: { key: RangeKey; label: string }[] = [
  { key: "today", label: "النهارده" },
  { key: "yesterday", label: "أمس" },
  { key: "last_3_days", label: "آخر 3 أيام" },
  { key: "last_7_days", label: "آخر 7 أيام" },
  { key: "last_30_days", label: "آخر 30 يوم" },
  { key: "month", label: "هذا الشهر" },
  { key: "custom_day", label: "تاريخ مخصص" },
  { key: "custom_range", label: "مدة مخصصة" },
];
const RANGE_LABEL = Object.fromEntries(RANGES.map((r) => [r.key, r.label]));

const SOURCE_LABEL: Record<string, string> = {
  QR_MENU: "منيو QR", WAITER: "ويتر", CASHIER_POS: "الكاشير",
};

// "5 أغسطس 2026" from a local YYYY-MM-DD string.
function arDate(dateStr: string): string {
  return new Date(`${dateStr}T12:00:00`).toLocaleDateString("ar-EG", {
    day: "numeric", month: "long", year: "numeric",
  });
}

function periodLabel(filter: DateFilter, period?: { from: string; to: string }): string {
  if (filter.range === "custom_day" && filter.date) return `الفترة: ${arDate(filter.date)}`;
  if (filter.range === "custom_range" && filter.from && filter.to)
    return `الفترة: من ${arDate(filter.from)} إلى ${arDate(filter.to)}`;
  if (period && (filter.range === "last_3_days" || filter.range === "last_7_days" || filter.range === "last_30_days" || filter.range === "month"))
    return `الفترة: ${RANGE_LABEL[filter.range]} (${arDate(period.from)} — ${arDate(period.to)})`;
  return `الفترة: ${RANGE_LABEL[filter.range]}`;
}

export default function DashboardPage() {
  // useSearchParams needs a Suspense boundary for prerendering.
  return (
    <Suspense fallback={<LoadingState label={t.common.loading} />}>
      <DashboardInner />
    </Suspense>
  );
}

function DashboardInner() {
  const { cafe, user, branchName } = useApp();
  const currency = cafe?.currency ?? "EGP";
  const fmt = (v: number) => money(v, currency);
  const router = useRouter();
  const searchParams = useSearchParams();

  const [data, setData] = useState<DashboardData | null>(null);
  const [branchId, setBranchId] = useState<string>("all");
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  // Applied filter — initialized from the URL so refresh/share keeps it.
  const [filter, setFilter] = useState<DateFilter>(() => ({
    range: normalizeRangeKey(searchParams.get("range")),
    date: searchParams.get("date") ?? undefined,
    from: searchParams.get("from") ?? undefined,
    to: searchParams.get("to") ?? undefined,
  }));
  // Picker drafts (edited before تطبيق).
  const [draftMode, setDraftMode] = useState<"custom_day" | "custom_range" | null>(
    filter.range === "custom_day" || filter.range === "custom_range" ? filter.range : null
  );
  const [draftDate, setDraftDate] = useState(filter.date ?? "");
  const [draftFrom, setDraftFrom] = useState(filter.from ?? "");
  const [draftTo, setDraftTo] = useState(filter.to ?? "");
  const [filterError, setFilterError] = useState<string | null>(null);

  // Persist the applied filter in the URL (shareable / survives refresh).
  const applyFilter = useCallback((next: DateFilter) => {
    setFilter(next);
    const qs = new URLSearchParams();
    if (next.range !== "today") qs.set("range", next.range);
    if (next.range === "custom_day" && next.date) qs.set("date", next.date);
    if (next.range === "custom_range" && next.from && next.to) {
      qs.set("from", next.from);
      qs.set("to", next.to);
    }
    router.replace(`/dashboard${qs.size ? `?${qs}` : ""}`, { scroll: false });
  }, [router]);

  function pickQuickRange(key: RangeKey) {
    setFilterError(null);
    if (key === "custom_day" || key === "custom_range") {
      setDraftMode(key); // pickers open; applied filter unchanged until تطبيق
      return;
    }
    setDraftMode(null);
    applyFilter({ range: key });
  }

  function applyCustom() {
    if (draftMode === "custom_day") {
      if (!draftDate) return setFilterError("من فضلك اختر اليوم");
      setFilterError(null);
      applyFilter({ range: "custom_day", date: draftDate });
    } else if (draftMode === "custom_range") {
      if (!draftFrom) return setFilterError("من فضلك اختر تاريخ البداية");
      if (!draftTo) return setFilterError("من فضلك اختر تاريخ النهاية");
      if (draftFrom > draftTo)
        return setFilterError("تاريخ البداية لا يمكن أن يكون بعد تاريخ النهاية");
      setFilterError(null);
      applyFilter({ range: "custom_range", from: draftFrom, to: draftTo });
    }
  }

  function resetFilter() {
    setDraftMode(null);
    setDraftDate(""); setDraftFrom(""); setDraftTo("");
    setFilterError(null);
    applyFilter({ range: "today" });
  }

  const load = useCallback(async () => {
    try {
      setRefreshing(true);
      const qs = new URLSearchParams();
      if (branchId !== "all") qs.set("branchId", branchId);
      qs.set("range", filter.range);
      if (filter.date) qs.set("date", filter.date);
      if (filter.from) qs.set("from", filter.from);
      if (filter.to) qs.set("to", filter.to);
      setData(await api<DashboardData>(`/api/dashboard?${qs.toString()}`));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "فشل تحميل اللوحة");
    } finally {
      setRefreshing(false);
    }
  }, [branchId, filter]);

  useEffect(() => { load(); }, [load]);

  // Refetch when the tab regains focus so cards never go stale after
  // actions taken elsewhere (closing a shift, collecting a payment…).
  useEffect(() => {
    const onFocus = () => load();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [load]);

  const title =
    user.role === "CAFE_OWNER" ? "لوحة تحكم صاحب الكافيه"
    : user.role === "BRANCH_MANAGER" ? "لوحة تحكم مدير الفرع"
    : t.dashboard.title;

  const subtitle = (
    <>
      {t.dashboard.welcome} {user.name}
      {user.role === "BRANCH_MANAGER" && branchName && <span> · فرعك: {branchName}</span>}
    </>
  );

  // The highlighted pill: the open picker mode wins; otherwise the applied range.
  const activeKey = draftMode ?? filter.range;

  const controls = (
    <>
      <div className="flex flex-wrap rounded-xl border border-border bg-card p-0.5 text-sm">
        {RANGES.map((r) => (
          <button
            key={r.key}
            onClick={() => pickQuickRange(r.key)}
            className={`rounded-lg px-3 py-1.5 font-medium transition-colors ${
              activeKey === r.key ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {r.label}
          </button>
        ))}
      </div>
      {!user.branchId && (data?.branches.length ?? 0) > 1 && (
        <Select value={branchId} onValueChange={(v) => setBranchId(v ?? "all")}>
          <SelectTrigger className="w-40">
            <SelectValue>
              {branchId === "all" ? t.common.allBranches : data?.branches.find((b) => b.id === branchId)?.name}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t.common.allBranches}</SelectItem>
            {data?.branches.map((b) => <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>)}
          </SelectContent>
        </Select>
      )}
      <button
        onClick={load}
        disabled={refreshing}
        className="rounded-xl border border-border bg-card px-3 py-1.5 text-sm font-medium text-foreground hover:bg-accent disabled:opacity-50"
      >
        {refreshing ? "..." : `↻ ${t.dashboard.refresh}`}
      </button>
    </>
  );

  // Custom day / range pickers + the current-period line.
  const filterBar = (
    <div className="mb-4 space-y-2">
      {draftMode && (
        <div className="flex flex-wrap items-end gap-2 rounded-xl border bg-card p-3">
          {draftMode === "custom_day" ? (
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">اختر اليوم</label>
              <input
                type="date"
                dir="ltr"
                value={draftDate}
                onChange={(e) => setDraftDate(e.target.value)}
                className="h-9 rounded-lg border border-input bg-background px-3 text-sm"
              />
            </div>
          ) : (
            <>
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground">من تاريخ</label>
                <input
                  type="date"
                  dir="ltr"
                  value={draftFrom}
                  onChange={(e) => setDraftFrom(e.target.value)}
                  className="h-9 rounded-lg border border-input bg-background px-3 text-sm"
                />
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground">إلى تاريخ</label>
                <input
                  type="date"
                  dir="ltr"
                  value={draftTo}
                  onChange={(e) => setDraftTo(e.target.value)}
                  className="h-9 rounded-lg border border-input bg-background px-3 text-sm"
                />
              </div>
            </>
          )}
          <button
            onClick={applyCustom}
            className="h-9 rounded-lg bg-foreground px-4 text-sm font-semibold text-background"
          >
            تطبيق
          </button>
          <button
            onClick={resetFilter}
            className="h-9 rounded-lg border border-border bg-card px-4 text-sm font-medium text-muted-foreground hover:text-foreground"
          >
            إعادة ضبط
          </button>
          {filterError && <p className="w-full text-sm text-destructive">{filterError}</p>}
        </div>
      )}
      <p className="text-sm font-medium text-muted-foreground">
        📅 {periodLabel(filter, data?.period)}
      </p>
    </div>
  );

  if (error) return (
    <>
      <PageHeader title={title} subtitle={subtitle}>{controls}</PageHeader>
      {filterBar}
      <p className="text-destructive">{error}</p>
    </>
  );
  if (!data) {
    return (
      <>
        <PageHeader title={title} subtitle={subtitle}>{controls}</PageHeader>
        {filterBar}
        <LoadingState label={t.common.loading} />
      </>
    );
  }

  const isOwner = user.role === "CAFE_OWNER";
  const pm = t.paymentMethods;
  const d = t.dashboard;

  // Period revenue delta vs previous same-length window.
  const delta = data.prev.revenue > 0
    ? Math.round(((data.todayRevenue - data.prev.revenue) / data.prev.revenue) * 100)
    : null;

  return (
    <>
      <PageHeader title={title} subtitle={subtitle}>{controls}</PageHeader>
      {filterBar}

      {/* Refreshing dims (no layout jump) while the new period loads. */}
      <div className={refreshing ? "pointer-events-none opacity-60 transition-opacity" : "transition-opacity"}>

      {/* Primary KPI cards */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label={d.todayRevenue} value={fmt(data.todayRevenue)} icon="💵" accent="emerald"
          hint={delta !== null && (
            <span className={delta >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}>
              {delta >= 0 ? "▲" : "▼"} {Math.abs(delta)}٪ {d.vsPrev}
            </span>
          )}
        />
        <StatCard label={d.todayOrders} value={data.todayOrders} icon="🧾" accent="blue" />
        <StatCard label={d.avgOrderValue} value={fmt(data.averageOrderValue)} icon="📊" accent="violet" />
        <StatCard label={d.openOrders} value={data.openOrders} icon="🔔" accent="amber" href="/orders" />
      </div>

      {/* Secondary KPI cards */}
      <div className="mt-3 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label={d.completedOrders} value={data.completedOrders} icon="✅" accent="emerald" />
        <StatCard label={d.cancelledOrders} value={data.cancelledOrders} icon="🚫" accent={data.cancelledOrders > 0 ? "red" : "slate"} />
        <StatCard label={d.openShiftsLabel} value={data.openShifts} icon="🕒" accent="blue" href="/shifts" />
        <StatCard label={d.closedShiftsToday} value={data.closedShiftsToday} icon="🔒" accent="slate" href="/shifts" />
        <StatCard label={d.netCash} value={fmt(data.netCash)} icon="💰" accent="emerald" />
        <StatCard
          label={d.uncollected} value={fmt(data.uncollectedTotal)} icon="⏳"
          accent={data.uncollectedTotal > 0 ? "amber" : "slate"}
          hint={<span>{data.pendingCount + data.partialCount} {d.pendingCollection}</span>}
          href="/orders"
        />
        <StatCard label={d.taxTotal} value={fmt(data.taxTotal)} icon="🧮" accent="slate" />
        <StatCard label={d.serviceTotal} value={fmt(data.serviceTotal)} icon="🛎️" accent="slate" />
        {data.inventory && (
          <StatCard
            label={d.stockAlerts}
            value={data.inventory.lowStockCount + data.inventory.outOfStockCount}
            icon="📦"
            accent={data.inventory.outOfStockCount > 0 ? "red" : data.inventory.lowStockCount > 0 ? "amber" : "slate"}
            hint={<span>{data.inventory.outOfStockCount} نفدت · {data.inventory.lowStockCount} ناقصة</span>}
            href="/inventory"
          />
        )}
        {data.recipes && (
          <StatCard
            label="بدون وصفة / هامش ضعيف"
            value={`${data.recipes.withoutRecipe} / ${data.recipes.lowMargin}`}
            icon="🍽️"
            accent={data.recipes.lowMargin > 0 ? "red" : "slate"}
            href="/menu"
          />
        )}
        {data.purchases && (
          <>
            <StatCard label="مشتريات الفترة" value={fmt(data.purchases.periodTotal)} icon="🛒" accent="blue" href="/purchases" />
            <StatCard
              label="فواتير مشتريات غير مدفوعة"
              value={data.purchases.unpaidCount}
              icon="⏳"
              accent={data.purchases.unpaidCount > 0 ? "amber" : "slate"}
              href="/purchases"
            />
          </>
        )}
      </div>

      {/* Quick insights */}
      <Panel title={d.insights} className="mt-4" bodyClassName="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3 lg:grid-cols-4">
        <Insight label={d.bestBranch} value={data.bestBranch?.name ?? "—"} sub={data.bestBranch ? fmt(data.bestBranch.value) : undefined} />
        <Insight label={d.bestProduct} value={data.bestProduct?.name ?? "—"} sub={data.bestProduct ? `${data.bestProduct.quantity} ${d.ordersCount}` : undefined} />
        <Insight label={d.worstProduct} value={data.worstProduct?.name ?? "—"} sub={data.worstProduct ? `${data.worstProduct.quantity} ${d.ordersCount}` : undefined} />
        <Insight label={d.bestCashier} value={data.bestCashier?.name ?? "—"} sub={data.bestCashier ? fmt(data.bestCashier.value) : undefined} />
        <Insight label="طلبات منيو QR" value={String(data.qrOrders)} />
        <Insight label="طلبات الكاشير" value={String(data.cashierOrders)} />
        <Insight label={d.taxTotal} value={fmt(data.taxTotal)} />
        <Insight label={d.serviceTotal} value={fmt(data.serviceTotal)} />
      </Panel>

      {/* Latest closed shift */}
      {data.latestClosedShift && (
        <Panel title={t.shifts.latestClosed} className="mt-4" bodyClassName="flex flex-wrap items-center gap-x-8 gap-y-3">
          <Insight label={t.shifts.shiftNumber} value={`#${data.latestClosedShift.shiftNumber}`} />
          <Insight label={t.shifts.cashier} value={data.latestClosedShift.cashier} />
          <Insight label={t.shifts.branch} value={data.latestClosedShift.branch} />
          <Insight label={t.shifts.totalSales} value={fmt(data.latestClosedShift.totalSales)} />
          <Insight
            label={t.shifts.difference}
            value={fmt(data.latestClosedShift.cashDifference)}
            sub={data.latestClosedShift.closedAt ? formatTime(data.latestClosedShift.closedAt) : undefined}
          />
        </Panel>
      )}

      {/* Charts */}
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Panel title="المبيعات حسب الأيام (الطلبات المكتملة)">
          {data.todayRevenue === 0 ? (
            <EmptyState message="لا توجد مبيعات في هذه الفترة" icon="💵" />
          ) : (
            <BarChart
              data={data.revenueByDay.map((x) => ({ label: dayLabel(x.date, data.revenueByDay.length), value: x.revenue }))}
              format={fmt}
            />
          )}
        </Panel>
        <Panel title="الطلبات حسب الأيام">
          {data.completedOrders === 0 ? (
            <EmptyState message="لا توجد طلبات في هذه الفترة" icon="🧾" />
          ) : (
            <BarChart
              data={data.revenueByDay.map((x) => ({ label: dayLabel(x.date, data.revenueByDay.length), value: x.orders }))}
              color="#2563eb"
            />
          )}
        </Panel>
        <Panel title="المبيعات حسب طريقة الدفع">
          <Donut data={data.paymentSplit.map((p) => ({ label: pm[p.method as keyof typeof pm] ?? p.method, value: p.value }))} />
        </Panel>
        <Panel title={d.ordersBySource}>
          <Donut data={data.ordersBySource.map((s) => ({ label: SOURCE_LABEL[s.source] ?? s.source, value: s.count }))} />
        </Panel>
        {isOwner && (
          <Panel title="أداء الفروع">
            <RankBars data={data.branchPerformance.map((b) => ({ label: b.name, value: b.value }))} format={fmt} emptyLabel={d.noSales} />
          </Panel>
        )}
        <Panel title="أفضل الكاشيرين" className={isOwner ? "" : "lg:col-span-2"}>
          <RankBars data={data.topCashiers.map((c) => ({ label: c.name, value: c.value }))} format={fmt} emptyLabel={d.noSales} />
        </Panel>
      </div>

      {/* Tables */}
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Panel title={d.topProducts}>
          <ProductTable rows={data.topProducts} fmt={fmt} />
        </Panel>
        <Panel title="الأقل مبيعًا">
          <ProductTable rows={data.leastProducts} fmt={fmt} />
        </Panel>

        <Panel title={d.recentShifts}>
          {data.recentShifts.length === 0 ? (
            <EmptyState message={t.shifts.noShift} icon="🕒" />
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader><TableRow>
                  <TableHead>{t.shifts.shiftNumber}</TableHead>
                  <TableHead>{t.shifts.cashier}</TableHead>
                  <TableHead>{t.shifts.status}</TableHead>
                  <TableHead className="text-end">{t.shifts.totalSales}</TableHead>
                </TableRow></TableHeader>
                <TableBody>
                  {data.recentShifts.map((s) => (
                    <TableRow key={s.id}>
                      <TableCell className="font-medium tabular-nums">#{s.shiftNumber}</TableCell>
                      <TableCell className="text-muted-foreground">{s.cashier}</TableCell>
                      <TableCell><ShiftBadge status={s.status} /></TableCell>
                      <TableCell className="text-end tabular-nums">{fmt(s.totalSales)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </Panel>

        <Panel title={d.pendingOrders}>
          {data.pendingCollectionOrders.length === 0 ? (
            <EmptyState message="لا يوجد طلبات في انتظار التحصيل" icon="✅" />
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader><TableRow>
                  <TableHead>رقم الطلب</TableHead>
                  <TableHead>الفرع</TableHead>
                  <TableHead className="text-end">الإجمالي</TableHead>
                  <TableHead className="text-end">المتبقي</TableHead>
                </TableRow></TableHeader>
                <TableBody>
                  {data.pendingCollectionOrders.map((o) => (
                    <TableRow key={o.id}>
                      <TableCell className="font-medium tabular-nums">#{o.orderNumber}</TableCell>
                      <TableCell className="text-muted-foreground">{o.branch}</TableCell>
                      <TableCell className="text-end tabular-nums">{fmt(o.total)}</TableCell>
                      <TableCell className="text-end tabular-nums text-amber-600 dark:text-amber-400">{fmt(o.remaining)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </Panel>

        <Panel title="آخر الطلبات داخل الفترة" className="lg:col-span-2">
          {data.recentOrders.length === 0 ? (
            <EmptyState message="لا توجد طلبات في هذه الفترة" icon="🧾" />
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader><TableRow>
                  <TableHead>رقم الطلب</TableHead>
                  <TableHead>الفرع</TableHead>
                  <TableHead>المصدر</TableHead>
                  <TableHead>الحالة</TableHead>
                  <TableHead className="text-end">الإجمالي</TableHead>
                  <TableHead>الوقت</TableHead>
                </TableRow></TableHeader>
                <TableBody>
                  {data.recentOrders.map((o) => (
                    <TableRow key={o.id}>
                      <TableCell className="font-medium tabular-nums">#{o.orderNumber}</TableCell>
                      <TableCell className="text-muted-foreground">{o.branch}</TableCell>
                      <TableCell><SourceBadge source={o.source} /></TableCell>
                      <TableCell><StatusBadge status={o.status} /></TableCell>
                      <TableCell className="text-end tabular-nums">{fmt(o.total)}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">{formatTime(o.createdAt)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </Panel>

      {/* close refreshing-dim wrapper below, after all panels */}
        {data.lowStockItems.length > 0 && (
          <Panel title={d.stockAlerts} className="lg:col-span-2">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader><TableRow>
                  <TableHead>الصنف</TableHead>
                  <TableHead className="text-end">المتاح</TableHead>
                  <TableHead className="text-end">الحد الأدنى</TableHead>
                  <TableHead>الحالة</TableHead>
                </TableRow></TableHeader>
                <TableBody>
                  {data.lowStockItems.map((it) => (
                    <TableRow key={it.name}>
                      <TableCell className="font-medium">{it.name}</TableCell>
                      <TableCell className="text-end tabular-nums">{it.stock} {it.unit}</TableCell>
                      <TableCell className="text-end tabular-nums text-muted-foreground">{it.min} {it.unit}</TableCell>
                      <TableCell>
                        <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${
                          it.stock <= 0 ? "bg-red-500/12 text-red-700 dark:text-red-400" : "bg-amber-500/12 text-amber-700 dark:text-amber-400"
                        }`}>
                          {it.stock <= 0 ? "نفد" : "ناقص"}
                        </span>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </Panel>
        )}
      </div>
      </div>{/* end refreshing-dim wrapper */}
    </>
  );
}

// Weekday label for short ranges; "د/ش" date label once bars get dense.
function dayLabel(dateStr: string, totalDays: number): string {
  if (totalDays <= 7) return formatWeekday(`${dateStr}T12:00:00`);
  const [, m, d] = dateStr.split("-");
  return `${Number(d)}/${Number(m)}`;
}

function Insight({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="min-w-0">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-0.5 truncate text-sm font-semibold text-foreground">{value}</p>
      {sub && <p className="text-xs tabular-nums text-muted-foreground">{sub}</p>}
    </div>
  );
}

function ShiftBadge({ status }: { status: string }) {
  const open = status === "OPEN";
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${
      open ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400" : "bg-foreground/8 text-muted-foreground"
    }`}>
      {open ? t.shifts.openBadge : t.shifts.closedBadge}
    </span>
  );
}

function ProductTable({ rows, fmt }: { rows: { name: string; quantity: number; revenue: number }[]; fmt: (v: number) => string }) {
  if (rows.length === 0) return <EmptyState message={t.dashboard.noSales} icon="📦" />;
  return (
    <Table>
      <TableHeader><TableRow>
        <TableHead>{t.dashboard.product}</TableHead>
        <TableHead className="text-end">{t.dashboard.quantity}</TableHead>
        <TableHead className="text-end">{t.dashboard.revenue}</TableHead>
      </TableRow></TableHeader>
      <TableBody>
        {rows.map((p) => (
          <TableRow key={p.name}>
            <TableCell className="font-medium">{p.name}</TableCell>
            <TableCell className="text-end tabular-nums">{p.quantity}</TableCell>
            <TableCell className="text-end tabular-nums">{fmt(p.revenue)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
