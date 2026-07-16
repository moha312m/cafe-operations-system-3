"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
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

type DashboardData = {
  todayRevenue: number;
  todayOrders: number;
  averageOrderValue: number;
  openOrders: number;
  openShifts: number;
  netCash: number;
  revenueByDay: { date: string; revenue: number; orders: number }[];
  paymentSplit: { method: string; value: number }[];
  branchPerformance: { name: string; value: number }[];
  topCashiers: { name: string; value: number }[];
  recentOrders: {
    id: string; orderNumber: number; status: OrderStatus; source: OrderSource;
    total: number; table: string | null; customer: string | null; branch: string; createdAt: string;
  }[];
  topProducts: { name: string; quantity: number; revenue: number }[];
  leastProducts: { name: string; quantity: number; revenue: number }[];
  branches: { id: string; name: string }[];
  inventory?: { lowStockCount: number; outOfStockCount: number };
  recipes?: {
    withoutRecipe: number;
    lowMargin: number;
    topProduct: { name: string; profit: number; margin: number } | null;
  } | null;
};

export default function DashboardPage() {
  const { cafe, user, branchName } = useApp();
  const currency = cafe?.currency ?? "EGP";
  const fmt = (v: number) => money(v, currency);
  const [data, setData] = useState<DashboardData | null>(null);
  const [branchId, setBranchId] = useState<string>("all");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const query = branchId !== "all" ? `?branchId=${branchId}` : "";
      setData(await api<DashboardData>(`/api/dashboard${query}`));
    } catch (e) {
      setError(e instanceof Error ? e.message : "فشل تحميل اللوحة");
    }
  }, [branchId]);

  useEffect(() => { load(); }, [load]);

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

  const branchSelector = !user.branchId && (data?.branches.length ?? 0) > 1 && (
    <Select value={branchId} onValueChange={(v) => setBranchId(v ?? "all")}>
      <SelectTrigger className="w-44">
        <SelectValue>
          {branchId === "all" ? t.common.allBranches : data?.branches.find((b) => b.id === branchId)?.name}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="all">{t.common.allBranches}</SelectItem>
        {data?.branches.map((b) => <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>)}
      </SelectContent>
    </Select>
  );

  if (error) return <p className="text-destructive">{error}</p>;
  if (!data) {
    return (
      <>
        <PageHeader title={title} subtitle={subtitle} />
        <LoadingState label={t.common.loading} />
      </>
    );
  }

  const isOwner = user.role === "CAFE_OWNER";
  const pm = t.paymentMethods;

  return (
    <>
      <PageHeader title={title} subtitle={subtitle}>{branchSelector}</PageHeader>

      {/* KPI cards */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label={t.dashboard.todayRevenue} value={fmt(data.todayRevenue)} icon="💵" accent="emerald" />
        <StatCard label={t.dashboard.todayOrders} value={data.todayOrders} icon="🧾" accent="blue" />
        <StatCard label={t.dashboard.avgOrderValue} value={fmt(data.averageOrderValue)} icon="📊" accent="violet" />
        <StatCard label={t.dashboard.openOrders} value={data.openOrders} icon="🔔" accent="amber" href="/orders" />
        <StatCard label="صافي الكاش النهارده" value={fmt(data.netCash)} icon="💰" accent="emerald" />
        <StatCard label="الشيفتات المفتوحة" value={data.openShifts} icon="🕒" accent="blue" />
        {data.inventory && (
          <StatCard
            label="تنبيهات المخزون"
            value={data.inventory.lowStockCount + data.inventory.outOfStockCount}
            icon="📦"
            accent={data.inventory.outOfStockCount > 0 ? "red" : data.inventory.lowStockCount > 0 ? "amber" : "slate"}
            hint={<span>{data.inventory.outOfStockCount} نفدت · {data.inventory.lowStockCount} ناقصة</span>}
            href="/inventory"
          />
        )}
        {data.recipes && (
          <StatCard
            label="منتجات بدون وصفة / هامش ضعيف"
            value={`${data.recipes.withoutRecipe} / ${data.recipes.lowMargin}`}
            icon="🍽️"
            accent={data.recipes.lowMargin > 0 ? "red" : "slate"}
            href="/menu"
          />
        )}
      </div>

      {/* Charts */}
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Panel title={t.dashboard.weekRevenue}>
          <BarChart
            data={data.revenueByDay.map((d) => ({ label: formatWeekday(`${d.date}T12:00:00`), value: d.revenue }))}
            format={fmt}
          />
        </Panel>
        <Panel title="الطلبات — آخر ٧ أيام">
          <BarChart
            data={data.revenueByDay.map((d) => ({ label: formatWeekday(`${d.date}T12:00:00`), value: d.orders }))}
            color="#2563eb"
          />
        </Panel>
        <Panel title="المبيعات حسب طريقة الدفع (النهارده)">
          <Donut data={data.paymentSplit.map((p) => ({ label: pm[p.method as keyof typeof pm] ?? p.method, value: p.value }))} />
        </Panel>
        {isOwner ? (
          <Panel title="أداء الفروع (النهارده)">
            <RankBars data={data.branchPerformance.map((b) => ({ label: b.name, value: b.value }))} format={fmt} emptyLabel={t.dashboard.noSales} />
          </Panel>
        ) : (
          <Panel title="أفضل الكاشيرين (النهارده)">
            <RankBars data={data.topCashiers.map((c) => ({ label: c.name, value: c.value }))} format={fmt} emptyLabel={t.dashboard.noSales} />
          </Panel>
        )}
      </div>

      {/* Tables */}
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Panel title={t.dashboard.topProducts}>
          <ProductTable rows={data.topProducts} fmt={fmt} />
        </Panel>
        <Panel title="الأقل مبيعًا — آخر ٧ أيام">
          <ProductTable rows={data.leastProducts} fmt={fmt} />
        </Panel>
        {isOwner && (
          <Panel title="أفضل الكاشيرين (النهارده)">
            <RankBars data={data.topCashiers.map((c) => ({ label: c.name, value: c.value }))} format={fmt} emptyLabel={t.dashboard.noSales} />
          </Panel>
        )}
        <Panel title="آخر الطلبات" className={isOwner ? "" : "lg:col-span-2"}>
          {data.recentOrders.length === 0 ? (
            <EmptyState message={t.dashboard.noSales} icon="🧾" />
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
      </div>
    </>
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
