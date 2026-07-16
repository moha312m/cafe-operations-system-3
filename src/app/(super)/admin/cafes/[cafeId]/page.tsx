"use client";

import { use, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { api, money } from "@/lib/client";
import { t, formatDate, formatDateTime } from "@/lib/i18n";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  PageHeader, StatCard, Panel, StatusPill, SubscriptionBadge, RankBars, Donut,
  EmptyState, LoadingBlock,
} from "@/components/admin/ui";
import { PasswordResetDialog } from "@/components/admin/password-reset-dialog";
import { SuspendDialog } from "@/components/admin/suspend-dialog";

type Detail = {
  cafe: {
    id: string; name: string; slug: string; currency: string; taxRate: number;
    isActive: boolean; suspendedAt: string | null; suspendedReason: string | null;
    planName: string; subscriptionStatus: string;
    subscriptionStartedAt: string | null; subscriptionEndsAt: string | null; createdAt: string;
  };
  overview: {
    branches: number; staff: number; orders: number; todaySales: number;
    monthSales: number; avgOrderValue: number; lastOrderAt: string | null;
  };
  branches: { id: string; name: string; isActive: boolean; orders: number; todaySales: number; monthSales: number; staff: number; openShifts: number }[];
  users: { id: string; name: string; email: string; phone: string | null; role: string; isActive: boolean; archivedAt: string | null; lastLoginAt: string | null; branch: { name: string } | null }[];
  reports: {
    trend7: { date: string; sales: number }[];
    byBranch: { label: string; value: number }[];
    byPayment: { method: string; value: number }[];
    topProducts: { name: string; quantity: number; revenue: number }[];
  };
  orders: { id: string; orderNumber: number; source: string; status: string; total: string; createdAt: string; branch: { name: string } }[];
  shifts: { id: string; shiftNumber: number; status: string; openedAt: string; closedAt: string | null; totalSales: string; cashDifference: string | null; cashier: { name: string }; branch: { name: string } }[];
  audit: { id: string; action: string; entity: string; createdAt: string; user: { name: string } | null }[];
};

