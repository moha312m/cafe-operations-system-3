"use client";

import type { ReactNode } from "react";
import { EmptyState, Panel, RankBars, StatCard } from "@/components/cafe/ui";

export type OwnerDashboardData = {
  financials: { netSales: number; collections: number };
  todayOrders: number;
  averageOrderValue: number;
  uncollectedTotal: number;
  pendingCount: number;
  partialCount: number;
  inventory?: { lowStockCount: number; outOfStockCount: number };
  purchases?: { unpaidCount: number } | null;
  latestClosedShift: { cashDifference: number; branch: string } | null;
  branches: { id: string; name: string }[];
  branchPerformance: { name: string; value: number }[];
  topProducts: { name: string; quantity: number; revenue: number }[];
};

export function OwnerDashboard({ isOwner, data, formatMoney, children }: {
  isOwner: boolean;
  data: OwnerDashboardData;
  formatMoney: (value: number) => string;
  children?: ReactNode;
}) {
  if (!isOwner) return <>{children}</>;

  const alerts: { title: string; detail: string; href: string; urgent?: boolean }[] = [];
  if (data.uncollectedTotal > 0) {
    alerts.push({ title: "مبيعات لم تُحصّل", detail: `${formatMoney(data.uncollectedTotal)} · ${data.pendingCount + data.partialCount} طلب خلال الفترة`, href: "/orders" });
  }
  const stock = data.inventory;
  if (stock && stock.lowStockCount + stock.outOfStockCount > 0) {
    alerts.push({ title: "مخزون يحتاج متابعة", detail: `${stock.outOfStockCount} أصناف نفدت · ${stock.lowStockCount} أصناف قاربت على النفاد الآن`, href: "/inventory", urgent: stock.outOfStockCount > 0 });
  }
  const closed = data.latestClosedShift;
  if (closed && closed.cashDifference !== 0) {
    alerts.push({ title: closed.cashDifference < 0 ? "عجز كاش في آخر شيفت مقفول" : "زيادة كاش في آخر شيفت مقفول", detail: `${formatMoney(Math.abs(closed.cashDifference))} · ${closed.branch}`, href: "/shifts", urgent: closed.cashDifference < 0 });
  }
  if (data.purchases && data.purchases.unpaidCount > 0) {
    alerts.push({ title: "فواتير مشتريات غير مدفوعة", detail: `${data.purchases.unpaidCount} فواتير تحتاج متابعة الآن`, href: "/purchases" });
  }

  return (
    <>
      <section aria-label="ملخص أداء الكافيه" className="space-y-4">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatCard label="صافي المبيعات" value={formatMoney(data.financials.netSales)} icon="💰" accent="emerald" hint="بعد خصم المرتجعات خلال الفترة" />
          <StatCard label="المبالغ المحصّلة" value={formatMoney(data.financials.collections)} icon="💵" accent="blue" hint="المدفوعات المسجّلة خلال الفترة" />
          <StatCard label="الطلبات المكتملة" value={data.todayOrders} icon="🧾" accent="violet" hint="خلال الفترة المحددة" />
          <StatCard label="متوسط قيمة الطلب" value={formatMoney(data.averageOrderValue)} icon="📊" accent="slate" hint="قبل خصم المرتجعات" />
        </div>

        <Panel title="يحتاج انتباهك">
          {alerts.length ? (
            <ul className="divide-y divide-border/70">
              {alerts.map(alert => (
                <li key={alert.href}>
                  <a href={alert.href} className="flex items-center justify-between gap-3 rounded-lg px-2 py-3 transition-colors hover:bg-accent">
                    <div className="min-w-0">
                      <p className={`text-sm font-semibold ${alert.urgent ? "text-red-600 dark:text-red-400" : "text-foreground"}`}>{alert.title}</p>
                      <p className="mt-1 text-xs text-muted-foreground">{alert.detail}</p>
                    </div>
                    <span className="shrink-0 text-xs font-medium text-muted-foreground">متابعة ←</span>
                  </a>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">لا توجد تنبيهات في هذا الملخص.</p>
          )}
        </Panel>

        <div className={`grid gap-4 ${data.branches.length > 1 ? "lg:grid-cols-2" : ""}`}>
          {data.branches.length > 1 && (
            <Panel title="أداء الفروع">
              <p className="mb-4 text-xs text-muted-foreground">إجمالي مبيعات الطلبات المكتملة خلال الفترة</p>
              <RankBars data={data.branchPerformance.map(branch => ({ label: branch.name, value: branch.value }))} format={formatMoney} emptyLabel="لا توجد مبيعات في هذه الفترة" />
            </Panel>
          )}
          <Panel title="الأصناف الأكثر بيعًا خلال الفترة">
            {data.topProducts.length ? (
              <ul className="divide-y divide-border/70">
                {data.topProducts.slice(0, 5).map(product => (
                  <li key={product.name} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                    <span className="min-w-0 truncate font-medium">{product.name}</span>
                    <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{product.quantity} وحدة · {formatMoney(product.revenue)}</span>
                  </li>
                ))}
              </ul>
            ) : <EmptyState message="لا توجد مبيعات في هذه الفترة" icon="📦" />}
          </Panel>
        </div>
      </section>

      <details className="group mt-5" id="owner-dashboard-details">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-xl border border-border bg-card px-4 py-3 text-sm font-medium transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
          <span className="group-open:hidden">عرض التفاصيل</span>
          <span className="hidden group-open:inline">إخفاء التفاصيل</span>
          <span aria-hidden="true" className="text-muted-foreground transition-transform group-open:rotate-180">⌄</span>
        </summary>
        <div className="mt-4">{children}</div>
      </details>
    </>
  );
}
