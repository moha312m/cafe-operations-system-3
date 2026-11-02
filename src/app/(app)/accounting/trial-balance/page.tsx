"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { useState } from "react";
import { useApp } from "@/components/app-shell";
import { money } from "@/lib/client";
import { dateStrInTz } from "@/lib/date-range";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ReportOutputActions } from "@/components/sales/report-output-actions";
import { useAccountingData } from "@/components/accounting/use-accounting-data";

type Row = { accountId: string; code: string; name: string; opening: number; debit: number; credit: number; movement: number; closing: number };
type Tb = { from: string; to: string; branchId: string | null; rows: Row[]; totals: { debit: number; credit: number; balanced: boolean }; outputSnapshot: string | null };

export default function TrialBalancePage() {
  const { cafe } = useApp();
  const currency = cafe?.currency ?? "EGP";
  const today = dateStrInTz(new Date());
  const [from, setFrom] = useState(`${today.slice(0, 7)}-01`);
  const [to, setTo] = useState(today);
  const valid = from <= to;
  const { data, error, loading, reload } = useAccountingData<Tb>(valid ? `/api/accounting/trial-balance?${new URLSearchParams({ from, to })}` : null);
  const fmt = (n: number) => money(n, currency);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1"><Label htmlFor="tb-from">من</Label><Input id="tb-from" type="date" dir="ltr" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
        <div className="space-y-1"><Label htmlFor="tb-to">إلى</Label><Input id="tb-to" type="date" dir="ltr" value={to} onChange={(e) => setTo(e.target.value)} /></div>
        <ReportOutputActions snapshot={data?.outputSnapshot ?? undefined} disabled={loading || !!error} />
      </div>
      {!valid && <p role="alert" className="text-destructive">تاريخ البداية بعد النهاية.</p>}
      <details className="rounded-lg border p-3 text-sm">
        <summary className="cursor-pointer font-medium">معنى الأعمدة</summary>
        <ul className="mt-2 list-disc space-y-1 pe-6 text-muted-foreground">
          <li><b>رصيد أول المدة</b>: رصيد الحساب قبل يوم &quot;من&quot;، على الجانب الطبيعي للحساب.</li>
          <li><b>مدين / دائن</b>: اللي اترحّل في الفترة بس.</li>
          <li><b>الحركة</b>: مدين ناقص دائن، بإشارة الجانب الطبيعي للحساب (السالب يعني عكس طبيعته).</li>
          <li><b>رصيد آخر المدة</b>: رصيد أول المدة + الحركة.</li>
          {data?.branchId && <li>انت شايف سطور فرعك بس؛ السطور اللي على مستوى الكافيه كله مش ظاهرة.</li>}
        </ul>
      </details>
      {error && <div role="alert" className="workspace-state text-destructive"><p>{error}</p><Button variant="outline" disabled={loading} onClick={reload}>{loading ? "جارٍ إعادة التحميل…" : "إعادة المحاولة"}</Button></div>}
      {loading && <p role="status">جاري التحميل…</p>}
      {data && data.rows.length === 0 && <p className="text-muted-foreground">مفيش قيود في الفترة دي.</p>}
      {data && data.rows.length > 0 && (
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>الكود</TableHead><TableHead>الحساب</TableHead>
                <TableHead className="text-end">رصيد أول المدة</TableHead><TableHead className="text-end">مدين</TableHead>
                <TableHead className="text-end">دائن</TableHead><TableHead className="text-end">الحركة</TableHead><TableHead className="text-end">رصيد آخر المدة</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.rows.map((r) => (
                <TableRow key={r.accountId}>
                  <TableCell dir="ltr">{r.code}</TableCell>
                  <TableCell><Link className="text-primary underline" href={`/accounting/ledger?account=${r.accountId}&from=${data.from}&to=${data.to}`}>{r.name}</Link></TableCell>
                  <TableCell className="text-end tabular-nums">{fmt(r.opening)}</TableCell>
                  <TableCell className="text-end tabular-nums">{fmt(r.debit)}</TableCell>
                  <TableCell className="text-end tabular-nums">{fmt(r.credit)}</TableCell>
                  <TableCell className="text-end tabular-nums">{fmt(r.movement)}</TableCell>
                  <TableCell className="text-end tabular-nums">{fmt(r.closing)}</TableCell>
                </TableRow>
              ))}
              <TableRow className="font-semibold">
                <TableCell colSpan={3}>الإجمالي {data.totals.balanced ? "— متوازن" : "— غير متوازن!"}</TableCell>
                <TableCell className="text-end tabular-nums">{fmt(data.totals.debit)}</TableCell>
                <TableCell className="text-end tabular-nums">{fmt(data.totals.credit)}</TableCell>
                <TableCell colSpan={2} />
              </TableRow>
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
