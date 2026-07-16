"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { api, money } from "@/lib/client";
import { t, formatDate, formatDateTime } from "@/lib/i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  PageHeader, StatCard, Panel, StatusPill, SubscriptionBadge, EmptyState, LoadingBlock,
} from "@/components/admin/ui";
import { PasswordResetDialog } from "@/components/admin/password-reset-dialog";
import { CreateCafeDialog } from "@/components/admin/create-cafe-dialog";
import { SuspendDialog } from "@/components/admin/suspend-dialog";

type Cafe = {
  id: string; name: string; slug: string; currency: string; isActive: boolean;
  planName: string; subscriptionStatus: string; subscriptionEndsAt: string | null;
  createdAt: string; branches: number; users: number; orders: number;
  todaySales: number; monthSales: number; lastOrderAt: string | null;
  owner: { id: string; name: string } | null;
};

type StatusFilter = "ALL" | "ACTIVE" | "SUSPENDED";
type Sort = "recent" | "sales" | "orders";

export default function AdminCafesPage() {
  const [cafes, setCafes] = useState<Cafe[] | null>(null);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<StatusFilter>("ALL");
  const [sort, setSort] = useState<Sort>("recent");
  const [pwTarget, setPwTarget] = useState<{ id: string; name: string } | null>(null);
  const [suspendTarget, setSuspendTarget] = useState<Cafe | null>(null);

  const load = useCallback(async () => {
    try {
      const { cafes } = await api<{ cafes: Cafe[] }>("/api/admin/cafes");
      setCafes(cafes);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "فشل تحميل الكافيهات");
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const summary = useMemo(() => {
    const list = cafes ?? [];
    return {
      total: list.length,
      active: list.filter((c) => c.isActive).length,
      suspended: list.filter((c) => !c.isActive).length,
      branches: list.reduce((s, c) => s + c.branches, 0),
      users: list.reduce((s, c) => s + c.users, 0),
    };
  }, [cafes]);

  const filtered = useMemo(() => {
    let list = [...(cafes ?? [])];
    const term = q.trim().toLowerCase();
    if (term) list = list.filter((c) => c.name.toLowerCase().includes(term) || c.slug.toLowerCase().includes(term));
    if (status === "ACTIVE") list = list.filter((c) => c.isActive);
    if (status === "SUSPENDED") list = list.filter((c) => !c.isActive);
    if (sort === "sales") list.sort((a, b) => b.monthSales - a.monthSales);
    else if (sort === "orders") list.sort((a, b) => b.orders - a.orders);
    else list.sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt));
    return list;
  }, [cafes, q, status, sort]);

  async function activate(cafe: Cafe) {
    try {
      await api(`/api/admin/cafes/${cafe.id}`, { method: "PATCH", body: { isActive: true } });
      toast.success("تم تفعيل الكافيه");
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "فشل التفعيل");
    }
  }

  return (
    <>
      <PageHeader title={t.admin.nav.cafes} subtitle="إدارة ومتابعة كل الكافيهات المشتركة">
        <CreateCafeDialog onCreated={load} />
      </PageHeader>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <StatCard label={t.admin.stats.totalCafes} value={summary.total} icon="☕" accent="indigo" />
        <StatCard label={t.admin.stats.activeCafes} value={summary.active} icon="✅" accent="emerald" />
        <StatCard label={t.admin.stats.suspendedCafes} value={summary.suspended} icon="⛔" accent="rose" />
        <StatCard label={t.admin.stats.totalBranches} value={summary.branches} icon="🏬" accent="violet" />
        <StatCard label={t.admin.stats.totalUsers} value={summary.users} icon="👥" accent="slate" />
      </div>

      <Panel className="mt-4">
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <Input
            placeholder="ابحث باسم الكافيه أو المعرّف…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="max-w-xs"
          />
          <div className="flex gap-1 rounded-lg bg-slate-100 p-1 text-xs">
            {([["ALL", "الكل"], ["ACTIVE", "نشط"], ["SUSPENDED", "موقوف"]] as const).map(([v, l]) => (
              <button
                key={v}
                onClick={() => setStatus(v)}
                className={`rounded-md px-3 py-1.5 font-medium transition-colors ${status === v ? "bg-white text-slate-900 shadow-sm" : "text-slate-500"}`}
              >
                {l}
              </button>
            ))}
          </div>
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as Sort)}
            className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700"
          >
            <option value="recent">الأحدث</option>
            <option value="sales">ترتيب حسب المبيعات</option>
            <option value="orders">ترتيب حسب الطلبات</option>
          </select>
        </div>

        {cafes === null ? (
          <LoadingBlock label={t.admin.loading} />
        ) : filtered.length === 0 ? (
          <EmptyState message={t.admin.empty} icon="☕" />
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>الكافيه</TableHead>
                  <TableHead>الاشتراك</TableHead>
                  <TableHead>الحالة</TableHead>
                  <TableHead className="text-end">الفروع</TableHead>
                  <TableHead className="text-end">المستخدمين</TableHead>
                  <TableHead className="text-end">الطلبات</TableHead>
                  <TableHead className="text-end">مبيعات اليوم</TableHead>
                  <TableHead className="text-end">مبيعات الشهر</TableHead>
                  <TableHead>آخر طلب</TableHead>
                  <TableHead>الإنشاء</TableHead>
                  <TableHead className="text-end">إجراءات</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell>
                      <Link href={`/admin/cafes/${c.id}`} className="font-medium text-slate-900 hover:text-indigo-600">
                        {c.name}
                      </Link>
                      <p className="text-xs text-slate-400">{c.slug}</p>
                    </TableCell>
                    <TableCell>
                      <SubscriptionBadge
                        status={c.subscriptionStatus}
                        label={t.admin.subStatus[c.subscriptionStatus as keyof typeof t.admin.subStatus] ?? c.subscriptionStatus}
                      />
                      <p className="mt-0.5 text-xs text-slate-400">{c.planName}</p>
                    </TableCell>
                    <TableCell>
                      <StatusPill active={c.isActive} labels={{ on: t.admin.cafeStatus.active, off: t.admin.cafeStatus.suspended }} />
                    </TableCell>
                    <TableCell className="text-end tabular-nums">{c.branches}</TableCell>
                    <TableCell className="text-end tabular-nums">{c.users}</TableCell>
                    <TableCell className="text-end tabular-nums">{c.orders}</TableCell>
                    <TableCell className="text-end tabular-nums">{money(c.todaySales)}</TableCell>
                    <TableCell className="text-end tabular-nums">{money(c.monthSales)}</TableCell>
                    <TableCell className="text-xs text-slate-500">
                      {c.lastOrderAt ? formatDateTime(c.lastOrderAt) : "—"}
                    </TableCell>
                    <TableCell className="text-xs text-slate-500">{formatDate(c.createdAt)}</TableCell>
                    <TableCell>
                      <div className="flex items-center justify-end gap-1">
                        <Button size="sm" variant="ghost" render={<Link href={`/admin/cafes/${c.id}`} />}>
                          {t.admin.actions.view}
                        </Button>
                        {c.owner && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setPwTarget({ id: c.owner!.id, name: `${t.roles.CAFE_OWNER}: ${c.owner!.name}` })}
                          >
                            {t.admin.actions.resetPassword}
                          </Button>
                        )}
                        {c.isActive ? (
                          <Button size="sm" variant="ghost" className="text-rose-600" onClick={() => setSuspendTarget(c)}>
                            {t.admin.actions.suspend}
                          </Button>
                        ) : (
                          <Button size="sm" variant="ghost" className="text-emerald-600" onClick={() => activate(c)}>
                            {t.admin.actions.activate}
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </Panel>

      <PasswordResetDialog
        open={!!pwTarget}
        onOpenChange={(v) => !v && setPwTarget(null)}
        endpoint={pwTarget ? `/api/admin/users/${pwTarget.id}` : null}
        subjectName={pwTarget?.name ?? ""}
      />
      <SuspendDialog
        cafe={suspendTarget}
        onOpenChange={(v) => !v && setSuspendTarget(null)}
        onDone={load}
      />
    </>
  );
}
