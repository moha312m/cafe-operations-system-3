"use client";

import Link from "next/link";
import { useState } from "react";
import { useApp } from "@/components/app-shell";
import { money } from "@/lib/client";
import { dateStrInTz } from "@/lib/date-range";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useAccountingData } from "@/components/accounting/use-accounting-data";
import { SOURCE_LABELS } from "@/components/accounting/accounting-shell";

type Journal = {
  page: number; pageSize: number; count: number;
  sourceTypes: { sourceType: string; count: number }[];
  entries: { id: string; number: number; entryDate: string; description: string; sourceType: string; reversalOfId: string | null; reversedBy: { id: string; number: number } | null; amount: number }[];
};

export default function JournalPage() {
  const { cafe } = useApp();
  const currency = cafe?.currency ?? "EGP";
  const today = dateStrInTz(new Date());
  const [from, setFrom] = useState(`${today.slice(0, 7)}-01`);
  const [to, setTo] = useState(today);
  const [sourceType, setSourceType] = useState("");
  const [page, setPage] = useState(1);
  const valid = from <= to;
  const query = new URLSearchParams({ from, to, page: String(page), ...(sourceType ? { sourceType } : {}) });
  const { data, error, loading } = useAccountingData<Journal>(valid ? `/api/accounting/journal?${query}` : null);
  const pages = data ? Math.max(1, Math.ceil(data.count / data.pageSize)) : 1;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1"><Label htmlFor="j-from">من</Label><Input id="j-from" type="date" dir="ltr" value={from} onChange={(e) => { setFrom(e.target.value); setPage(1); }} /></div>
        <div className="space-y-1"><Label htmlFor="j-to">إلى</Label><Input id="j-to" type="date" dir="ltr" value={to} onChange={(e) => { setTo(e.target.value); setPage(1); }} /></div>
        <div className="space-y-1">
          <Label htmlFor="j-source">نوع المصدر</Label>
          <select id="j-source" className="h-9 rounded-lg border border-input bg-background px-3 text-sm" value={sourceType} onChange={(e) => { setSourceType(e.target.value); setPage(1); }}>
            <option value="">الكل</option>
            {data?.sourceTypes.map((s) => <option key={s.sourceType} value={s.sourceType}>{SOURCE_LABELS[s.sourceType] ?? s.sourceType} ({s.count})</option>)}
          </select>
        </div>
      </div>
      {!valid && <p role="alert" className="text-destructive">تاريخ البداية بعد النهاية.</p>}
      {error && <p role="alert" className="rounded border p-3 text-destructive">{error}</p>}
      {loading && <p role="status">جاري التحميل…</p>}
      {data && data.entries.length === 0 && <p className="text-muted-foreground">مفيش قيود في الفترة دي.</p>}
      {data && data.entries.length > 0 && (
        <>
          <p className="text-sm text-muted-foreground">{data.count} قيد</p>
          <div className="overflow-x-auto rounded-lg border">
            <Table>
              <TableHeader><TableRow><TableHead>رقم</TableHead><TableHead>التاريخ</TableHead><TableHead>البيان</TableHead><TableHead>المصدر</TableHead><TableHead className="text-end">المبلغ</TableHead><TableHead>العكس</TableHead></TableRow></TableHeader>
              <TableBody>
                {data.entries.map((e) => (
                  <TableRow key={e.id}>
                    <TableCell><Link className="text-primary underline" href={`/accounting/journal/${e.id}`}>#{e.number}</Link></TableCell>
                    <TableCell dir="ltr">{e.entryDate}</TableCell>
                    <TableCell dir="auto">{e.description}</TableCell>
                    <TableCell>{SOURCE_LABELS[e.sourceType] ?? e.sourceType}</TableCell>
                    <TableCell className="text-end tabular-nums">{money(e.amount, currency)}</TableCell>
                    <TableCell className="text-sm">{e.reversedBy ? `اتعكس بالقيد #${e.reversedBy.number}` : e.reversalOfId ? "قيد عكسي" : ""}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
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
