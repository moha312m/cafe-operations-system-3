"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { BookMarked, CheckCircle2, FileDown, Layers, Plus, Search, TriangleAlert } from "lucide-react";
import { EmptyState, LoadingState, Panel, StatCard } from "@/components/cafe/ui";
import { Button } from "@/components/ui/button";
import { Input, nativeFieldClassName } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useAccountingData } from "@/components/accounting/use-accounting-data";
import { AccountDialog, MappingDialog, type MappingTarget } from "@/components/accounting/chart-setup-dialogs";
import type { ChartRow, CodeState, MappingStatus } from "@/lib/accounting/chart-view";
import { cn } from "@/lib/utils";

type Saved = {
  id: string;
  effectiveFrom: string;
  accountId: string | null;
  accountCode: string | null;
  accountName: string | null;
  reason: string;
  approvalRef: string;
};

type Mapping = {
  header: { code: string; name: string; parentCode: string; codeState: CodeState };
  rows: {
    categoryId: string;
    categoryCode: string;
    categoryName: string;
    archived: boolean;
    status: MappingStatus;
    proposal: { key: string; code: string; name: string; scope: string; codeState: CodeState } | null;
    candidates: { code: string; name: string }[];
    saved: { current: Saved | null; ended: boolean; latestEffectiveFrom: string | null; history: Saved[] };
  }[];
  expenseAccounts: { id: string; code: string; name: string }[];
  proposalsWithoutCategory: { key: string; code: string; name: string; codeState: CodeState }[];
  summary: { categories: number; proposed: number; payrollPending: number; unmapped: number; conflicts: number; saved: number };
};

type Chart =
  | { configured: false; notice: string }
  | {
      configured: true;
      notice: string;
      entity: { name: string };
      query: string;
      total: number;
      matchCount: number;
      rows: ChartRow[];
      mapping: Mapping | null;
      mappingAllowed: boolean;
      canSetup: boolean;
      canExport: boolean;
    };

const TYPE_LABELS: Record<string, string> = {
  ASSET: "أصول",
  LIABILITY: "خصوم",
  EQUITY: "حقوق ملكية",
  REVENUE: "إيرادات",
  EXPENSE: "مصروفات",
};
const SIDE_LABELS: Record<string, string> = { DEBIT: "مدين", CREDIT: "دائن" };
const STATUS_LABELS: Record<MappingStatus, string> = {
  PROPOSED: "مقترح — للمراجعة",
  PAYROLL_PENDING: "الأجور — الاعتراف غير محسوم",
  AMBIGUOUS: "غير واضح — أكتر من احتمال",
  UNMAPPED: "غير مربوط — محتاج مراجعة",
};

function CodeStateText({ state, saved }: { state: CodeState; saved?: boolean }) {
  if (state.state === "taken" && saved) return <span className="text-sage-ink">الحساب موجود ومربوط</span>;
  if (state.state === "free") return <span className="text-muted-foreground">الكود غير مستخدم</span>;
  return (
    <span className="text-clay-ink">
      الكود مستخدم: {state.account.code} — {state.account.name}
      {state.account.isPostable ? "" : " (حساب رئيسي)"}
    </span>
  );
}

const mappingAlert = (status: MappingStatus) => status !== "PROPOSED";

function StatusBadges({ r }: { r: ChartRow }) {
  return (
    <span className="flex flex-wrap gap-1.5 text-xs">
      <span
        className={cn(
          "rounded-full border px-2.5 py-0.5 font-medium",
          r.isPostable ? "border-tide-line bg-tide-soft text-tide-ink" : "border-border bg-muted/60 text-foreground/80",
        )}
      >
        {r.isPostable ? "يقبل قيود" : "حساب رئيسي"}
      </span>
      <span
        className={cn(
          "rounded-full border px-2.5 py-0.5 font-medium",
          r.isActive ? "border-sage-line bg-sage-soft text-sage-ink" : "border-clay-line bg-clay-soft text-clay-ink",
        )}
      >
        {r.isActive ? "نشط" : "موقوف"}
      </span>
    </span>
  );
}

function EditButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="whitespace-nowrap font-medium text-primary underline underline-offset-2">
      تعديل
    </button>
  );
}

