"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { CheckCircle2, FileSpreadsheet, Landmark, Scale, ShieldAlert } from "lucide-react";
import { useApp } from "@/components/app-shell";
import { useAccountingData } from "@/components/accounting/use-accounting-data";
import { ReportOutputActions } from "@/components/sales/report-output-actions";
import { EmptyState, LoadingState, Panel, StatCard } from "@/components/cafe/ui";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { nativeFieldClassName } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { dateStrInTz } from "@/lib/date-range";
import { money } from "@/lib/client";
import { cn } from "@/lib/utils";

const TITLES: Record<string, string> = {
  income: "قائمة الدخل",
  "balance-sheet": "الميزانية العمومية",
  "cash-flow": "التدفقات النقدية",
};

const LABELS: Record<string, string> = {
  revenue: "الإيرادات",
  costOfSales: "تكلفة المبيعات",
  expenses: "المصروفات",
  assets: "الأصول",
  liabilities: "الالتزامات",
  equity: "حقوق الملكية",
  flows: "التدفقات النقدية",
  netRevenue: "صافي الإيرادات",
  grossProfit: "مجمل الربح",
  otherExpenses: "المصروفات الأخرى",
  netIncome: "صافي الدخل",
  earningsToDate: "الأرباح حتى التاريخ",
  totalAssets: "إجمالي الأصول",
  totalLiabilities: "إجمالي الالتزامات",
  totalEquity: "إجمالي حقوق الملكية",
  opening: "رصيد البداية بالدفاتر",
  netChange: "صافي التغير",
  closing: "رصيد النهاية بالدفاتر",
  balanced: "اختبار التوازن",
};

type StatementLine = { code?: string; name?: string; label?: string; amount: number };
type StatementResult = {
  configured: boolean;
  branchId: string | null;
  branches: { id: string; name: string }[];
  kind: string;
  from: string;
  to: string;
  notice: string;
  outputSnapshot?: string;
  result?: Record<string, number | boolean | string | StatementLine[]>;
};

