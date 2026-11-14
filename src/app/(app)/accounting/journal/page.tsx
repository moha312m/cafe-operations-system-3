"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { BookText, Filter, RotateCcw } from "lucide-react";
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

type BranchItem = { id: string; name: string };
type Journal = {
  page: number;
  pageSize: number;
  count: number;
  sourceTypes: { sourceType: string; count: number }[];
  entries: {
    id: string;
    number: number;
    entryDate: string;
    description: string;
    sourceType: string;
    reversalOfId: string | null;
    reversedBy: { id: string; number: number } | null;
    amount: number;
  }[];
};

export default function JournalPage() {
  const { cafe, user } = useApp();
  const currency = cafe?.currency ?? "EGP";
  const today = dateStrInTz(new Date());

  const [from, setFrom] = useState(`${today.slice(0, 7)}-01`);
  const [to, setTo] = useState(today);
  const [sourceType, setSourceType] = useState("");
  const [branchId, setBranchId] = useState(user.branchId ?? "");
  const [branches, setBranches] = useState<BranchItem[]>([]);
  const [page, setPage] = useState(1);

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
    page: String(page),
    ...(sourceType ? { sourceType } : {}),
    ...(!user.branchId && branchId ? { branchId } : {}),
  });

  const { data, error, loading, reload } = useAccountingData<Journal>(
    valid ? `/api/accounting/journal?${query.toString()}` : null,
  );
  const pages = data ? Math.max(1, Math.ceil(data.count / data.pageSize)) : 1;
  const reversedInPage = data?.entries.filter((e) => e.reversedBy || e.reversalOfId).length ?? 0;

  return (
    <div className="space-y-5">
      <div className="workspace-toolbar grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="space-y-1.5">
          <Label htmlFor="j-from">من تاريخ</Label>
          <Input
            id="j-from"
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
          <Label htmlFor="j-to">إلى تاريخ</Label>
          <Input
            id="j-to"
            type="date"
            dir="ltr"
            value={to}
            onChange={(e) => {
              setTo(e.target.value);
              setPage(1);
            }}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="j-source">نوع المصدر</Label>
          <select
            id="j-source"
            className={nativeFieldClassName}
            value={sourceType}
            onChange={(e) => {
              setSourceType(e.target.value);
              setPage(1);
            }}
          >
            <option value="">كل المصادر</option>
            {data?.sourceTypes.map((s) => (
              <option key={s.sourceType} value={s.sourceType}>
                {SOURCE_LABELS[s.sourceType] ?? s.sourceType} ({s.count})
              </option>
            ))}
          </select>
        </div>
        {!user.branchId && branches.length > 1 && (
          <div className="space-y-1.5">
            <Label htmlFor="j-branch">الفرع</Label>
            <select
              id="j-branch"
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
      {loading && <LoadingState label="جارٍ تحميل دفتر القيود…" />}

      {data && (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <StatCard label="إجمالي القيود في الفترة" value={data.count} accent="blue" icon={<BookText className="size-5" />} />
            <StatCard label="مصادر قيود مسجلة" value={data.sourceTypes.length} accent="emerald" icon={<Filter className="size-5" />} />
            <StatCard label="قيود عكس / معكوسة بالصفحة" value={reversedInPage} accent="amber" icon={<RotateCcw className="size-5" />} />
          </div>

          <Panel title="دفتر القيود اليومية" bodyClassName="p-0">
            {data.entries.length === 0 ? (
              <div className="p-5">
                <EmptyState message="لا توجد قيود يومية في هذه الفترة أو هذا المصدر." icon="📓" />
              </div>
            ) : (
              <div className="overflow-x-auto">
                <Table className="workspace-table">
                  <TableHeader>
                    <TableRow>
                      <TableHead>رقم القيد</TableHead>
                      <TableHead>التاريخ</TableHead>
                      <TableHead>البيان</TableHead>
                      <TableHead>المصدر</TableHead>
                      <TableHead className="text-end">القيمة</TableHead>
                      <TableHead>الحالة / العكس</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.entries.map((e) => (
                      <TableRow key={e.id}>
                        <TableCell>
                          <Link className="font-semibold text-primary underline underline-offset-2" href={`/accounting/journal/${e.id}`}>
                            #{e.number}
                          </Link>
                        </TableCell>
                        <TableCell dir="ltr" className="tabular-figures text-muted-foreground">
                          {e.entryDate}
                        </TableCell>
                        <TableCell dir="auto">{e.description}</TableCell>
                        <TableCell>
                          <span className="inline-flex items-center rounded-full border border-border bg-muted/40 px-2.5 py-0.5 text-xs font-medium text-foreground/80">
                            {SOURCE_LABELS[e.sourceType] ?? e.sourceType}
                          </span>
                        </TableCell>
                        <TableCell className="text-end font-semibold tabular-figures">{money(e.amount, currency)}</TableCell>
                        <TableCell>
                          {e.reversedBy ? (
                            <Link
                              href={`/accounting/journal/${e.reversedBy.id}`}
                              className="inline-flex items-center rounded-full border border-clay-line bg-clay-soft px-2.5 py-0.5 text-xs font-medium text-clay-ink hover:underline"
                            >
                              معكوس بالقيد #{e.reversedBy.number}
                            </Link>
                          ) : e.reversalOfId ? (
                            <span className="inline-flex items-center rounded-full border border-tide-line bg-tide-soft px-2.5 py-0.5 text-xs font-medium text-tide-ink">
                              قيد عكسي
                            </span>
                          ) : (
                            <span className="inline-flex items-center rounded-full border border-sage-line bg-sage-soft px-2.5 py-0.5 text-xs font-medium text-sage-ink">
                              ساري
                            </span>
                          )}
                        </TableCell>
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
