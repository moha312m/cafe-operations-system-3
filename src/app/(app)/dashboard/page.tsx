"use client";

import { useCallback, useEffect, useState } from "react";
import { api, money } from "@/lib/client";
import { t, formatWeekday } from "@/lib/i18n";
import Link from "next/link";
import { cn } from "@/lib/utils";
import { useApp } from "@/components/app-shell";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

type DashboardData = {
  todayRevenue: number;
  todayOrders: number;
  averageOrderValue: number;
  openOrders: number;
  revenueByDay: { date: string; revenue: number; orders: number }[];
  topProducts: { name: string; quantity: number; revenue: number }[];
  branches: { id: string; name: string }[];
  inventory?: { lowStockCount: number; outOfStockCount: number };
  recipes?: {
    withoutRecipe: number;
    lowMargin: number;
    topProduct: { name: string; profit: number; margin: number } | null;
  } | null;
};

const BAR_COLOR = "#2a78d6";

export default function DashboardPage() {
  const { cafe, user, branchName } = useApp();
  const currency = cafe?.currency ?? "USD";
  const [data, setData] = useState<DashboardData | null>(null);
  const [branchId, setBranchId] = useState<string>("all");
  const [error, setError] = useState<string | null>(null);
  const [hovered, setHovered] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const query = branchId !== "all" ? `?branchId=${branchId}` : "";
      setData(await api<DashboardData>(`/api/dashboard${query}`));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    }
  }, [branchId]);

  useEffect(() => {
    load();
  }, [load]);

  if (error) return <p className="text-destructive">{error}</p>;
  if (!data) return <p className="text-muted-foreground">{t.common.loading}</p>;

  const maxRevenue = Math.max(...data.revenueByDay.map((d) => d.revenue), 1);

  const stats = [
    { label: t.dashboard.todayRevenue, value: money(data.todayRevenue, currency) },
    { label: t.dashboard.todayOrders, value: String(data.todayOrders) },
    { label: t.dashboard.avgOrderValue, value: money(data.averageOrderValue, currency) },
    { label: t.dashboard.openOrders, value: String(data.openOrders) },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">
            {user.role === "CAFE_OWNER"
              ? "لوحة تحكم صاحب الكافيه"
              : user.role === "BRANCH_MANAGER"
                ? "لوحة تحكم مدير الفرع"
                : t.dashboard.title}
          </h1>
          <p className="text-sm text-muted-foreground">
            {t.dashboard.welcome} {user.name}
            {user.role === "BRANCH_MANAGER" && branchName && (
              <span> · فرعي الحالي: {branchName}</span>
            )}
          </p>
        </div>
        {!user.branchId && data.branches.length > 1 && (
          <Select value={branchId} onValueChange={(v) => setBranchId(v ?? "all")}>
            <SelectTrigger className="w-44">
              <SelectValue>
                {branchId === "all"
                  ? t.common.allBranches
                  : data.branches.find((b) => b.id === branchId)?.name}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t.common.allBranches}</SelectItem>
              {data.branches.map((b) => (
                <SelectItem key={b.id} value={b.id}>
                  {b.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {stats.map((stat) => (
          <Card key={stat.label}>
            <CardHeader className="pb-1">
              <CardTitle className="text-sm font-normal text-muted-foreground">
                {stat.label}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-2xl font-semibold tabular-nums">{stat.value}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Inventory alerts */}
      {data.inventory && (data.inventory.lowStockCount > 0 || data.inventory.outOfStockCount > 0) && (
        <a
          href="/inventory"
          className="flex flex-wrap items-center gap-3 rounded-lg border border-amber-400/50 bg-amber-500/5 px-4 py-3 text-sm transition-colors hover:bg-amber-500/10"
        >
          <span className="font-medium">📦 تنبيهات المخزون:</span>
          {data.inventory.outOfStockCount > 0 && (
            <span className="font-semibold text-destructive">
              {data.inventory.outOfStockCount} خامات نفدت
            </span>
          )}
          {data.inventory.lowStockCount > 0 && (
            <span className="font-semibold text-amber-700 dark:text-amber-400">
              {data.inventory.lowStockCount} خامات ناقصة
            </span>
          )}
          <span className="ms-auto text-xs text-muted-foreground">افتح المخزون ←</span>
        </a>
      )}

      {/* Recipe / profit summary cards */}
      {data.recipes && (
        <div className="grid gap-4 sm:grid-cols-3">
          <Link href="/menu" className="rounded-lg border p-4 transition-colors hover:bg-accent/50">
            <p className="text-sm text-muted-foreground">منتجات بدون وصفة</p>
            <p className={cn("text-2xl font-semibold tabular-nums", data.recipes.withoutRecipe > 0 && "text-amber-600")}>
              {data.recipes.withoutRecipe}
            </p>
          </Link>
          <Link href="/menu" className="rounded-lg border p-4 transition-colors hover:bg-accent/50">
            <p className="text-sm text-muted-foreground">منتجات هامشها ضعيف</p>
            <p className={cn("text-2xl font-semibold tabular-nums", data.recipes.lowMargin > 0 && "text-destructive")}>
              {data.recipes.lowMargin}
            </p>
          </Link>
          <div className="rounded-lg border p-4">
            <p className="text-sm text-muted-foreground">أعلى منتج ربحًا</p>
            {data.recipes.topProduct ? (
              <p className="text-base font-semibold">
                {data.recipes.topProduct.name}{" "}
                <span className="text-sm text-emerald-600 tabular-nums">
                  ({data.recipes.topProduct.margin}٪)
                </span>
              </p>
            ) : (
              <p className="text-base text-muted-foreground">—</p>
            )}
          </div>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {t.dashboard.weekRevenue}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex h-48 items-end gap-2">
              {data.revenueByDay.map((day, i) => {
                const heightPct = (day.revenue / maxRevenue) * 100;
                const weekday = formatWeekday(`${day.date}T12:00:00`);
                return (
                  <div
                    key={day.date}
                    className="relative flex flex-1 flex-col items-center justify-end gap-1 self-stretch"
                    onMouseEnter={() => setHovered(i)}
                    onMouseLeave={() => setHovered(null)}
                  >
                    {hovered === i && (
                      <div className="absolute -top-2 z-10 -translate-y-full whitespace-nowrap rounded-md border bg-popover px-2 py-1 text-xs shadow-sm">
                        <span className="font-medium">{money(day.revenue, currency)}</span>
                        <span className="text-muted-foreground"> · {day.orders} {t.dashboard.ordersCount}</span>
                      </div>
                    )}
                    <div
                      role="img"
                      aria-label={`${day.date}: ${money(day.revenue, currency)} من ${day.orders} طلب`}
                      className="w-full max-w-10 rounded-t-[4px] transition-opacity"
                      style={{
                        height: `${Math.max(heightPct, day.revenue > 0 ? 2 : 0)}%`,
                        backgroundColor: BAR_COLOR,
                        opacity: hovered === null || hovered === i ? 1 : 0.45,
                      }}
                    />
                    <span className="text-xs text-muted-foreground">{weekday}</span>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t.dashboard.topProducts}</CardTitle>
          </CardHeader>
          <CardContent>
            {data.topProducts.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t.dashboard.noSales}</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t.dashboard.product}</TableHead>
                    <TableHead className="text-end">{t.dashboard.quantity}</TableHead>
                    <TableHead className="text-end">{t.dashboard.revenue}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.topProducts.map((p) => (
                    <TableRow key={p.name}>
                      <TableCell className="font-medium">{p.name}</TableCell>
                      <TableCell className="text-end tabular-nums">
                        {p.quantity}
                      </TableCell>
                      <TableCell className="text-end tabular-nums">
                        {money(p.revenue, currency)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
