"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowRight, ExternalLink, RotateCcw, ShieldAlert } from "lucide-react";
import { toast } from "sonner";
import { useApp } from "@/components/app-shell";
import { useAccountingData } from "@/components/accounting/use-accounting-data";
import { ISSUE_LABELS, SOURCE_LABELS, statusLabel } from "@/components/accounting/accounting-shell";
import { EmptyState, LoadingState, Panel, StatCard } from "@/components/cafe/ui";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, money } from "@/lib/client";
import { dateStrInTz } from "@/lib/date-range";
import { formatTime } from "@/lib/i18n";

type Entry = {
  number: number;
  entryDate: string;
  postedAt: string;
  description: string;
  sourceType: string;
  sourceKey: string;
  period: { startsOn: string; endsOn: string; status: string };
  actor: string | null;
  reversalOf: { id: string; number: number } | null;
  reversedBy: { id: string; number: number } | null;
  lines: {
    accountId: string;
    code: string;
    account: string;
    branch: string | null;
    memo: string | null;
    debit: number;
    credit: number;
  }[];
  totals: { debit: number; credit: number };
  source: { link: { label: string; href: string } | null; evidence: Record<string, unknown> | null };
  issues: { kind: string; severity: string; reason: string }[];
};

const EVIDENCE_LABELS: Record<string, string> = {
  kind: "النوع",
  reference: "المرجع",
  status: "الحالة",
  method: "طريقة الدفع",
  fundingSource: "مصدر الفلوس",
  supplier: "المورد",
  category: "التصنيف",
  description: "الوصف",
  actor: "المستخدم",
  account: "الحساب",
  from: "من حساب",
  to: "إلى حساب",
  entryDate: "تاريخ القيد الأصلي",
  sourceType: "نوع المصدر",
  createdAt: "وقت التسجيل",
  servedAt: "وقت التقديم",
  confirmedAt: "وقت التأكيد",
  cancelledAt: "وقت الإلغاء",
  amount: "المبلغ",
  reason: "السبب",
  oldTotal: "الإجمالي قبل",
  newTotal: "الإجمالي بعد",
  type: "نوع الحركة",
  quantity: "الكمية",
  unit: "الوحدة",
  note: "ملاحظة",
};

const showValue = (v: unknown) =>
  v === null || v === undefined || v === ""
    ? "—"
    : typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v)
      ? formatTime(v)
      : String(v);

