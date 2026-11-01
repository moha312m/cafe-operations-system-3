"use client";

import Link from "next/link";
import { useApp } from "@/components/app-shell";
import { money } from "@/lib/client";
import { formatTime } from "@/lib/i18n";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useAccountingData } from "@/components/accounting/use-accounting-data";
import { ISSUE_LABELS, SOURCE_LABELS, statusLabel } from "@/components/accounting/accounting-shell";

type Entry = {
  number: number; entryDate: string; postedAt: string; description: string; sourceType: string; sourceKey: string;
  period: { startsOn: string; endsOn: string; status: string };
  actor: string | null;
  reversalOf: { id: string; number: number } | null; reversedBy: { id: string; number: number } | null;
  lines: { accountId: string; code: string; account: string; branch: string | null; memo: string | null; debit: number; credit: number }[];
  totals: { debit: number; credit: number };
  source: { link: { label: string; href: string } | null; evidence: Record<string, unknown> | null };
  issues: { kind: string; severity: string; reason: string }[];
};

const EVIDENCE_LABELS: Record<string, string> = {
  kind: "النوع", reference: "المرجع", status: "الحالة", method: "طريقة الدفع", fundingSource: "مصدر الفلوس", supplier: "المورد",
  createdAt: "وقت التسجيل", servedAt: "وقت التقديم", confirmedAt: "وقت التأكيد", cancelledAt: "وقت الإلغاء", amount: "المبلغ",
  reason: "السبب", oldTotal: "الإجمالي قبل", newTotal: "الإجمالي بعد", type: "نوع الحركة", quantity: "الكمية", unit: "الوحدة", note: "ملاحظة",
};
const showValue = (v: unknown) => (v === null || v === undefined || v === "" ? "—" : typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v) ? formatTime(v) : String(v));

export function JournalEntryView({ id }: { id: string }) {
  const { cafe } = useApp();
  const currency = cafe?.currency ?? "EGP";
  const { data, error, loading } = useAccountingData<Entry>(`/api/accounting/journal/${id}`);
  if (error) return <p role="alert" className="rounded border p-3 text-destructive">{error}</p>;
  if (!data) return <p role="status">{loading ? "جاري التحميل…" : ""}</p>;
  const fmt = (n: number) => money(n, currency);

  return (
    <div className="space-y-3">
      <Link className="text-sm text-primary underline" href="/accounting/journal">← كل القيود</Link>
      <Card>
        <CardHeader><CardTitle>القيد #{data.number} — <span dir="auto">{data.description}</span></CardTitle></CardHeader>
        <CardContent className="grid gap-2 text-sm sm:grid-cols-2">
          <p>تاريخ القيد: <b dir="ltr">{data.entryDate}</b></p>
          <p>اترحّل: {formatTime(data.postedAt)}</p>
          <p>المصدر: {SOURCE_LABELS[data.sourceType] ?? data.sourceType} <span className="text-xs text-muted-foreground" dir="ltr">({data.sourceKey})</span></p>
          <p>الفترة: <span dir="ltr">{data.period.startsOn} ← {data.period.endsOn}</span> ({statusLabel(data.period.status)})</p>
          <p>رحّله: {data.actor ?? "الترحيل التجريبي التلقائي"}</p>
          <p>
            {data.reversedBy && <>اتعكس بالقيد <Link className="text-primary underline" href={`/accounting/journal/${data.reversedBy.id}`}>#{data.reversedBy.number}</Link></>}
            {data.reversalOf && <>ده عكس القيد <Link className="text-primary underline" href={`/accounting/journal/${data.reversalOf.id}`}>#{data.reversalOf.number}</Link></>}
            {!data.reversedBy && !data.reversalOf && "مش معكوس"}
          </p>
        </CardContent>
      </Card>

      {data.issues.length > 0 && (
        <div role="alert" className="rounded-lg border border-red-300 p-3 text-sm">
          {data.issues.map((i) => <p key={i.kind}><b>{ISSUE_LABELS[i.kind] ?? i.kind}</b>: {i.reason}</p>)}
        </div>
      )}

      <div className="overflow-x-auto rounded-lg border">
        <Table>
          <TableHeader><TableRow><TableHead>الكود</TableHead><TableHead>الحساب</TableHead><TableHead>الفرع</TableHead><TableHead>ملاحظة</TableHead><TableHead className="text-end">مدين</TableHead><TableHead className="text-end">دائن</TableHead></TableRow></TableHeader>
          <TableBody>
            {data.lines.map((l, i) => (
              <TableRow key={i}>
                <TableCell dir="ltr">{l.code}</TableCell>
                <TableCell><Link className="text-primary underline" href={`/accounting/ledger?account=${l.accountId}&from=${data.entryDate}&to=${data.entryDate}`}>{l.account}</Link></TableCell>
                <TableCell>{l.branch ?? "الكافيه كله"}</TableCell>
                <TableCell dir="auto">{l.memo ?? ""}</TableCell>
                <TableCell className="text-end tabular-nums">{l.debit ? fmt(l.debit) : ""}</TableCell>
                <TableCell className="text-end tabular-nums">{l.credit ? fmt(l.credit) : ""}</TableCell>
              </TableRow>
            ))}
            <TableRow className="font-semibold"><TableCell colSpan={4}>الإجمالي</TableCell><TableCell className="text-end tabular-nums">{fmt(data.totals.debit)}</TableCell><TableCell className="text-end tabular-nums">{fmt(data.totals.credit)}</TableCell></TableRow>
          </TableBody>
        </Table>
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base">المصدر في التشغيل</CardTitle></CardHeader>
        <CardContent className="space-y-1 text-sm">
          {data.source.evidence ? (
            <dl className="grid gap-1 sm:grid-cols-2">
              {Object.entries(data.source.evidence).map(([k, v]) => (
                <div key={k} className="flex gap-2"><dt className="text-muted-foreground">{EVIDENCE_LABELS[k] ?? k}:</dt><dd dir="auto">{showValue(v)}</dd></div>
              ))}
            </dl>
          ) : <p className="text-muted-foreground">المصدر مش موجود دلوقتي في التشغيل، أو القيد مالوش مصدر تشغيلي.</p>}
          {data.source.link && <Link className="text-primary underline" href={data.source.link.href}>افتح شاشة {data.source.link.label} ←</Link>}
        </CardContent>
      </Card>
    </div>
  );
}
