"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ArrowUpDown, CheckCircle2, Layers, ShieldAlert } from "lucide-react";
import { useApp } from "@/components/app-shell";
import { useAccountingData } from "@/components/accounting/use-accounting-data";
import { ReportOutputActions } from "@/components/sales/report-output-actions";
import { EmptyState, LoadingState, Panel, StatCard } from "@/components/cafe/ui";
import { Button } from "@/components/ui/button";
import { Input, nativeFieldClassName } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, money } from "@/lib/client";
import { dateStrInTz } from "@/lib/date-range";
import { cn } from "@/lib/utils";

type Row = {
  accountId: string;
  code: string;
  name: string;
  opening: number;
  debit: number;
  credit: number;
  movement: number;
  closing: number;
};

type BranchItem = { id: string; name: string };
type Tb = {
  from: string;
  to: string;
  branchId: string | null;
  rows: Row[];
  totals: { debit: number; credit: number; balanced: boolean };
  outputSnapshot: string | null;
};

export default function TrialBalancePage() {
  const { cafe, user } = useApp();
  const currency = cafe?.currency ?? "EGP";
  const today = dateStrInTz(new Date());

  const [from, setFrom] = useState(`${today.slice(0, 7)}-01`);
  const [to, setTo] = useState(today);
  const [branchId, setBranchId] = useState(user.branchId ?? "");
  const [branches, setBranches] = useState<BranchItem[]>([]);

  useEffect(() => {
    if (user.branchId) return;
    let mounted = true;
    api<{ branches: BranchItem[] }>("/api/branches")
      .then((res) => {
        if (mounted) setBranches(res.branches ?? []);
      })
      .catch(() => {});
    return () => {
      mounted = false;
    };
  }, [user.branchId]);

  const valid = !!from && !!to && from <= to;
  const query = new URLSearchParams({
    from,
    to,
    ...(!user.branchId && branchId ? { branchId } : {}),
  });

  const { data, error, loading, reload } = useAccountingData<Tb>(
    valid ? `/api/accounting/trial-balance?${query.toString()}` : null,
  );
  const fmt = (n: number) => money(n, currency);

  return (
    <div className="space-y-5">
      <div className="workspace-toolbar space-y-3">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="space-y-1.5">
            <Label htmlFor="tb-from">من تاريخ</Label>
            <Input id="tb-from" type="date" dir="ltr" value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="tb-to">إلى تاريخ</Label>
            <Input id="tb-to" type="date" dir="ltr" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
          {!user.branchId && branches.length > 1 && (
            <div className="space-y-1.5">
              <Label htmlFor="tb-branch">الفرع</Label>
              <select
                id="tb-branch"
                className={nativeFieldClassName}
                value={branchId}
                onChange={(e) => setBranchId(e.target.value)}
              >
                <option value="">كل الكافيه</option>
                {branches.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="flex items-end">
            <ReportOutputActions snapshot={data?.outputSnapshot ?? undefined} disabled={loading || !!error} />
          </div>
        </div>

        <details className="rounded-xl border border-border/70 bg-background/60 px-3.5 py-2.5 text-sm">
          <summary className="cursor-pointer font-medium text-foreground">شرح أعمدة ميزان المراجعة بالمجاميع والحركة</summary>
          <ul className="mt-2 list-disc space-y-1 pe-6 text-xs leading-relaxed text-muted-foreground">
            <li>
              <b>رصيد أول المدة:</b> رصيد الحساب التراكمي قبل تاريخ البداية حسب الجانب الطبيعي للحساب.
            </li>
            <li>
              <b>مدين / دائن:</b> مجاميع القيود المرحّلة داخل الفترة المختارة فقط.
            </li>
            <li>
              <b>صافي الحركة:</b> مدين ناقص دائن بإشارة الجانب الطبيعي للحساب (القيمة السالبة تعكس حركة معاكسة للطبيعة).
            </li>
            <li>
              <b>رصيد آخر المدة:</b> رصيد أول المدة + صافي الحركة.
            </li>
            {data?.branchId && <li>تعرض البيانات سطور الفرع المختار فقط، وتُستبعد القيود على مستوى الكافيه العام.</li>}
          </ul>
        </details>
      </div>

      {!valid && (
        <div role="alert" className="rounded-2xl border border-clay-line bg-clay-soft p-4 text-sm text-clay-ink">
          تاريخ البداية بعد تاريخ النهاية.
        </div>
      )}
      {error && (
        <div role="alert" className="workspace-state text-destructive">
          <p>{error}</p>
          <Button variant="outline" disabled={loading} onClick={reload}>
            {loading ? "جارٍ إعادة التحميل…" : "إعادة المحاولة"}
          </Button>
        </div>
      )}
      {loading && <LoadingState label="جارٍ احتساب ميزان المراجعة…" />}

      {data && (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard label="حسابات ذات حركة" value={data.rows.length} accent="blue" icon={<Layers className="size-5" />} />
            <StatCard label="إجمالي المدين بالفترة" value={fmt(data.totals.debit)} accent="emerald" icon={<ArrowUpDown className="size-5" />} />
            <StatCard label="إجمالي الدائن بالفترة" value={fmt(data.totals.credit)} accent="amber" icon={<ArrowUpDown className="size-5" />} />
            <StatCard
              label="حالة توازن الميزان"
              value={data.totals.balanced ? "متوازن" : "غير متوازن"}
              accent={data.totals.balanced ? "emerald" : "red"}
              icon={data.totals.balanced ? <CheckCircle2 className="size-5" /> : <ShieldAlert className="size-5" />}
            />
          </div>

          <Panel title="ميزان المراجعة بالمجاميع والأرصدة" bodyClassName="p-0">
            {data.rows.length === 0 ? (
              <div className="p-5">
                <EmptyState message="لا توجد قيود مرحّلة في الفترة المحددة." icon="⚖️" />
              </div>
            ) : (
              <div className="overflow-x-auto">
                <Table className="workspace-table">
                  <TableHeader>
                    <TableRow>
                      <TableHead>الكود</TableHead>
                      <TableHead>الحساب</TableHead>
                      <TableHead className="text-end">رصيد أول المدة</TableHead>
                      <TableHead className="text-end">مدين الفترة</TableHead>
                      <TableHead className="text-end">دائن الفترة</TableHead>
                      <TableHead className="text-end">الحركة</TableHead>
                      <TableHead className="text-end">رصيد آخر المدة</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.rows.map((r) => {
                      const ledgerParams = new URLSearchParams({
                        account: r.accountId,
                        from: data.from,
                        to: data.to,
                        ...(data.branchId ? { branchId: data.branchId } : {}),
                      });
                      return (
                        <TableRow key={r.accountId}>
                          <TableCell dir="ltr" className="tabular-figures text-muted-foreground">
                            {r.code}
                          </TableCell>
                          <TableCell>
                            <Link className="font-medium text-primary underline underline-offset-2" href={`/accounting/ledger?${ledgerParams.toString()}`}>
                              {r.name}
                            </Link>
                          </TableCell>
                          <TableCell className="text-end tabular-figures">{fmt(r.opening)}</TableCell>
                          <TableCell className="text-end tabular-figures text-sage-ink">{fmt(r.debit)}</TableCell>
                          <TableCell className="text-end tabular-figures text-caramel-ink">{fmt(r.credit)}</TableCell>
                          <TableCell className={cn("text-end tabular-figures", r.movement < 0 ? "text-clay-ink" : "text-foreground")}>
                            {fmt(r.movement)}
                          </TableCell>
                          <TableCell className="text-end font-semibold tabular-figures">{fmt(r.closing)}</TableCell>
                        </TableRow>
                      );
                    })}
                    <TableRow
                      className={cn(
                        "border-t-2 font-bold",
                        data.totals.balanced ? "bg-sage-soft text-sage-ink" : "bg-clay-soft text-clay-ink",
                      )}
                    >
                      <TableCell colSpan={3}>الإجمالي {data.totals.balanced ? "— متوازن" : "— غير متوازن!"}</TableCell>
                      <TableCell className="text-end tabular-figures">{fmt(data.totals.debit)}</TableCell>
                      <TableCell className="text-end tabular-figures">{fmt(data.totals.credit)}</TableCell>
                      <TableCell colSpan={2} />
                    </TableRow>
                  </TableBody>
                </Table>
              </div>
            )}
          </Panel>
        </>
      )}
    </div>
  );
}