export function JournalEntryView({ id }: { id: string }) {
  const { cafe, user, canKey } = useApp();
  const currency = cafe?.currency ?? "EGP";
  const { data, error, loading, reload } = useAccountingData<Entry>(`/api/accounting/journal/${id}`);

  const [reverseOpen, setReverseOpen] = useState(false);
  const [reverseDate, setReverseDate] = useState(dateStrInTz(new Date()));
  const [reverseReason, setReverseReason] = useState("");
  const [reverseKey, setReverseKey] = useState("");
  const [reversing, setReversing] = useState(false);
  const [reverseError, setReverseError] = useState("");

  if (error) {
    return (
      <div role="alert" className="workspace-state text-destructive">
        <p>{error}</p>
        <Button variant="outline" disabled={loading} onClick={reload}>
          {loading ? "جارٍ إعادة التحميل…" : "إعادة المحاولة"}
        </Button>
      </div>
    );
  }
  if (!data) return <LoadingState label={loading ? "جارٍ تحميل تفاصيل القيد…" : "جارٍ التحضير…"} />;

  const fmt = (n: number) => money(n, currency);
  const canReverse = !user.branchId && canKey("accounting.reverse") && !data.reversalOf && !data.reversedBy;

  async function submitReverse(e: React.FormEvent) {
    e.preventDefault();
    if (reverseReason.trim().length < 3) {
      setReverseError("أدخل سببًا واضحًا لعكس القيد (٣ أحرف على الأقل)");
      return;
    }
    setReversing(true);
    setReverseError("");
    try {
      const res = await api<{ reversal: { id: string; number: number } }>(`/api/accounting/journal/${id}/reverse`, {
        method: "POST",
        body: { entryDate: reverseDate, reason: reverseReason.trim() },
        idempotencyKey: reverseKey || `rev_${id}_${crypto.randomUUID()}`,
      });
      toast.success(`تم إنشاء قيد عكسي رقم #${res.reversal.number}`);
      setReverseOpen(false);
      setReverseReason("");
      await reload();
    } catch (err) {
      setReverseError(err instanceof Error ? err.message : "تعذّر عكس القيد");
    } finally {
      setReversing(false);
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Link
          className="inline-flex items-center gap-1.5 rounded-xl border border-border bg-card px-3.5 py-2 text-sm font-medium text-foreground shadow-sm transition-colors hover:bg-muted"
          href="/accounting/journal"
        >
          <ArrowRight className="size-4" />
          <span>العودة لدفتر القيود</span>
        </Link>

        {canReverse && (
          <Button
            variant="outline"
            onClick={() => {
              setReverseDate(dateStrInTz(new Date()));
              setReverseReason("");
              setReverseKey(`rev_${id}_${crypto.randomUUID()}`);
              setReverseError("");
              setReverseOpen(true);
            }}
          >
            <RotateCcw className="size-4" />
            <span>عكس القيد بقيد مقابل</span>
          </Button>
        )}
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="رقم القيد" value={`#${data.number}`} accent="blue" />
        <StatCard label="تاريخ القيد" value={data.entryDate} accent="slate" />
        <StatCard label="إجمالي المدين" value={fmt(data.totals.debit)} accent="emerald" />
        <StatCard label="إجمالي الدائن" value={fmt(data.totals.credit)} accent="amber" />
      </div>

      <Panel
        title={`تفاصيل القيد #${data.number}`}
        action={
          data.reversedBy ? (
            <Link
              href={`/accounting/journal/${data.reversedBy.id}`}
              className="rounded-full border border-clay-line bg-clay-soft px-3 py-1 text-xs font-semibold text-clay-ink hover:underline"
            >
              معكوس بالقيد #{data.reversedBy.number}
            </Link>
          ) : data.reversalOf ? (
            <Link
              href={`/accounting/journal/${data.reversalOf.id}`}
              className="rounded-full border border-tide-line bg-tide-soft px-3 py-1 text-xs font-semibold text-tide-ink hover:underline"
            >
              قيد عكسي للقيد #{data.reversalOf.number}
            </Link>
          ) : (
            <span className="rounded-full border border-sage-line bg-sage-soft px-3 py-1 text-xs font-semibold text-sage-ink">
              قيد ساري
            </span>
          )
        }
      >
        <div className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
          <div>
            <p className="text-xs text-muted-foreground">البيان</p>
            <p className="mt-0.5 font-medium" dir="auto">
              {data.description}
            </p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">المصدر ومفتاح المنع المكرر</p>
            <p className="mt-0.5">
              <span className="font-medium">{SOURCE_LABELS[data.sourceType] ?? data.sourceType}</span>{" "}
              <span className="text-xs text-muted-foreground" dir="ltr">
                ({data.sourceKey})
              </span>
            </p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">الفترة المحاسبية</p>
            <p className="mt-0.5">
              <span dir="ltr" className="tabular-figures">
                {data.period.startsOn} ← {data.period.endsOn}
              </span>{" "}
              <span className="text-xs text-muted-foreground">({statusLabel(data.period.status)})</span>
            </p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">وقت الترحيل</p>
            <p className="mt-0.5">{formatTime(data.postedAt)}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">المسؤول عن الترحيل</p>
            <p className="mt-0.5">{data.actor ?? "الترحيل التجريبي التلقائي"}</p>
          </div>
        </div>
      </Panel>

      {data.issues.length > 0 && (
        <div role="alert" className="space-y-1 rounded-2xl border border-clay-line bg-clay-soft p-4 text-sm text-clay-ink">
          {data.issues.map((i) => (
            <p key={i.kind} className="flex items-start gap-2">
              <ShieldAlert className="mt-0.5 size-4 shrink-0" />
              <span>
                <b>{ISSUE_LABELS[i.kind] ?? i.kind}:</b> {i.reason}
              </span>
            </p>
          ))}
        </div>
      )}

      <Panel title="سطور القيد" bodyClassName="p-0">
        <div className="overflow-x-auto">
          <Table className="workspace-table">
            <TableHeader>
              <TableRow>
                <TableHead>الكود</TableHead>
                <TableHead>الحساب</TableHead>
                <TableHead>الفرع</TableHead>
                <TableHead>ملاحظة السطر</TableHead>
                <TableHead className="text-end">مدين</TableHead>
                <TableHead className="text-end">دائن</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.lines.map((l, i) => (
                <TableRow key={i}>
                  <TableCell dir="ltr" className="tabular-figures text-muted-foreground">
                    {l.code}
                  </TableCell>
                  <TableCell>
                    <Link
                      className="font-medium text-primary underline underline-offset-2"
                      href={`/accounting/ledger?account=${l.accountId}&from=${data.entryDate}&to=${data.entryDate}`}
                    >
                      {l.account}
                    </Link>
                  </TableCell>
                  <TableCell>{l.branch ?? "الكافيه كله"}</TableCell>
                  <TableCell dir="auto" className="text-muted-foreground">
                    {l.memo ?? "—"}
                  </TableCell>
                  <TableCell className="text-end font-medium tabular-figures text-sage-ink">
                    {l.debit ? fmt(l.debit) : ""}
                  </TableCell>
                  <TableCell className="text-end font-medium tabular-figures text-caramel-ink">
                    {l.credit ? fmt(l.credit) : ""}
                  </TableCell>
                </TableRow>
              ))}
              <TableRow className="bg-muted/40 font-semibold">
                <TableCell colSpan={4}>الإجمالي</TableCell>
                <TableCell className="text-end tabular-figures">{fmt(data.totals.debit)}</TableCell>
                <TableCell className="text-end tabular-figures">{fmt(data.totals.credit)}</TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </div>
      </Panel>

      <Panel
        title="المصدر التشغيلي المسجل"
        action={
          data.source.link ? (
            <Link
              className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
              href={data.source.link.href}
            >
              <span>افتح شاشة {data.source.link.label}</span>
              <ExternalLink className="size-3.5" />
            </Link>
          ) : undefined
        }
      >
        {data.source.evidence ? (
          <dl className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
            {Object.entries(data.source.evidence).map(([k, v]) => (
              <div key={k} className="rounded-xl border border-border/70 bg-background/60 px-3 py-2">
                <dt className="text-xs text-muted-foreground">{EVIDENCE_LABELS[k] ?? k}</dt>
                <dd className="mt-0.5 font-medium" dir="auto">
                  {showValue(v)}
                </dd>
              </div>
            ))}
          </dl>
        ) : (
          <EmptyState message="المصدر غير متاح حاليًا في سجلات التشغيل، أو القيد مسجّل مباشرةً في الدفاتر." icon="📎" />
        )}
      </Panel>

      <Dialog open={reverseOpen} onOpenChange={(open) => !open && setReverseOpen(false)}>
        <DialogContent className="sm:max-w-md" dir="rtl">
          <DialogTitle>عكس القيد #{data.number}</DialogTitle>
          <form onSubmit={submitReverse} className="space-y-4">
            <p className="rounded-xl border border-caramel-line bg-caramel-soft p-3 text-xs leading-relaxed text-caramel-ink">
              سيتم إنشاء قيد عكسي جديد يعكس المدين والدائن في التاريخ المختار، مع بقاء القيد الأصلي #{data.number} محفوظًا كما هو للمراجعة.
            </p>

            <div className="space-y-1.5">
              <Label htmlFor="rev-date">تاريخ القيد العكسي</Label>
              <Input
                id="rev-date"
                type="date"
                dir="ltr"
                value={reverseDate}
                onChange={(e) => {
                  setReverseDate(e.target.value);
                  setReverseKey(`rev_${id}_${crypto.randomUUID()}`);
                }}
                required
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="rev-reason">سبب العكس (إلزامي)</Label>
              <Input
                id="rev-reason"
                placeholder="مثال: تصحيح تصنيف أو إلغاء تسجيل مكرر"
                value={reverseReason}
                onChange={(e) => {
                  setReverseReason(e.target.value);
                  setReverseKey(`rev_${id}_${crypto.randomUUID()}`);
                }}
                maxLength={300}
                required
              />
            </div>

            {reverseError && (
              <p role="alert" className="text-sm font-medium text-destructive">
                {reverseError}
              </p>
            )}

            <div className="flex items-center justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => setReverseOpen(false)} disabled={reversing}>
                إلغاء
              </Button>
              <Button type="submit" disabled={reversing}>
                {reversing ? "جارٍ تسجيل القيد العكسي…" : "اعتماد القيد العكسي"}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
