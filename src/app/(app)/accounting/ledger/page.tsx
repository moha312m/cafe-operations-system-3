"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ArrowUpDown, BookOpenCheck, Scale } from "lucide-react";
import { useApp } from "@/components/app-shell";
import { useAccountingData } from "@/components/accounting/use-accounting-data";
import { SOURCE_LABELS } from "@/components/accounting/accounting-shell";
import { EmptyState, LoadingState, Panel, StatCard } from "@/components/cafe/ui";
import { Button } from "@/components/ui/button";
import { Input, nativeFieldClassName } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, money } from "@/lib/client";
import { dateStrInTz } from "@/lib/date-range";

type Account = { id: string; code: string; name: string };
type BranchItem = { id: string; name: string };
type Ledger = {
  account: { code: string; name: string; normalBalance: string };
  from: string;
  to: string;
  branchId: string | null;
  page: number;
  pageSize: number;
  lineCount: number;
  opening: number;
  totals: { debit: number; credit: number; closing: number };
  lines: {
    entryId: string;
    number: number;
    entryDate: string;
    description: string;
    sourceType: string;
    memo: string | null;
    debit: number;
    credit: number;
    balance: number;
  }[];
};

export default function LedgerPage() {
  const { cafe, user } = useApp();
  const currency = cafe?.currency ?? "EGP";
  const today = dateStrInTz(new Date());

  const [account, setAccount] = useState("");
  const [from, setFrom] = useState(`${today.slice(0, 7)}-01`);
  const [to, setTo] = useState(today);
  const [branchId, setBranchId] = useState(user.branchId ?? "");
  const [branches, setBranches] = useState<BranchItem[]>([]);
  const [page, setPage] = useState(1);

  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const timer = window.setTimeout(() => {
      if (q.get("account")) setAccount(q.get("account")!);
      if (q.get("from")) setFrom(q.get("from")!);
      if (q.get("to")) setTo(q.get("to")!);
      if (!user.branchId && q.get("branchId")) setBranchId(q.get("branchId")!);
    }, 0);
    return () => clearTimeout(timer);
  }, [user.branchId]);

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

  const accounts = useAccountingData<{ accounts: Account[] }>("/api/accounting/accounts");
  const valid = !!account && from <= to;
  const query = new URLSearchParams({
    accountId: account,
    from,
    to,
    page: String(page),
    ...(!user.branchId && branchId ? { branchId } : {}),
  });

  const { data, error, loading, reload } = useAccountingData<Ledger>(
    valid ? `/api/accounting/ledger?${query.toString()}` : null,
  );
  const fmt = (n: number) => money(n, currency);
  const pages = data ? Math.max(1, Math.ceil(data.lineCount / data.pageSize)) : 1;

  return (
    <div className="space-y-5">
      <div className="workspace-toolbar grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="space-y-1.5 sm:col-span-2 lg:col-span-1">
          <Label htmlFor="gl-account">الحساب</Label>
          <select
            id="gl-account"
            className={nativeFieldClassName}
            value={account}
            onChange={(e) => {
              setAccount(e.target.value);
              setPage(1);
            }}
          >
            <option value="">اختر الحساب…</option>
            {accounts.data?.accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.code} — {a.name}
              </option>
            ))}
          </select>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="gl-from">من تاريخ</Label>
          <Input
            id="gl-from"
            type="date"
            dir="ltr"
            value={from}
            onChange={(e) => {
              setFrom(e.target.value);
              setPage(1);
            }}
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="gl-to">إلى تاريخ</Label>
          <Input
            id="gl-to"
            type="date"
            dir="ltr"
            value={to}
            onChange={(e) => {
              setTo(e.target.value);
              setPage(1);
            }}
          />
        </div>

        {!user.branchId && branches.length > 1 && (
          <div className="space-y-1.5">
            <Label htmlFor="gl-branch">الفرع</Label>
            <select
              id="gl-branch"
              className={nativeFieldClassName}
              value={branchId}
              onChange={(e) => {
                setBranchId(e.target.value);
                setPage(1);
              }}
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
      </div>

      {!account && (
        <Panel>
          <EmptyState message="اختر حسابًا من القائمة أعلاه لعرض دفتر الأستاذ والحركة والرصيد الجاري." icon="📘" />
        </Panel>
      )}
      {accounts.error && (
        <div role="alert" className="workspace-state text-destructive">
          <p>{accounts.error}</p>
          <Button variant="outline" disabled={accounts.loading} onClick={accounts.reload}>
            إعادة تحميل الحسابات
          </Button>
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
      {loading && <LoadingState label="جارٍ تحميل حركة الحساب…" />}

      {data && (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard label="رصيد أول المدة" value={fmt(data.opening)} accent="slate" icon={<Scale className="size-5" />} />
            <StatCard label="مدين الفترة" value={fmt(data.totals.debit)} accent="emerald" icon={<ArrowUpDown className="size-5" />} />
            <StatCard label="دائن الفترة" value={fmt(data.totals.credit)} accent="amber" icon={<ArrowUpDown className="size-5" />} />
            <StatCard
              label="رصيد آخر المدة"
              value={fmt(data.totals.closing)}
              accent="blue"
              icon={<BookOpenCheck className="size-5" />}
            />
          </div>

          <Panel
            title={`${data.account.code} — ${data.account.name}`}
            bodyClassName="p-0"
            action={
              <span className="text-xs text-muted-foreground">
                الإجماليات على كامل السطور ({data.lineCount} سطر)
              </span>
            }
          >
            {data.lines.length === 0 ? (
              <div className="p-5">
                <EmptyState message="مفيش حركة مسجلة على الحساب ده في الفترة المحددة." icon="📄" />
              </div>
            ) : (
              <div className="overflow-x-auto">
                <Table className="workspace-table">
                  <TableHeader>
                    <TableRow>
                      <TableHead>التاريخ</TableHead>
                      <TableHead>القيد</TableHead>
                      <TableHead>البيان</TableHead>
                      <TableHead>المصدر</TableHead>
                      <TableHead className="text-end">مدين</TableHead>
                      <TableHead className="text-end">دائن</TableHead>
                      <TableHead className="text-end">الرصيد الجاري</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.lines.map((l, i) => (
                      <TableRow key={`${l.entryId}:${i}`}>
                        <TableCell dir="ltr" className="tabular-figures text-muted-foreground">
                          {l.entryDate}
                        </TableCell>
                        <TableCell>
                          <Link className="font-semibold text-primary underline underline-offset-2" href={`/accounting/journal/${l.entryId}`}>
                            #{l.number}
                          </Link>
                        </TableCell>
                        <TableCell dir="auto">
                          {l.description}
                          {l.memo ? <span className="text-muted-foreground"> — {l.memo}</span> : ""}
                        </TableCell>
                        <TableCell>
                          <span className="inline-flex items-center rounded-full border border-border bg-muted/40 px-2.5 py-0.5 text-xs font-medium text-foreground/80">
                            {SOURCE_LABELS[l.sourceType] ?? l.sourceType}
                          </span>
                        </TableCell>
                        <TableCell className="text-end tabular-figures font-medium text-sage-ink">
                          {l.debit ? fmt(l.debit) : ""}
                        </TableCell>
                        <TableCell className="text-end tabular-figures font-medium text-caramel-ink">
                          {l.credit ? fmt(l.credit) : ""}
                        </TableCell>
                        <TableCell className="text-end font-semibold tabular-figures">{fmt(l.balance)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </Panel>

          {pages > 1 && (
            <div className="flex items-center justify-between rounded-2xl border border-border bg-card px-4 py-2.5">
              <Button variant="outline" size="sm" disabled={page <= 1 || loading} onClick={() => setPage(page - 1)}>
                السابق
              </Button>
              <span className="text-sm text-muted-foreground">
                صفحة {page} من {pages}
              </span>
              <Button variant="outline" size="sm" disabled={page >= pages || loading} onClick={() => setPage(page + 1)}>
                التالي
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