export default function CafeDetailPage({ params }: { params: Promise<{ cafeId: string }> }) {
  const { cafeId } = use(params);
  const [data, setData] = useState<Detail | null>(null);
  const [pwTarget, setPwTarget] = useState<{ id: string; name: string } | null>(null);
  const [suspendOpen, setSuspendOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await api<Detail>(`/api/admin/cafes/${cafeId}`));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "فشل تحميل بيانات الكافيه");
    }
  }, [cafeId]);

  useEffect(() => { load(); }, [load]);

  async function activate() {
    try {
      await api(`/api/admin/cafes/${cafeId}`, { method: "PATCH", body: { isActive: true } });
      toast.success("تم تفعيل الكافيه");
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "فشل التفعيل");
    }
  }

  if (!data) {
    return (
      <>
        <PageHeader title={t.admin.nav.cafes} />
        <LoadingBlock label={t.admin.loading} />
      </>
    );
  }

  const { cafe, overview: o, reports } = data;
  const pm = t.paymentMethods;

  return (
    <>
      <div className="mb-4">
        <Link href="/admin/cafes" className="text-xs text-slate-500 hover:text-indigo-600">
          ← {t.admin.actions.backToCafes}
        </Link>
      </div>

      <PageHeader title={cafe.name} subtitle={cafe.slug}>
        <PasswordResetTrigger />
        {cafe.isActive ? (
          <Button variant="destructive" size="sm" onClick={() => setSuspendOpen(true)}>
            {t.admin.actions.suspend}
          </Button>
        ) : (
          <Button size="sm" className="bg-emerald-600 hover:bg-emerald-700" onClick={activate}>
            {t.admin.actions.activate}
          </Button>
        )}
      </PageHeader>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <StatusPill active={cafe.isActive} labels={{ on: t.admin.cafeStatus.active, off: t.admin.cafeStatus.suspended }} />
        <SubscriptionBadge status={cafe.subscriptionStatus} label={`${cafe.planName} — ${t.admin.subStatus[cafe.subscriptionStatus as keyof typeof t.admin.subStatus] ?? cafe.subscriptionStatus}`} />
        {cafe.subscriptionEndsAt && (
          <span className="text-xs text-slate-500">ينتهي: {formatDate(cafe.subscriptionEndsAt)}</span>
        )}
        {!cafe.isActive && cafe.suspendedReason && (
          <span className="text-xs text-rose-600">سبب الإيقاف: {cafe.suspendedReason}</span>
        )}
      </div>

      <Tabs defaultValue="overview" className="w-full">
        <TabsList variant="line" className="mb-4 max-w-full flex-nowrap justify-start overflow-x-auto">
          <TabsTrigger value="overview">نظرة عامة</TabsTrigger>
          <TabsTrigger value="branches">الفروع</TabsTrigger>
          <TabsTrigger value="users">المستخدمين</TabsTrigger>
          <TabsTrigger value="reports">التقارير</TabsTrigger>
          <TabsTrigger value="orders">الطلبات</TabsTrigger>
          <TabsTrigger value="shifts">الشيفتات</TabsTrigger>
          <TabsTrigger value="audit">سجل الحركات</TabsTrigger>
        </TabsList>

        {/* A) Overview */}
        <TabsContent value="overview">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            <StatCard label="عدد الفروع" value={o.branches} icon="🏬" accent="violet" />
            <StatCard label="عدد الموظفين" value={o.staff} icon="👥" accent="slate" />
            <StatCard label="طلبات الشهر" value={o.orders} icon="🧾" accent="indigo" />
            <StatCard label="مبيعات اليوم" value={money(o.todaySales)} icon="💵" accent="emerald" />
            <StatCard label="مبيعات الشهر" value={money(o.monthSales)} icon="📅" accent="emerald" />
            <StatCard label={t.admin.stats.avgOrderValue} value={money(o.avgOrderValue)} icon="📊" accent="violet" />
            <StatCard label="آخر نشاط" value={o.lastOrderAt ? formatDateTime(o.lastOrderAt) : "—"} icon="🕒" accent="amber" />
          </div>
        </TabsContent>

        {/* B) Branches */}
        <TabsContent value="branches">
          <Panel>
            {data.branches.length === 0 ? <EmptyState message={t.admin.empty} icon="🏬" /> : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader><TableRow>
                    <TableHead>الفرع</TableHead>
                    <TableHead className="text-end">الطلبات</TableHead>
                    <TableHead className="text-end">مبيعات اليوم</TableHead>
                    <TableHead className="text-end">مبيعات الشهر</TableHead>
                    <TableHead className="text-end">الموظفين</TableHead>
                    <TableHead className="text-end">شيفتات مفتوحة</TableHead>
                  </TableRow></TableHeader>
                  <TableBody>
                    {data.branches.map((b) => (
                      <TableRow key={b.id}>
                        <TableCell className="font-medium">{b.name}</TableCell>
                        <TableCell className="text-end tabular-nums">{b.orders}</TableCell>
                        <TableCell className="text-end tabular-nums">{money(b.todaySales)}</TableCell>
                        <TableCell className="text-end tabular-nums">{money(b.monthSales)}</TableCell>
                        <TableCell className="text-end tabular-nums">{b.staff}</TableCell>
                        <TableCell className="text-end tabular-nums">{b.openShifts}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </Panel>
        </TabsContent>

        {/* C) Users */}
        <TabsContent value="users">
          <Panel>
            {data.users.length === 0 ? <EmptyState message={t.admin.empty} icon="👥" /> : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader><TableRow>
                    <TableHead>الاسم</TableHead>
                    <TableHead>الإيميل</TableHead>
                    <TableHead>الدور</TableHead>
                    <TableHead>الفرع</TableHead>
                    <TableHead>الحالة</TableHead>
                    <TableHead>آخر دخول</TableHead>
                    <TableHead className="text-end">إجراءات</TableHead>
                  </TableRow></TableHeader>
                  <TableBody>
                    {data.users.map((u) => (
                      <TableRow key={u.id}>
                        <TableCell className="font-medium">{u.name}</TableCell>
                        <TableCell dir="ltr" className="text-start text-xs text-slate-500">{u.email}</TableCell>
                        <TableCell>{t.roles[u.role as keyof typeof t.roles] ?? u.role}</TableCell>
                        <TableCell className="text-slate-500">{u.branch?.name ?? "—"}</TableCell>
                        <TableCell>
                          <StatusPill active={u.isActive && !u.archivedAt} labels={{ on: t.common.active, off: u.archivedAt ? "مؤرشف" : t.common.disabled }} />
                        </TableCell>
                        <TableCell className="text-xs text-slate-500">{u.lastLoginAt ? formatDateTime(u.lastLoginAt) : "—"}</TableCell>
                        <TableCell className="text-end">
                          <Button size="sm" variant="ghost" onClick={() => setPwTarget({ id: u.id, name: u.name })}>
                            {t.admin.actions.resetPassword}
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </Panel>
        </TabsContent>

        {/* D) Reports */}
        <TabsContent value="reports">
          <div className="grid gap-4 lg:grid-cols-2">
            <Panel title="مبيعات آخر ٧ أيام">
              <RankBars data={reports.trend7.map((d) => ({ label: new Date(d.date).toLocaleDateString("ar-EG-u-nu-latn", { weekday: "short" }), value: d.sales }))} />
            </Panel>
            <Panel title="المبيعات حسب الفرع (٣٠ يوم)">
              <RankBars data={reports.byBranch} />
            </Panel>
            <Panel title={t.admin.charts.byPayment}>
              <Donut data={reports.byPayment.map((p) => ({ label: pm[p.method as keyof typeof pm] ?? p.method, value: p.value }))} />
            </Panel>
            <Panel title="أفضل المنتجات (٣٠ يوم)">
              {reports.topProducts.length === 0 ? <EmptyState message={t.admin.empty} icon="🍽️" /> : (
                <Table>
                  <TableHeader><TableRow>
                    <TableHead>المنتج</TableHead>
                    <TableHead className="text-end">الكمية</TableHead>
                    <TableHead className="text-end">المبيعات</TableHead>
                  </TableRow></TableHeader>
                  <TableBody>
                    {reports.topProducts.map((p) => (
                      <TableRow key={p.name}>
                        <TableCell className="font-medium">{p.name}</TableCell>
                        <TableCell className="text-end tabular-nums">{p.quantity}</TableCell>
                        <TableCell className="text-end tabular-nums">{money(p.revenue)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </Panel>
          </div>
        </TabsContent>

        {/* E) Orders */}
        <TabsContent value="orders">
          <Panel>
            {data.orders.length === 0 ? <EmptyState message={t.admin.empty} icon="🧾" /> : (
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
                    {data.orders.map((ord) => (
                      <TableRow key={ord.id}>
                        <TableCell className="font-medium tabular-nums">#{ord.orderNumber}</TableCell>
                        <TableCell>{ord.branch.name}</TableCell>
                        <TableCell>{t.orderSource[ord.source as keyof typeof t.orderSource] ?? ord.source}</TableCell>
                        <TableCell>{t.orderStatus[ord.status as keyof typeof t.orderStatus] ?? ord.status}</TableCell>
                        <TableCell className="text-end tabular-nums">{money(ord.total)}</TableCell>
                        <TableCell className="text-xs text-slate-500">{formatDateTime(ord.createdAt)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </Panel>
        </TabsContent>

        {/* F) Shifts */}
        <TabsContent value="shifts">
          <Panel>
            {data.shifts.length === 0 ? <EmptyState message={t.admin.empty} icon="🧮" /> : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader><TableRow>
                    <TableHead>رقم الشيفت</TableHead>
                    <TableHead>الكاشير</TableHead>
                    <TableHead>الفرع</TableHead>
                    <TableHead>البداية</TableHead>
                    <TableHead>النهاية</TableHead>
                    <TableHead className="text-end">المبيعات</TableHead>
                    <TableHead className="text-end">فرق الكاش</TableHead>
                  </TableRow></TableHeader>
                  <TableBody>
                    {data.shifts.map((sh) => (
                      <TableRow key={sh.id}>
                        <TableCell className="font-medium tabular-nums">#{sh.shiftNumber}</TableCell>
                        <TableCell>{sh.cashier.name}</TableCell>
                        <TableCell>{sh.branch.name}</TableCell>
                        <TableCell className="text-xs text-slate-500">{formatDateTime(sh.openedAt)}</TableCell>
                        <TableCell className="text-xs text-slate-500">{sh.closedAt ? formatDateTime(sh.closedAt) : t.shiftStatus.OPEN}</TableCell>
                        <TableCell className="text-end tabular-nums">{money(sh.totalSales)}</TableCell>
                        <TableCell className="text-end tabular-nums">{sh.cashDifference != null ? money(sh.cashDifference) : "—"}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </Panel>
        </TabsContent>

        {/* G) Audit */}
        <TabsContent value="audit">
          <Panel>
            {data.audit.length === 0 ? <EmptyState message={t.admin.empty} icon="🕓" /> : (
              <ul className="divide-y divide-slate-100">
                {data.audit.map((a) => (
                  <li key={a.id} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                    <div className="min-w-0">
                      <span className="font-medium text-slate-800">{a.action}</span>
                      <span className="text-slate-400"> · {a.entity}</span>
                    </div>
                    <div className="flex shrink-0 items-center gap-3 text-xs text-slate-500">
                      <span>{a.user?.name ?? "—"}</span>
                      <span>{formatDateTime(a.createdAt)}</span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </TabsContent>
      </Tabs>

      <PasswordResetDialog
        open={!!pwTarget}
        onOpenChange={(v) => !v && setPwTarget(null)}
        endpoint={pwTarget ? `/api/admin/users/${pwTarget.id}` : null}
        subjectName={pwTarget?.name ?? ""}
      />
      <SuspendDialog
        cafe={suspendOpen ? { id: cafe.id, name: cafe.name } : null}
        onOpenChange={setSuspendOpen}
        onDone={load}
      />
    </>
  );

  // Small inline helper so the header button can open the owner reset.
  function PasswordResetTrigger() {
    const owner = data?.users.find((u) => u.role === "CAFE_OWNER");
    if (!owner) return null;
    return (
      <Button variant="outline" size="sm" onClick={() => setPwTarget({ id: owner.id, name: `${t.roles.CAFE_OWNER}: ${owner.name}` })}>
        {t.admin.actions.resetPassword}
      </Button>
    );
  }
}
