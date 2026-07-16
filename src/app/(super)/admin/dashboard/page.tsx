"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api, money } from "@/lib/client";
import { t } from "@/lib/i18n";
import {
  PageHeader, StatCard, Panel, BarChart, RankBars, Donut, LoadingBlock,
} from "@/components/admin/ui";

type Overview = {
  stats: {
    totalCafes: number; activeCafes: number; suspendedCafes: number;
    totalBranches: number; totalUsers: number; totalOrders: number;
    todaySales: number; monthSales: number; openShifts: number;
    todayOrders: number; avgOrderValue: number;
    topCafeToday: string; topCafeMonth: string;
  };
  charts: {
    days: { date: string; sales: number; orders: number }[];
    topCafes: { label: string; value: number }[];
    paymentSplit: { method: string; value: number }[];
    growth: { label: string; value: number }[];
  };
};

const WEEKDAY = (iso: string) =>
  new Date(iso).toLocaleDateString("ar-EG-u-nu-latn", { weekday: "short" });

export default function AdminDashboardPage() {
  const [data, setData] = useState<Overview | null>(null);

  useEffect(() => {
    api<Overview>("/api/admin/overview")
      .then(setData)
      .catch((e) => toast.error(e instanceof Error ? e.message : "فشل التحميل"));
  }, []);

  if (!data) {
    return (
      <>
        <PageHeader title={t.admin.nav.dashboard} subtitle={t.admin.brandSub} />
        <LoadingBlock label={t.admin.loading} />
      </>
    );
  }

  const s = data.stats;
  const pm = t.paymentMethods;

  return (
    <>
      <PageHeader title={t.admin.nav.dashboard} subtitle="نظرة شاملة على كل الكافيهات في المنصة" />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        <StatCard label={t.admin.stats.totalCafes} value={s.totalCafes} icon="☕" accent="indigo" />
        <StatCard label={t.admin.stats.activeCafes} value={s.activeCafes} icon="✅" accent="emerald" />
        <StatCard label={t.admin.stats.suspendedCafes} value={s.suspendedCafes} icon="⛔" accent="rose" />
        <StatCard label={t.admin.stats.totalBranches} value={s.totalBranches} icon="🏬" accent="violet" />
        <StatCard label={t.admin.stats.totalUsers} value={s.totalUsers} icon="👥" accent="slate" />
        <StatCard label={t.admin.stats.totalOrders} value={s.totalOrders} icon="🧾" accent="slate" />
        <StatCard label={t.admin.stats.openShifts} value={s.openShifts} icon="🕒" accent="amber" />
        <StatCard label={t.admin.stats.todayOrders} value={s.todayOrders} icon="📦" accent="indigo" />
        <StatCard label={t.admin.stats.todaySales} value={money(s.todaySales)} icon="💵" accent="emerald" />
        <StatCard label={t.admin.stats.monthSales} value={money(s.monthSales)} icon="📅" accent="emerald" />
        <StatCard label={t.admin.stats.avgOrderValue} value={money(s.avgOrderValue)} icon="📊" accent="violet" />
        <StatCard label={t.admin.stats.topCafeToday} value={s.topCafeToday} hint={t.admin.stats.topCafeMonth + ": " + s.topCafeMonth} icon="🏆" accent="amber" />
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Panel title={t.admin.charts.sales7}>
          <BarChart
            data={data.charts.days.map((d) => ({ label: WEEKDAY(d.date), value: d.sales }))}
            format="money"
          />
        </Panel>
        <Panel title={t.admin.charts.orders7}>
          <BarChart
            data={data.charts.days.map((d) => ({ label: WEEKDAY(d.date), value: d.orders }))}
            color="#0ea5e9"
          />
        </Panel>
        <Panel title={t.admin.charts.topCafes}>
          <RankBars data={data.charts.topCafes} />
        </Panel>
        <Panel title={t.admin.charts.byPayment}>
          <Donut
            data={data.charts.paymentSplit.map((p) => ({
              label: pm[p.method as keyof typeof pm] ?? p.method,
              value: p.value,
            }))}
          />
        </Panel>
        <Panel title={t.admin.charts.cafeGrowth} className="lg:col-span-2">
          <BarChart data={data.charts.growth} color="#8b5cf6" />
        </Panel>
      </div>
    </>
  );
}