function StatementsContent() {
  const params = useSearchParams();
  const { user, cafe } = useApp();
  const currency = cafe?.currency ?? "EGP";
  const today = dateStrInTz(new Date());
  const initial = params.get("kind") ?? "income";

  const [kind, setKind] = useState(TITLES[initial] ? initial : "income");
  const [from, setFrom] = useState(`${today.slice(0, 7)}-01`);
  const [to, setTo] = useState(today);
  const [branch, setBranch] = useState(user.branchId ?? "");

  const allowed = !user.branchId || kind === "income";
  const valid = !!from && !!to && from <= to;

  const query = new URLSearchParams({
    kind,
    from,
    to,
    ...(branch ? { branchId: branch } : {}),
  });

  const { data, error, loading, reload } = useAccountingData<StatementResult>(
    allowed && valid ? `/api/accounting/statements?${query.toString()}` : null,
  );

  const ready =
    allowed &&
    valid &&
    !loading &&
    !error &&
    data &&
    data.kind === kind &&
    data.from === from &&
    data.to === to &&
    data.branchId === (branch || null);

  const scalarEntries = Object.entries(data?.result ?? {}).filter(
    ([, v]) => typeof v === "number" || typeof v === "boolean",
  );
  const sectionEntries = Object.entries(data?.result ?? {}).filter(([, v]) => Array.isArray(v));

  return (
    <div className="space-y-5">
      <div className="workspace-toolbar grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="space-y-1.5">
          <Label htmlFor="st-kind">نوع القائمة</Label>
          <select
            id="st-kind"
            className={nativeFieldClassName}
            value={kind}
            onChange={(e) => {
              setKind(e.target.value);
              if (e.target.value !== "income") setBranch(user.branchId ?? "");
            }}
          >
            {Object.entries(TITLES)
              .filter(([k]) => !user.branchId || k === "income")
              .map(([k, title]) => (
                <option key={k} value={k}>
                  {title}
                </option>
              ))}
          </select>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="st-branch">نطاق الفرع</Label>
          <select
            id="st-branch"
            className={nativeFieldClassName}
            value={branch}
            disabled={!!user.branchId || kind !== "income"}
            onChange={(e) => setBranch(e.target.value)}
          >
            <option value="">كل الكافيه</option>
            {data?.branches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="st-from">من تاريخ — القاهرة</Label>
          <input
            id="st-from"
            dir="ltr"
            type="date"
            className={nativeFieldClassName}
            value={from}
            disabled={kind === "balance-sheet"}
            onChange={(e) => setFrom(e.target.value)}
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="st-to">{kind === "balance-sheet" ? "المركز المالي حتى" : "إلى تاريخ — القاهرة"}</Label>
          <input
            id="st-to"
            dir="ltr"
            type="date"
            className={nativeFieldClassName}
            value={to}
            onChange={(e) => setTo(e.target.value)}
          />
        </div>
      </div>

      {!allowed && (
        <div role="alert" className="rounded-2xl border border-caramel-line bg-caramel-soft p-4 text-sm text-caramel-ink">
          هذا التقرير يحتاج صلاحية عرض على مستوى الكافيه بالكامل.
        </div>
      )}
      {!valid && (
        <div role="alert" className="rounded-2xl border border-clay-line bg-clay-soft p-4 text-sm text-clay-ink">
          أدخل فترة صحيحة بحيث لا يتجاوز تاريخ البداية تاريخ النهاية.
        </div>
      )}
      {loading && <LoadingState label="جارٍ إعداد القائمة المالية…" />}
      {error && (
        <div role="alert" className="workspace-state text-destructive">
          <p>{error}</p>
          <Button variant="outline" onClick={() => void reload()}>
            إعادة المحاولة
          </Button>
        </div>
      )}

      {ready && !data.configured && (
        <Panel title={TITLES[kind]}>
          <EmptyState
            icon="📒"
            message="لم تُجهّز دفاتر هذا الكافيه بعد. عرض القوائم لا ينشئ حسابات ولا أرصدة افتتاحية."
          />
        </Panel>
      )}

      {ready && data.configured && (
        <div className="space-y-5">
          <Panel
            title={TITLES[kind]}
            action={
              <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/50 px-3 py-1 text-xs font-medium text-muted-foreground">
                <Landmark className="size-3.5 text-primary" />
                <span>{kind === "balance-sheet" ? `حتى ${to}` : `${from} ← ${to}`}</span>
              </span>
            }
          >
            <ReportOutputActions
              endpoint="/api/accounting/statements/output"
              snapshot={data.outputSnapshot}
              disabled={loading || !!error}
            />
          </Panel>

          {scalarEntries.length > 0 && (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {scalarEntries.map(([key, val]) => {
                if (typeof val === "boolean") {
                  return (
                    <StatCard
                      key={key}
                      label={LABELS[key] ?? key}
                      value={val ? "متوازنة" : "غير متوازنة — للمراجعة"}
                      accent={val ? "emerald" : "red"}
                      icon={val ? <CheckCircle2 className="size-5" /> : <ShieldAlert className="size-5" />}
                    />
                  );
                }
                const num = val as number;
                const accent =
                  key === "netIncome" || key === "grossProfit" || key === "netChange"
                    ? num >= 0
                      ? "emerald"
                      : "red"
                    : key === "totalLiabilities"
                      ? "amber"
                      : "blue";
                return (
                  <StatCard
                    key={key}
                    label={LABELS[key] ?? key}
                    value={money(num, currency)}
                    accent={accent}
                    icon={key === "totalAssets" ? <Scale className="size-5" /> : <FileSpreadsheet className="size-5" />}
                  />
                );
              })}
            </div>
          )}

          <div className="grid gap-4 lg:grid-cols-2">
            {sectionEntries.map(([key, values]) => {
              const items = values as StatementLine[];
              return (
                <Panel
                  key={key}
                  title={LABELS[key] ?? key}
                  bodyClassName="p-0"
                  action={<span className="text-xs text-muted-foreground">{items.length} بند</span>}
                >
                  {items.length === 0 ? (
                    <div className="p-5">
                      <EmptyState message="لا توجد حركة مسجلة في هذا القسم." icon="📊" />
                    </div>
                  ) : (
                    <Table className="workspace-table">
                      <TableHeader>
                        <TableRow>
                          <TableHead>البند / الحساب</TableHead>
                          <TableHead className="text-end">القيمة</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {items.map((line, i) => (
                          <TableRow key={i}>
                            <TableCell>
                              <div className="flex items-center gap-2">
                                {line.code && (
                                  <span dir="ltr" className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground tabular-figures">
                                    {line.code}
                                  </span>
                                )}
                                <span className="font-medium text-foreground">{line.name ?? line.label}</span>
                              </div>
                            </TableCell>
                            <TableCell
                              className={cn(
                                "text-end font-semibold tabular-figures",
                                line.amount < 0 ? "text-clay-ink" : "text-foreground",
                              )}
                            >
                              {money(line.amount, currency)}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  )}
                </Panel>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

export default function StatementsPage() {
  return (
    <Suspense fallback={<LoadingState label="جارٍ تحميل القوائم المالية…" />}>
      <StatementsContent />
    </Suspense>
  );
}
