"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api, money } from "@/lib/client";
import { t } from "@/lib/i18n";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { PageHeader, StatCard, Panel, Donut, EmptyState, LoadingBlock } from "@/components/admin/ui";

type Report = {
  currency: string | null;
  totals: { totalSales: number; totalOrders: number; cash: number; card: number; wallet: number };
  topCafes: { cafeId: string; name: string; currency: string; sales: number; orders: number }[];
};

export default function AdminPaymentsPage() {
  const [data, setData] = useState<Report | null>(null);
  const showMoney = (v: number) => (data?.currency ? money(v, data.currency) : "—");

  useEffect(() => {
    api<Report>("/api/admin/reports")
      .then(setData)
      .catch((e) => toast.error(e instanceof Error ? e.message : "فشل التحميل"));
  }, []);

  if (!data) {
    return (
      <>
        <PageHeader title={t.admin.nav.payments} subtitle="آخر ٣٠ يوم" />
        <LoadingBlock label={t.admin.loading} />
      </>
    );
  }

  const pm = t.paymentMethods;
  return (
    <>
      <PageHeader title={t.admin.nav.payments} subtitle="مدفوعات المنصة — آخر ٣٠ يوم" />

      {data.currency === null && <p role="status" className="mb-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">فيه كافيهات بعملات مختلفة، فالإجماليات المجمّعة مخفية — الأرقام بتظهر لكل كافيه بعملته.</p>}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="إجمالي المبيعات" value={showMoney(data.totals.totalSales)} icon="💰" accent="emerald" />
        <StatCard label={pm.CASH} value={showMoney(data.totals.cash)} icon="💵" accent="emerald" />
        <StatCard label={pm.CARD} value={showMoney(data.totals.card)} icon="💳" accent="slate" />
        <StatCard label={pm.WALLET} value={showMoney(data.totals.wallet)} icon="📱" accent="amber" />
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        {data.currency && <Panel title={t.admin.charts.byPayment}>
          <Donut
            data={[
              { label: pm.CASH, value: data.totals.cash },
              { label: pm.CARD, value: data.totals.card },
              { label: pm.WALLET, value: data.totals.wallet },
            ]}
          />
        </Panel>}
        <Panel title="المدفوعات حسب الكافيه">
          {data.topCafes.length === 0 ? <EmptyState message={t.admin.empty} icon="💰" /> : (
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
                    <TableCell className="text-end tabular-nums">{money(c.sales, c.currency)}</TableCell>
                    <TableCell className="text-end tabular-nums">{c.orders}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Panel>
      </div>
    </>
  );
}