function LedgerLink({ r }: { r: ChartRow }) {
  return r.ledgerEligible ? (
    <Link className="whitespace-nowrap font-medium text-primary underline underline-offset-2" href={`/accounting/ledger?account=${encodeURIComponent(r.id)}`}>
      فتح الأستاذ
    </Link>
  ) : (
    <span className="text-muted-foreground">—</span>
  );
}

export default function ChartOfAccountsPage() {
  const [accountDialog, setAccountDialog] = useState<{ mode: "create" | "group" | "sub" | "edit"; account: ChartRow | null } | null>(null);
  const [exportScope, setExportScope] = useState<"full" | "filtered">("full");
  const [includeMapping, setIncludeMapping] = useState(false);
  const [exporting, setExporting] = useState("");
  const [exportError, setExportError] = useState("");
  const [mappingTarget, setMappingTarget] = useState<MappingTarget | null>(null);
  const [input, setInput] = useState("");
  const [q, setQ] = useState("");

  useEffect(() => {
    const timer = window.setTimeout(() => setQ(input.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [input]);

  const { data, error, loading, reload } = useAccountingData<Chart>(
    `/api/accounting/chart-of-accounts${q ? `?${new URLSearchParams({ q })}` : ""}`,
  );
  const ready = data && data.configured ? data : null;

  async function download(format: "xlsx" | "csv", dataset: "chart" | "mapping" = "chart") {
    if (!ready) return;
    const filtered = exportScope === "filtered" && !!ready.query;
    const params = new URLSearchParams({ format, scope: filtered ? "filtered" : "full", dataset });
    if (filtered) params.set("q", ready.query);
    if (format === "xlsx" && includeMapping) params.set("includeMapping", "1");
    setExporting(`${format}:${dataset}`);
    setExportError("");
    try {
      const response = await fetch(`/api/accounting/chart-of-accounts/export?${params}`);
      if (!response.ok) {
        throw new Error(((await response.json().catch(() => ({}))) as { error?: string }).error ?? `تعذر التصدير (${response.status})`);
      }
      const blob = await response.blob();
      const name = /filename="([^"]+)"/.exec(response.headers.get("Content-Disposition") ?? "")?.[1] ?? `chart-of-accounts.${format}`;
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = name;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (e) {
      setExportError(e instanceof Error ? e.message : "تعذر التصدير");
    } finally {
      setExporting("");
    }
  }

  const savedBlock = (m: Mapping["rows"][number]) => (
    <>
      {m.saved.current ? (
        <span>
          <span dir="ltr" className="tabular-figures font-medium">
            {m.saved.current.accountCode}
          </span>{" "}
          — {m.saved.current.accountName}
          <span className="block text-xs text-muted-foreground">ساري من {m.saved.current.effectiveFrom}</span>
        </span>
      ) : (
        <span className="text-muted-foreground">{m.saved.ended ? "منتهي" : "غير محفوظ"}</span>
      )}
      {m.saved.history.length > 0 && (
        <details className="mt-1 text-xs">
          <summary className="cursor-pointer text-primary">السجل ({m.saved.history.length})</summary>
          <ul className="mt-1 space-y-1">
            {m.saved.history.map((h) => (
              <li key={h.id}>
                <span dir="ltr">{h.effectiveFrom}</span> — {h.accountCode ? `${h.accountCode} ${h.accountName}` : "إنهاء الربط"}{" "}
                <span className="text-muted-foreground">
                  ({h.reason} / {h.approvalRef})
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
      {ready?.canSetup && (
        <button
          type="button"
          className="mt-1 block font-medium text-primary underline underline-offset-2"
          onClick={() =>
            setMappingTarget({
              categoryId: m.categoryId,
              categoryName: m.categoryName,
              categoryCode: m.categoryCode,
              latestEffectiveFrom: m.saved.latestEffectiveFrom,
              currentAccountId: m.saved.current?.accountId ?? null,
              suggestedCode: m.proposal?.code ?? null,
            })
          }
        >
          اعتماد الربط
        </button>
      )}
    </>
  );

  return (
    <div className="space-y-5">
      <div className="workspace-toolbar flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="coa-search">بحث بالكود أو الاسم</Label>
          <div className="relative">
            <Search className="pointer-events-none absolute top-3 right-3 size-4 text-muted-foreground" />
            <Input
              id="coa-search"
              type="search"
              className="w-80 max-w-full pe-9"
              placeholder="مثال: 1110 أو نقدية"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              maxLength={60}
            />
          </div>
        </div>
        {ready?.canSetup && (
          <Button onClick={() => setAccountDialog({ mode: "create", account: null })}>
            <Plus className="size-4" />
            <span>إضافة حساب</span>
          </Button>
        )}
      </div>

      {ready && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard label="إجمالي الحسابات بالدليل" value={ready.total} accent="blue" icon={<Layers className="size-5" />} />
          <StatCard
            label="حسابات تقبل القيود"
            value={ready.rows.filter((r) => r.isPostable && r.isActive).length}
            accent="emerald"
            icon={<BookMarked className="size-5" />}
            hint={ready.query ? `ضمن نتائج البحث (${ready.matchCount} مطابقة)` : undefined}
          />
          {ready.mapping && (
            <>
              <StatCard
                label="ربط مصروفات محفوظ وساري"
                value={`${ready.mapping.summary.saved} / ${ready.mapping.summary.categories}`}
                accent="emerald"
                icon={<CheckCircle2 className="size-5" />}
              />
              <StatCard
                label="تصنيفات غير مربوطة أو متعارضة"
                value={ready.mapping.summary.unmapped + ready.mapping.summary.conflicts}
                accent={ready.mapping.summary.unmapped + ready.mapping.summary.conflicts > 0 ? "amber" : "slate"}
                icon={<TriangleAlert className="size-5" />}
              />
            </>
          )}
        </div>
      )}

      {ready?.canExport && (
        <Panel
          title="تصدير دليل الحسابات"
          action={<FileDown className="size-4 text-muted-foreground" />}
        >
          <section className="flex flex-wrap items-end gap-3" aria-label="تصدير الدليل" data-testid="chart-export">
            <div className="space-y-1.5">
              <Label htmlFor="coa-export-scope">نطاق التصدير</Label>
              <select
                id="coa-export-scope"
                className={cn(nativeFieldClassName, "min-w-60")}
                value={ready.query ? exportScope : "full"}
                onChange={(e) => setExportScope(e.target.value as "full" | "filtered")}
              >
                <option value="full">الدليل كاملًا ({ready.total} حساب)</option>
                <option value="filtered" disabled={!ready.query}>
                  النتائج الحالية{ready.query ? ` (${ready.matchCount} نتيجة + سياقها)` : " — اكتب بحث أولًا"}
                </option>
              </select>
            </div>
            {ready.mappingAllowed && (
              <label className="flex items-center gap-2 rounded-xl border border-input bg-background px-3 py-2 text-sm">
                <input
                  type="checkbox"
                  className="size-4 accent-primary"
                  checked={includeMapping}
                  onChange={(e) => setIncludeMapping(e.target.checked)}
                />
                <span>ضم ورقة ربط التصنيفات في Excel</span>
              </label>
            )}
            <Button variant="outline" disabled={!!exporting} onClick={() => download("xlsx")}>
              {exporting === "xlsx:chart" ? "جارٍ التجهيز…" : "تصدير Excel"}
            </Button>
            <Button variant="outline" disabled={!!exporting} onClick={() => download("csv")}>
              {exporting === "csv:chart" ? "جارٍ التجهيز…" : "تصدير CSV"}
            </Button>
            {ready.mappingAllowed && (
              <Button variant="outline" disabled={!!exporting} onClick={() => download("csv", "mapping")}>
                {exporting === "csv:mapping" ? "جارٍ التجهيز…" : "CSV ربط التصنيفات"}
              </Button>
            )}
            <p className="w-full text-xs text-muted-foreground">
              للقراءة والتخطيط خارج النظام فقط. تعديل الملف لا يغيّر الدليل، ولا يوجد رفع أو استيراد تلقائي.
            </p>
            {exportError && (
              <p role="alert" className="w-full text-sm font-medium text-destructive">
                {exportError}
              </p>
            )}
          </section>
        </Panel>
      )}

      {error && (
        <div role="alert" className="workspace-state text-destructive">
          <p>{error}</p>
          <Button variant="outline" disabled={loading} onClick={reload}>
            {loading ? "جارٍ إعادة التحميل…" : "إعادة المحاولة"}
          </Button>
        </div>
      )}
      {loading && !data && <LoadingState label="جارٍ تحميل دليل الحسابات…" />}
      {data && !data.configured && (
        <Panel title="دليل الحسابات">
          <EmptyState message="الدفاتر لم تُجهّز بعد لهذا الكافيه، لذلك لا يوجد دليل حسابات للعرض." icon="🗂️" />
        </Panel>
      )}

      {ready && (
        <>
          <Panel
            title={`شجرة الحسابات (${ready.query ? `${ready.matchCount} من ${ready.total}` : ready.total})`}
            bodyClassName="p-0"
            action={
              <span className="text-xs text-muted-foreground">
                {ready.canSetup ? "التعديل لصاحب الكافيه فقط" : "عرض للقراءة فقط"}
              </span>
            }
          >
            {ready.rows.length === 0 ? (
              <div className="p-5">
                <EmptyState message="مفيش حساب بالكود أو الاسم ده." icon="🔍" />
              </div>
            ) : (
              <div className="overflow-x-auto" data-testid="chart-table">
                <Table className="workspace-table">
                  <TableHeader>
                    <TableRow>
                      <TableHead>الكود</TableHead>
                      <TableHead>الحساب</TableHead>
                      <TableHead className="hidden md:table-cell">النوع</TableHead>
                      <TableHead className="hidden 2xl:table-cell">الجانب الطبيعي</TableHead>
                      <TableHead className="hidden xl:table-cell">الحساب الأب</TableHead>
                      <TableHead className="hidden md:table-cell">الحالة</TableHead>
                      <TableHead className="hidden md:table-cell">الأستاذ والإجراء</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {ready.rows.map((r) => (
                      <TableRow key={r.id} className={r.isActive ? "" : "text-muted-foreground"} data-account-code={r.code}>
                        <TableCell dir="ltr" className={cn("tabular-figures", r.matched || !ready.query ? "font-semibold" : "text-muted-foreground")}>
                          {r.code}
                        </TableCell>
                        <TableCell style={{ paddingInlineStart: `${0.75 + r.depth * 1.25}rem` }} className={!r.isPostable ? "font-semibold text-foreground" : ""}>
                          {r.name}
                          {!r.matched && ready.query && <span className="ms-2 text-xs text-muted-foreground">(يضم نتيجة بحث)</span>}
                          <span className="mt-1 flex flex-wrap items-center gap-2 md:hidden">
                            <StatusBadges r={r} />
                            <LedgerLink r={r} />
                            {ready.canSetup && <EditButton onClick={() => setAccountDialog({ mode: "edit", account: r })} />}
                          </span>
                        </TableCell>
                        <TableCell className="hidden md:table-cell">{TYPE_LABELS[r.type] ?? r.type}</TableCell>
                        <TableCell className="hidden 2xl:table-cell">{SIDE_LABELS[r.normalBalance] ?? r.normalBalance}</TableCell>
                        <TableCell className="hidden xl:table-cell text-muted-foreground" dir="auto">
                          {r.parentCode ? `${r.parentCode} — ${r.parentName}` : "—"}
                        </TableCell>
                        <TableCell className="hidden md:table-cell">
                          <StatusBadges r={r} />
                        </TableCell>
                        <TableCell className="hidden md:table-cell">
                          <span className="flex items-center gap-3">
                            <LedgerLink r={r} />
                            {ready.canSetup && <EditButton onClick={() => setAccountDialog({ mode: "edit", account: r })} />}
                          </span>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </Panel>

          {ready.mappingAllowed && ready.mapping && (
            <Panel title="ربط تصنيفات المصروفات بحسابات الدفاتر" bodyClassName="space-y-4">
              <div className="rounded-xl border border-caramel-line bg-caramel-soft p-3 text-sm text-caramel-ink leading-relaxed" aria-labelledby="coa-mapping-title">
                <strong id="coa-mapping-title" className="font-semibold">ضبط ربط المصروفات:</strong> الربط المحفوظ يُسجَّل بتاريخ سريان ومرجع اعتماد المحاسب، ولا يعيد تصنيف القيود المرحّلة سابقًا. تفعيل الترحيل الآلي للمصروفات يظل موقوفًا حتى اعتماد السياسة المالية.
              </div>
              <p className="text-sm text-muted-foreground">
                {ready.mapping.summary.categories} تصنيف — {ready.mapping.summary.proposed} مقترح، {ready.mapping.summary.payrollPending} أجور غير محسومة،{" "}
                {ready.mapping.summary.unmapped} غير مربوط، {ready.mapping.summary.conflicts} تعارض في الكود، {ready.mapping.summary.saved} ربط محفوظ ساري. المجموعة المقترحة {ready.mapping.header.code} ({ready.mapping.header.name}):{" "}
                <CodeStateText state={ready.mapping.header.codeState} />.
              </p>

              {ready.mapping.rows.length === 0 ? (
                <EmptyState message="لا توجد تصنيفات مصروفات مسجلة حتى الآن." icon="🏷️" />
              ) : (
                <div className="overflow-x-auto rounded-xl border border-border" data-testid="mapping-table">
                  <Table className="workspace-table">
                    <TableHeader>
                      <TableRow>
                        <TableHead>تصنيف المصروف</TableHead>
                        <TableHead>الحساب المقترح</TableHead>
                        <TableHead className="hidden md:table-cell">الربط المحفوظ</TableHead>
                        <TableHead className="hidden xl:table-cell">الحالة</TableHead>
                        <TableHead className="hidden xl:table-cell">فحص الكود</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {ready.mapping.rows.map((m) => (
                        <TableRow key={m.categoryId} className={m.archived ? "text-muted-foreground" : ""}>
                          <TableCell>
                            <span className="font-medium">{m.categoryName}</span>{" "}
                            <span dir="ltr" className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                              {m.categoryCode}
                            </span>
                            {m.archived && <span className="ms-2 text-xs">(مؤرشف)</span>}
                            <span className={cn("mt-1 block text-xs xl:hidden", mappingAlert(m.status) && "text-caramel-ink")}>
                              {STATUS_LABELS[m.status]}
                            </span>
                            <div className="mt-2 text-sm md:hidden">{savedBlock(m)}</div>
                          </TableCell>
                          <TableCell>
                            {m.proposal ? (
                              <>
                                <span dir="ltr">{m.proposal.code}</span> — {m.proposal.name}
                              </>
                            ) : m.candidates.length ? (
                              m.candidates.map((c) => `${c.code} ${c.name}`).join(" / ")
                            ) : (
                              "—"
                            )}
                            {m.proposal && (
                              <span className="mt-1 block text-xs xl:hidden">
                                <CodeStateText state={m.proposal.codeState} saved={m.saved.current?.accountCode === m.proposal.code} />
                              </span>
                            )}
                          </TableCell>
                          <TableCell className="hidden md:table-cell">{savedBlock(m)}</TableCell>
                          <TableCell className={cn("hidden xl:table-cell font-medium", mappingAlert(m.status) ? "text-caramel-ink" : "text-sage-ink")}>
                            {STATUS_LABELS[m.status]}
                          </TableCell>
                          <TableCell className="hidden text-sm xl:table-cell">
                            {m.proposal ? <CodeStateText state={m.proposal.codeState} saved={m.saved.current?.accountCode === m.proposal.code} /> : "—"}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}

              {ready.mapping.proposalsWithoutCategory.length > 0 && (
                <p className="text-sm text-muted-foreground">
                  اقتراحات بدون تصنيف تشغيل حتى الآن: {ready.mapping.proposalsWithoutCategory.map((p) => `${p.code} ${p.name}`).join("، ")}.
                </p>
              )}
            </Panel>
          )}

          {!ready.mappingAllowed && (
            <p className="text-sm text-muted-foreground">مسودة ربط تصنيفات المصروفات تظهر لمن يملك صلاحية عرض المصاريف.</p>
          )}
        </>
      )}

      {accountDialog && ready && (
        <AccountDialog
          mode={accountDialog.mode}
          account={accountDialog.account}
          rows={ready.rows}
          onClose={() => setAccountDialog(null)}
          onSaved={reload}
        />
      )}
      {mappingTarget && ready?.mapping && (
        <MappingDialog
          target={mappingTarget}
          accounts={ready.mapping.expenseAccounts}
          onClose={() => setMappingTarget(null)}
          onSaved={reload}
        />
      )}
    </div>
  );
}
