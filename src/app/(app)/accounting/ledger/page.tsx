"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useApp } from "@/components/app-shell";
import { money } from "@/lib/client";
import { dateStrInTz } from "@/lib/date-range";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useAccountingData } from "@/components/accounting/use-accounting-data";
import { SOURCE_LABELS } from "@/components/accounting/accounting-shell";

type Account = { id: string; code: string; name: string };
type Ledger = {
  account: { code: string; name: string; normalBalance: string };
  from: string; to: string; page: number; pageSize: number; lineCount: number; opening: number;
  totals: { debit: number; credit: number; closing: number };
  lines: { entryId: string; number: number; entryDate: string; description: string; sourceType: string; memo: string | null; debit: number; credit: number; balance: number }[];
};

export default function LedgerPage() {
  const { cafe } = useApp();
  const currency = cafe?.currency ?? "EGP";
  const today = dateStrInTz(new Date());
  const [account, setAccount] = useState("");
  const [from, setFrom] = useState(`${today.slice(0, 7)}-01`);
  const [to, setTo] = useState(today);
  const [page, setPage] = useState(1);
  // A link from the trial balance carries the account and window in the query.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const timer = window.setTimeout(() => {
      if (q.get("account")) setAccount(q.get("account")!);
      if (q.get("from")) setFrom(q.get("from")!);
      if (q.get("to")) setTo(q.get("to")!);
    }, 0);
    return () => clearTimeout(timer);
  }, []);
  const accounts = useAccountingData<{ accounts: Account[] }>("/api/accounting/accounts");
  const valid = !!account && from <= to;
  const { data, error, loading } = useAccountingData<Ledger>(valid ? `/api/accounting/ledger?${new URLSearchParams({ accountId: account, from, to, page: String(page) })}` : null);
  const fmt = (n: number) => money(n, currency);
  const pages = data ? Math.max(1, Math.ceil(data.lineCount / data.pageSize)) : 1;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <Label htmlFor="gl-account">الحساب</Label>
          <select id="gl-account" className="h-9 min-w-56 rounded-lg border border-input bg-background px-3 text-sm" value={account} onChange={(e) => { setAccount(e.target.value); setPage(1); }}>
            <option value="">اختار الحساب…</option>
            {accounts.data?.accounts.map((a) => <option key={a.id} value={a.id}>{a.code} — {a.name}</option>)}
          </select>
        </div>
        <div className="space-y-1"><Label htmlFor="gl-from">من</Label><Input id="gl-from" type="date" dir="ltr" value={from} onChange={(e) => { setFrom(e.target.value); setPage(1); }} /></div>
        <div className="space-y-1"><Label htmlFor="gl-to">إلى</Label><Input id="gl-to" type="date" dir="ltr" value={to} onChange={(e) => { setTo(e.target.value); setPage(1); }} /></div>
      </div>
      {!account && <p className="text-muted-foreground">اختار حساب علشان تشوف حركته.</p>}
      {error && <p role="alert" className="rounded border p-3 text-destructive">{error}</p>}
      {loading && <p role="status">جاري التحميل…</p>}
      {data && (
        <>
          <div className="grid gap-2 text-sm sm:grid-cols-4">
            <p>رصيد أول المدة: <b className="tabular-nums">{fmt(data.opening)}</b></p>
            <p>مدين الفترة: <b className="tabular-nums">{fmt(data.totals.debit)}</b></p>
            <p>دائن الفترة: <b className="tabular-nums">{fmt(data.totals.credit)}</b></p>
            <p>رصيد آخر المدة: <b className="tabular-nums">{fmt(data.totals.closing)}</b></p>
          </div>
          <p className="text-xs text-muted-foreground">الإجماليات محسوبة على كل السطور ({data.lineCount} سطر)، مش على الصفحة المعروضة بس.</p>
          {data.lines.length === 0 ? <p className="text-muted-foreground">مفيش حركة على الحساب ده في الفترة.</p> : (
            <div className="overflow-x-auto rounded-lg border">
              <Table>
                <TableHeader><TableRow><TableHead>التاريخ</TableHead><TableHead>القيد</TableHead><TableHead>البيان</TableHead><TableHead>المصدر</TableHead><TableHead className="text-end">مدين</TableHead><TableHead className="text-end">دائن</TableHead><TableHead className="text-end">الرصيد</TableHead></TableRow></TableHeader>
                <TableBody>
                  {data.lines.map((l, i) => (
                    <TableRow key={`${l.entryId}:${i}`}>
                      <TableCell dir="ltr">{l.entryDate}</TableCell>
                      <TableCell><Link className="text-primary underline" href={`/accounting/journal/${l.entryId}`}>#{l.number}</Link></TableCell>
                      <TableCell dir="auto">{l.description}{l.memo ? ` — ${l.memo}` : ""}</TableCell>
                      <TableCell>{SOURCE_LABELS[l.sourceType] ?? l.sourceType}</TableCell>
                      <TableCell className="text-end tabular-nums">{l.debit ? fmt(l.debit) : ""}</TableCell>
                      <TableCell className="text-end tabular-nums">{l.credit ? fmt(l.credit) : ""}</TableCell>
                      <TableCell className="text-end tabular-nums">{fmt(l.balance)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
          {pages > 1 && (
            <div className="flex items-center gap-2">
              <Button variant="outline" disabled={page <= 1 || loading} onClick={() => setPage(page - 1)}>السابق</Button>
              <span className="text-sm">صفحة {page} من {pages}</span>
              <Button variant="outline" disabled={page >= pages || loading} onClick={() => setPage(page + 1)}>التالي</Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
