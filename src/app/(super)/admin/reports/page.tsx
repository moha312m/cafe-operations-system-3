"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { api, money } from "@/lib/client";
import { t } from "@/lib/i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { PageHeader, StatCard, Panel, EmptyState, LoadingBlock } from "@/components/admin/ui";

type Report = {
  totals: { totalSales: number; totalOrders: number; avgOrderValue: number; cash: number; card: number; wallet: number };
  topCafes: { cafeId: string; name: string; sales: number; orders: number }[];
  lowActivity: { cafeId: string; name: string; isActive: boolean }[];
};

function csvDownload(rows: (string | number)[][], filename: string) {
  const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

export default function AdminReportsPage() {
  const [cafes, setCafes] = useState<{ id: string; name: string }[]>([]);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [cafeId, setCafeId] = useState("");
  const [method, setMethod] = useState("");
  const [data, setData] = useState<Report | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api<{ cafes: { id: string; name: string }[] }>("/api/admin/cafes")
      .then((r) => setCafes(r.cafes))
      .catch(() => {});
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams();
      if (from) qs.set("from", from);
      if (to) qs.set("to", to);
      if (cafeId) qs.set("cafeId", cafeId);
      if (method) qs.set("method", method);
      setData(await api<Report>(`/api/admin/reports?${qs.toString()}`));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "فشل تحميل التقرير");
    } finally {
      setLoading(false);
    }
  }, [from, to, cafeId, method]);

  useEffect(() => { load(); }, [load]);

  function exportCsv() {
    if (!data) return;
    csvDownload(
      [
        ["الكافيه", "المبيعات", "عدد الطلبات"],
        ...data.topCafes.map((c) => [c.name, c.sales, c.orders]),
      ],
      "platform-report.csv"
    );
  }

  return (
    <>
      <PageHeader title={t.admin.nav.reports} subtitle="تقارير المبيعات لكل المنصة">
        <Button variant="outline" size="sm" onClick={exportCsv} disabled={!data}>
          {t.admin.actions.exportCsv}
        </Button>
      </PageHeader>

      <Panel className="mb-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="space-y-1.5">
            <Label className="text-xs">من تاريخ</Label>
            <Input type="date" dir="ltr" value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">إلى تاريخ</Label>
            <Input type="date" dir="ltr" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">الكافيه</Label>
            <select value={cafeId} onChange={(e) => setCafeId(e.target.value)} className="h-9 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm">
              <option value="">كل الكافيهات</option>
              {cafes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">طريقة الدفع</Label>
            <select value={method} onChange={(e) => setMethod(e.target.value)} className="h-9 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm">
              <option value="">الكل</option>
              <option value="CASH">{t.paymentMethods.CASH}</option>
              <option value="CARD">{t.paymentMethods.CARD}</option>
              <option value="WALLET">{t.paymentMethods.WALLET}</option>
            </select>
          </div>
        </div>
      </Panel>

      {loading || !data ? (
        <LoadingBlock label={t.admin.loading} />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
            <StatCard label="إجمالي المبيعات" value={money(data.totals.totalSales)} icon="💰" accent="emerald" />
            <StatCard label="إجمالي الطلبات" value={data.totals.totalOrders} icon="🧾" accent="indigo" />
            <StatCard label="متوسط قيمة الطلب" value={money(data.totals.avgOrderValue)} icon="📊" accent="violet" />
            <StatCard label={`${t.paymentMethods.CASH}`} value={money(data.totals.cash)} icon="💵" accent="emerald" />
            <StatCard label={`${t.paymentMethods.CARD}`} value={money(data.totals.card)} icon="💳" accent="slate" />
            <StatCard label={`${t.paymentMethods.WALLET}`} value={money(data.totals.wallet)} icon="📱" accent="amber" />
          </div>

          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            <Panel title="أعلى الكافيهات مبيعًا">
              {data.topCafes.length === 0 ? <EmptyState message={t.admin.empty} icon="🏆" /> : (
                <Table>
                  <TableHeader><TableRow>
                    <TableHead>الكافيه</TableHead>
                    <TableHead className="text-end">المبيعات</TableHead>
                    <TableHead className="text-end">الطلبات</TableHead>
                  </TableRow></TableHeader>
                  <TableBody>
                    {data.topCafes.map((c) => (
                      <TableRow key={c.cafeId}>
                        <TableCell className="font-medium">{c.name}</TableCell>
                        <TableCell className="text-end tabular-nums">{money(c.sales)}</TableCell>
                        <TableCell className="text-end tabular-nums">{c.orders}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </Panel>
            <Panel title="أقل الكافيهات نشاطًا (لا مبيعات في الفترة)">
              {data.lowActivity.length === 0 ? <EmptyState message="كل الكافيهات نشطة في الفترة" icon="✅" /> : (
                <ul className="divide-y divide-slate-100">
                  {data.lowActivity.map((c) => (
                    <li key={c.cafeId} className="flex items-center justify-between py-2.5 text-sm">
                      <span className="font-medium text-slate-700">{c.name}</span>
                      <span className={`text-xs ${c.isActive ? "text-amber-600" : "text-rose-600"}`}>
                        {c.isActive ? "نشط بدون مبيعات" : t.admin.cafeStatus.suspended}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          </div>
        </>
      )}
    </>
  );
}
