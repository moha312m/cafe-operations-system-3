"use client";

import { useCallback, useEffect, useState } from "react";
import { api, money } from "@/lib/client";
import { t, formatWeekday, formatTime } from "@/lib/i18n";
import { useApp } from "@/components/app-shell";
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

type Range = "today" | "7d" | "30d" | "month";

type DashboardData = {
  range: string;
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
  purchases?: { todayTotal: number; monthTotal: number; unpaidCount: number } | null;
};

const RANGES: { key: Range; label: string }[] = [
  { key: "today", label: t.dashboard.range.today },
  { key: "7d", label: t.dashboard.range.d7 },
  { key: "30d", label: t.dashboard.range.d30 },
  { key: "month", label: t.dashboard.range.month },
];

const SOURCE_LABEL: Record<string, string> = {
  QR_MENU: "منيو QR", WAITER: "ويتر", CASHIER_POS: "الكاشير",
};

export default function DashboardPage() {
  const { cafe, user, branchName } = useApp();
  const currency = cafe?.currency ?? "EGP";
  const fmt = (v: number) => money(v, currency);
  const [data, setData] = useState<DashboardData | null>(null);
  const [branchId, setBranchId] = useState<string>("all");
  const [range, setRange] = useState<Range>("today");
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      setRefreshing(true);
      const qs = new URLSearchParams();
      if (branchId !== "all") qs.set("branchId", branchId);
      qs.set("range", range);
      setData(await api<DashboardData>(`/api/dashboard?${qs.toString()}`));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "فشل تحميل اللوحة");
    } finally {
      setRefreshing(false);
    }
  }, [branchId, range]);

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

  const controls = (
    <>
      <div className="flex rounded-xl border border-border bg-card p-0.5 text-sm">
        {RANGES.map((r) => (
          <button
            key={r.key}
            onClick={() => setRange(r.key)}
            className={`rounded-lg px-3 py-1.5 font-medium transition-colors ${
              range === r.key ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground"
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

  if (error) return (
    <>
      <PageHeader title={title} subtitle={subtitle}>{controls}</PageHeader>
      <p className="text-destructive">{error}</p>
    </>
  );
  if (!data) {
    return (
      <>
        <PageHeader title={title} subtitle={subtitle}>{controls}</PageHeader>
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
            <StatCard label="مشتريات النهارده" value={fmt(data.purchases.todayTotal)} icon="🛒" accent="blue" href="/purchases" />
            <StatCard label="مشتريات الشهر" value={fmt(data.purchases.monthTotal)} icon="📅" accent="slate" href="/purchases" />
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
        <Panel title={d.weekRevenue}>
          <BarChart
            data={data.revenueByDay.map((x) => ({ label: formatWeekday(`${x.date}T12:00:00`), value: x.revenue }))}
            format={fmt}
          />
        </Panel>
        <Panel title="الطلبات — آخر ٧ أيام">
          <BarChart
            data={data.revenueByDay.map((x) => ({ label: formatWeekday(`${x.date}T12:00:00`), value: x.orders }))}
            color="#2563eb"
          />
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

        <Panel title="آخر الطلبات" className="lg:col-span-2">
          {data.recentOrders.length === 0 ? (
            <EmptyState message={d.noSales} icon="🧾" />
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
    </>
  );
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
