"use client";
// «تقرير الاستلام والمسؤولية»: one payload, two tabs. The server decides every
// figure and every mask; this page only lays them out. «لم يُسجَّل» and «مخفي»
// are badges, never a zero.
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/client";
import { useApp } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { TONE_SURFACE, TONE_TOP, type Tone as Palette } from "@/components/ui/tone";
import { ROLE_LABELS } from "@/lib/permissions";
import { dateStrInTz } from "@/lib/date-range";
import type { AccountabilityReport, EmployeeSummary, IngredientLine, LedgerRow, Person, StatusChip, Tone } from "@/lib/reports/handover-accountability";
import {
  CASE_STATUS_LABELS, EXCEPTION_LABELS, HANDOVER_STATUS_LABELS, HIDDEN, MODE_LABELS, NOT_RECORDED, PERIOD_LABELS, PLACE_STATUS_LABELS,
  formatAmount, formatCount, formatDate, formatDateStr, formatMoney, formatQuantity, formatTime,
} from "@/lib/reports/handover-accountability-format";

type Options = { branches: { id: string; name: string }[]; employees: { id: string; name: string; active: boolean }[] };
type Response = AccountabilityReport & { options: Options };
type PeriodKey = keyof typeof PERIOD_LABELS;
type SortKey = "gross" | "cashShortage" | "stockShortage" | "name";

const TONE: Record<Tone, Palette | null> = { danger: "clay", warning: "caramel", success: "sage", info: "tide", neutral: null };
const LEDGER_PAGE = 50;

function Chip({ chip }: { chip: StatusChip }) {
  const palette = TONE[chip.tone];
  return <span className={`inline-flex items-center whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium ${palette ? TONE_SURFACE[palette] : "border-border bg-muted text-muted-foreground"}`}>{chip.label}</span>;
}
function Missing({ label }: { label: string }) {
  return <span className="inline-flex whitespace-nowrap rounded-full border border-dashed border-border px-2 py-0.5 text-xs text-muted-foreground">{label}</span>;
}
/** Money cell: null is «مخفي» when masked, otherwise «لم يُسجَّل». */
function Money({ value, hidden, tone }: { value: number | null; hidden?: boolean; tone?: "short" | "over" }) {
  if (hidden) return <Missing label={HIDDEN} />;
  if (value === null) return <Missing label={NOT_RECORDED} />;
  const color = tone === "short" && value > 0 ? "text-clay-ink font-semibold" : tone === "over" && value > 0 ? "text-caramel-ink font-semibold" : "";
  return <span className={`whitespace-nowrap ${color}`}>{formatAmount(value)}</span>;
}
const personName = (p: Person | null) => (p ? p.name : "—");
function Who({ p }: { p: Person | null }) {
  if (!p) return <span className="text-muted-foreground">—</span>;
  return <span className="whitespace-nowrap">{p.name}{!p.active && <span className="ms-1 text-xs text-muted-foreground">(غير نشط)</span>}</span>;
}

function Kpi({ label, value, tone, sub }: { label: string; value: string; tone?: Palette; sub?: string }) {
  return (
    <div className={`min-w-0 rounded-xl border bg-card p-3 ${tone ? TONE_TOP[tone] : ""}`}>
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className="mt-1 truncate text-xl font-bold tabular-figures">{value}</p>
      {sub && <p className="mt-0.5 text-xs text-muted-foreground">{sub}</p>}
    </div>
  );
}
function Dl({ title, items }: { title: string; items: [string, React.ReactNode][] }) {
  return (
    <div className="min-w-0 rounded-lg border bg-card p-3">
      <h4 className="mb-2 text-sm font-semibold">{title}</h4>
      <dl className="grid gap-1 text-sm">
        {items.map(([label, value]) => (
          <div key={label} className="flex items-baseline justify-between gap-3 border-b border-dashed border-border py-1 last:border-0">
            <dt className="text-muted-foreground">{label}</dt><dd className="text-end tabular-figures">{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

export default function HandoverAccountabilityPage() {
  const { canKey } = useApp();
  const mayView = canKey("reports.view") && canKey("shifts.view_reports");
  const mayExport = mayView && canKey("reports.export");
  const today = dateStrInTz(new Date());
  const [period, setPeriod] = useState<PeriodKey>("this_month");
  const [from, setFrom] = useState(today.slice(0, 8) + "01"), [to, setTo] = useState(today);
  const [branch, setBranch] = useState(""), [employee, setEmployee] = useState(""), [exceptionsOnly, setExceptionsOnly] = useState(false);
  const [tab, setTab] = useState<"employees" | "ledger">("employees");
  const [report, setReport] = useState<Response | null>(null), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const [options, setOptions] = useState<Options>({ branches: [], employees: [] });
  const [sort, setSort] = useState<SortKey>("gross"), [selected, setSelected] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set()), [shown, setShown] = useState(LEDGER_PAGE);
  const sequence = useRef(0);

  const query = useMemo(() => {
    const q = new URLSearchParams({ period });
    if (period === "custom") { q.set("from", from); q.set("to", to); }
    if (branch) q.set("branchId", branch);
    if (employee) q.set("employeeId", employee);
    if (exceptionsOnly) q.set("exceptionsOnly", "1");
    return q.toString();
  }, [period, from, to, branch, employee, exceptionsOnly]);

  const load = useCallback(async () => {
    if (!mayView) return;
    const request = ++sequence.current;
    setBusy(true); setError("");
    try {
      const result = await api<Response>(`/api/reports/handover-accountability?${query}`);
      if (request !== sequence.current) return;
      setReport(result); setOptions(result.options); setShown(LEDGER_PAGE); setExpanded(new Set());
    } catch (e) {
      if (request === sequence.current) { setReport(null); setError(e instanceof Error ? e.message : "تعذر تحميل التقرير"); }
    } finally {
      if (request === sequence.current) setBusy(false);
    }
  }, [mayView, query]);
  useEffect(() => { void load(); }, [load]);

  const employees = useMemo(() => {
    const rows = [...(report?.employees ?? [])];
    const by: Record<SortKey, (a: EmployeeSummary, b: EmployeeSummary) => number> = {
      gross: (a, b) => b.grossVariance - a.grossVariance,
      cashShortage: (a, b) => b.cash.shortage - a.cash.shortage,
      stockShortage: (a, b) => (b.stock.shortageValue ?? 0) - (a.stock.shortageValue ?? 0),
      name: (a, b) => a.employee.name.localeCompare(b.employee.name, "ar"),
    };
    return rows.sort((a, b) => by[sort](a, b) || a.employee.name.localeCompare(b.employee.name, "ar"));
  }, [report, sort]);

  if (!mayView) {
    return <div className="workspace-page"><div className="workspace-state" role="alert"><p className="text-lg font-semibold">ليس لديك صلاحية عرض هذا التقرير</p><p className="mt-1 text-muted-foreground">يحتاج التقرير صلاحيتي «عرض التقارير» و«تقارير الشيفتات».</p></div></div>;
  }

  const hide = report ? !report.visibility.ingredientValues : false;
  const k = report?.kpis;
  const exportUrl = (format: string, table?: string) => `/api/reports/handover-accountability/export?${query}&format=${format}${table ? `&table=${table}` : ""}`;
  const download = (url: string) => { const a = document.createElement("a"); a.href = url; a.rel = "noopener"; document.body.appendChild(a); a.click(); a.remove(); };
  const toggle = (id: string) => setExpanded((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const person = selected ? report?.employees.find((e) => e.employee.id === selected) ?? null : null;
  const sortHeader = (key: SortKey, label: string) => (
    <th aria-sort={sort === key ? "descending" : "none"}>
      <button type="button" className="inline-flex items-center gap-1 font-semibold hover:underline" onClick={() => setSort(key)}>{label}{sort === key && <span aria-hidden>▼</span>}</button>
    </th>
  );

  return (
    <div className="workspace-page min-w-0">
      <header className="workspace-header">
        <h1>تقرير الاستلام والمسؤولية</h1>
        <p className="mt-1 text-muted-foreground">العجز والزيادة لكل موظف في النقدية والخامات، وسجل كل تسليم واستلام — بتوقيت القاهرة.</p>
      </header>

      <form className="report-dense workspace-toolbar" onSubmit={(e) => { e.preventDefault(); void load(); }}>
        <label className="grid min-w-0 gap-1 text-sm"><span>الفترة</span>
          <select value={period} onChange={(e) => setPeriod(e.target.value as PeriodKey)} className="h-11 w-full min-w-0 rounded-lg border bg-background px-2">
            {(Object.keys(PERIOD_LABELS) as PeriodKey[]).map((key) => <option key={key} value={key}>{PERIOD_LABELS[key]}</option>)}
          </select>
        </label>
        {period === "custom" && <>
          <label className="grid min-w-0 gap-1 text-sm"><span>من</span><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
          <label className="grid min-w-0 gap-1 text-sm"><span>إلى</span><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        </>}
        <label className="grid min-w-0 gap-1 text-sm"><span>الفرع</span>
          <select value={branch} onChange={(e) => setBranch(e.target.value)} className="h-11 w-full min-w-0 rounded-lg border bg-background px-2">
            <option value="">كل الفروع المسموح بها</option>
            {options.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        </label>
        <label className="grid min-w-0 gap-1 text-sm"><span>الموظف</span>
          <select value={employee} onChange={(e) => setEmployee(e.target.value)} className="h-11 w-full min-w-0 rounded-lg border bg-background px-2">
            <option value="">كل الموظفين</option>
            {options.employees.map((p) => <option key={p.id} value={p.id}>{p.name}{p.active ? "" : " (غير نشط)"}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-2 self-end text-sm" style={{ flex: "0 0 auto" }}>
          <input type="checkbox" checked={exceptionsOnly} onChange={(e) => setExceptionsOnly(e.target.checked)} className="size-4" />الاستثناءات فقط
        </label>
        <div className="flex min-w-0 flex-wrap items-end gap-2" style={{ flex: "1 1 auto" }}>
          <Button type="submit" disabled={busy}>تحديث</Button>
          {mayExport && <>
            <Button type="button" variant="outline" disabled={!report || busy} onClick={() => download(exportUrl("xlsx"))}>تصدير Excel</Button>
            <Button type="button" variant="outline" disabled={!report || busy} onClick={() => download(exportUrl("csv", tab))}>CSV</Button>
            <Button type="button" variant="outline" disabled={!report || busy} onClick={() => window.open(`/reports/accountability/print?${query}`, "_blank", "noopener")}>طباعة</Button>
          </>}
        </div>
      </form>

      {error && <div role="alert" className={`rounded-xl border p-4 ${TONE_SURFACE.clay}`}><p className="font-semibold">تعذر تحميل التقرير</p><p className="text-sm">{error}</p><Button className="mt-2" variant="outline" onClick={() => void load()}>إعادة المحاولة</Button></div>}
      {busy && !report && <div className="workspace-state" aria-live="polite">جار تحميل التقرير…</div>}

      {report && k && <>
        <p className="text-sm text-muted-foreground" aria-live="polite">
          {report.period.label}: {formatDateStr(report.period.from)} — {formatDateStr(report.period.to)} · {report.branch?.name ?? "كل الفروع المسموح بها"}
          {report.employeeFilter ? ` · ${report.employeeFilter.name}` : ""} · {report.period.dayBasis}{busy ? " · جار التحديث…" : ""}
        </p>

        <section aria-label="المؤشرات" className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          <Kpi label="عجز نقدي" value={formatMoney(k.cashShortage, report.currency)} tone="clay" sub={`صافي ${formatAmount(k.cashNet)}`} />
          <Kpi label="زيادة نقدية" value={formatMoney(k.cashOverage, report.currency)} tone="caramel" sub={`${formatCount(k.matched)} إقفال مطابق من ${formatCount(k.closes)}`} />
          <Kpi label="عجز خامات" value={k.ingredientShortage === null ? HIDDEN : formatMoney(k.ingredientShortage, report.currency)} tone="clay" sub={k.ingredientUnpriced ? `${formatCount(k.ingredientUnpriced)} فرق بلا تكلفة` : "بتكلفة وقت العدّ"} />
          <Kpi label="زيادة خامات" value={k.ingredientOverage === null ? HIDDEN : formatMoney(k.ingredientOverage, report.currency)} tone="caramel" sub={k.ingredientNet === null ? undefined : `صافي ${formatAmount(k.ingredientNet)}`} />
          <Kpi label="فرق مشترك غير منسوب" value={formatCount(k.sharedCount)} tone="caramel"
            sub={`خامات: عجز ${k.sharedStockShortage === null ? HIDDEN : formatAmount(k.sharedStockShortage)} · زيادة ${k.sharedStockOverage === null ? HIDDEN : formatAmount(k.sharedStockOverage)} — نقدية: عجز ${formatAmount(k.sharedCashShortage)} · زيادة ${formatAmount(k.sharedCashOverage)}`} />
          <Kpi label="فتح بدون استلام مسجل" value={formatCount(k.openingsWithoutReceipt)} tone={k.openingsWithoutReceipt ? "clay" : "sage"} />
          <Kpi label="إقفال بدون عدّ" value={formatCount(k.closesWithoutCount)} tone={k.closesWithoutCount ? "clay" : "sage"} />
          <Kpi label="توريد بانتظار التأكيد" value={formatCount(k.pendingDeliveries)} tone={k.staleDeliveries ? "clay" : k.pendingDeliveries ? "caramel" : "sage"} sub={k.staleDeliveries ? `${formatCount(k.staleDeliveries)} أقدم من 24 ساعة` : undefined} />
          <Kpi label="نزاعات ومشاكل مفتوحة" value={formatCount(k.openDisputes + k.openIssues)} tone={k.openDisputes + k.openIssues ? "clay" : "sage"} sub={`${formatCount(k.openDisputes)} نزاع · ${formatCount(k.openIssues)} مشكلة`} />
          <Kpi label="تسليمات" value={formatCount(k.handovers)} tone="tide" sub={k.stockNotCounted ? `${formatCount(k.stockNotCounted)} بخامات لم تُعدّ` : undefined} />
        </section>

        <div role="tablist" aria-label="أقسام التقرير" className="workspace-tabs">
          {([["employees", "ملخص الفترة حسب الموظف"], ["ledger", "سجل الاستلامات"]] as const).map(([key, label]) => (
            <button key={key} type="button" role="tab" id={`tab-${key}`} aria-controls={`panel-${key}`} aria-selected={tab === key}
              className={tab === key ? "bg-primary text-primary-foreground font-semibold" : "bg-muted"} onClick={() => setTab(key)}>
              {label}{key === "ledger" ? ` (${formatCount(report.ledger.length)})` : ` (${formatCount(report.employees.length)})`}
            </button>
          ))}
        </div>

        {tab === "employees" && <section role="tabpanel" id="panel-employees" aria-labelledby="tab-employees">
          {employees.length === 0 ? <div className="workspace-state">لا توجد استلامات في هذه الفترة</div> : (
            <div className="workspace-surface max-h-[70vh] overflow-auto">
              <table className="workspace-table text-sm [&_td]:px-3 [&_td]:py-2.5 [&_th]:px-3 [&_th]:py-2.5">
                <thead className="sticky top-0 z-10">
                  <tr>
                    {sortHeader("name", "الموظف")}
                    <th>شيفتات / استلامات</th>
                    {sortHeader("cashShortage", "عجز نقدي")}
                    <th>زيادة نقدية</th><th>صافي النقدية</th><th>توريد معلّق / نزاع</th>
                    {sortHeader("stockShortage", "عجز خامات")}
                    <th>زيادة خامات</th><th>صافي الخامات</th>
                    <th>فرق مشترك (كامل)</th>
                    {sortHeader("gross", "إجمالي الفروق")}
                    <th>تنبيهات</th>
                  </tr>
                </thead>
                <tbody>
                  {employees.map((e) => (
                    <tr key={e.employee.id} className="cursor-pointer" tabIndex={0} aria-label={`تفاصيل ${e.employee.name}`}
                      onClick={() => setSelected(e.employee.id)} onKeyDown={(ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); setSelected(e.employee.id); } }}>
                      <td><div className="font-semibold"><Who p={e.employee} /></div><div className="text-xs text-muted-foreground">{ROLE_LABELS[e.employee.role]}</div></td>
                      <td className="whitespace-nowrap">{formatCount(e.shiftsClosed)} / {formatCount(e.handoversReceived)}{e.cash.notCounted ? <div className="text-xs text-clay-ink">{formatCount(e.cash.notCounted)} بدون عدّ</div> : null}</td>
                      <td><Money value={e.cash.shortage} tone="short" /></td>
                      <td><Money value={e.cash.overage} tone="over" /></td>
                      <td><Money value={e.cash.net} /></td>
                      <td className="whitespace-nowrap">{e.deliveries.pending || e.deliveries.disputed ? <><Money value={e.deliveries.pending} /> / <Money value={e.deliveries.disputed} tone="short" /></> : <span className="text-muted-foreground">—</span>}</td>
                      <td><Money value={e.stock.shortageValue} hidden={hide} tone="short" />{e.stock.unpriced ? <div className="text-xs text-muted-foreground">{formatCount(e.stock.unpriced)} بلا تكلفة</div> : null}</td>
                      <td><Money value={e.stock.overageValue} hidden={hide} tone="over" /></td>
                      <td><Money value={e.stock.net} hidden={hide} /></td>
                      <td className="whitespace-nowrap">{e.shared.count ? <>{formatCount(e.shared.count)} · {hide ? HIDDEN : formatAmount(e.shared.stockValue ?? 0)}{e.shared.cashAmount ? ` · نقدية ${formatAmount(e.shared.cashAmount)}` : ""}</> : <span className="text-muted-foreground">—</span>}</td>
                      <td className="font-semibold">{formatAmount(e.grossVariance)}</td>
                      <td><div className="flex flex-wrap gap-1">{e.flags.map((f) => <Chip key={f.code} chip={f} />)}</div></td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="sticky bottom-0 bg-muted font-bold">
                  <tr>
                    <td>الإجمالي</td>
                    <td>{formatCount(report.employeeTotals.shiftsClosed)} / {formatCount(report.employeeTotals.handoversReceived)}</td>
                    <td><Money value={report.employeeTotals.cash.shortage} tone="short" /></td>
                    <td><Money value={report.employeeTotals.cash.overage} tone="over" /></td>
                    <td><Money value={report.employeeTotals.cash.net} /></td>
                    <td><Money value={report.employeeTotals.deliveries.pending} /> / <Money value={report.employeeTotals.deliveries.disputed} /></td>
                    <td><Money value={report.employeeTotals.stock.shortageValue} hidden={hide} tone="short" /></td>
                    <td><Money value={report.employeeTotals.stock.overageValue} hidden={hide} tone="over" /></td>
                    <td><Money value={report.employeeTotals.stock.net} hidden={hide} /></td>
                    <td>{formatCount(k.sharedCount)}</td>
                    <td>{formatAmount(report.employeeTotals.grossVariance)}</td>
                    <td />
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
          <p className="mt-2 text-xs text-muted-foreground">الفرق المشترك يظهر كاملًا عند كل شخص مشارك ولا يُقسَّم، لذلك لا يُجمع في الإجمالي. اضغط على أي صف لعرض تسليمات الموظف وفروق خاماته.</p>
        </section>}

        {tab === "ledger" && <section role="tabpanel" id="panel-ledger" aria-labelledby="tab-ledger">
          {report.ledger.length === 0 ? <div className="workspace-state">لا توجد استلامات في هذه الفترة</div> : <>
            <div className="workspace-surface max-h-[70vh] overflow-auto">
              <table className="workspace-table text-sm [&_td]:px-3 [&_td]:py-2.5 [&_th]:px-3 [&_th]:py-2.5">
                <thead className="sticky top-0 z-10">
                  <tr><th>التاريخ</th><th>الفرع / الشيفت</th><th>المُسلِّم ← المستلم</th><th>الطريقة</th><th>المتوقع</th><th>المعدود</th><th>الفرق</th><th>الخامات</th><th>الحالة</th><th><span className="sr-only">التفاصيل</span></th></tr>
                </thead>
                <tbody>
                  {report.ledger.slice(0, shown).map((r) => <LedgerLine key={r.id} row={r} hide={hide} open={expanded.has(r.id)} onToggle={() => toggle(r.id)} lines={report.ingredients.filter((l) => l.handoverId && l.handoverId === r.handoverId)} />)}
                </tbody>
                <tfoot className="sticky bottom-0 bg-muted font-bold">
                  <tr>
                    <td colSpan={4}>الإجمالي ({formatCount(report.ledgerTotals.rows)} صف)</td>
                    <td><Money value={report.ledgerTotals.expected} /></td>
                    <td><Money value={report.ledgerTotals.counted} /></td>
                    <td className="whitespace-nowrap"><span className="text-clay-ink">عجز {formatAmount(report.ledgerTotals.shortage)}</span> · <span className="text-caramel-ink">زيادة {formatAmount(report.ledgerTotals.overage)}</span></td>
                    <td>{hide ? HIDDEN : `${formatAmount(report.ledgerTotals.stockShortage ?? 0)} عجز`}</td>
                    <td colSpan={2} />
                  </tr>
                </tfoot>
              </table>
            </div>
            {shown < report.ledger.length && <Button className="mt-3" variant="outline" onClick={() => setShown((n) => n + LEDGER_PAGE)}>عرض {formatCount(Math.min(LEDGER_PAGE, report.ledger.length - shown))} صف آخر</Button>}
            <p className="mt-2 text-xs text-muted-foreground">المتوقع والمعدود يُجمعان للإقفالات المعدودة فقط؛ الإقفال بدون عدّ يظهر كاستثناء ولا يُحسب صفرًا.</p>
          </>}
        </section>}

        {report.exceptions.length > 0 && <section aria-labelledby="exceptions-title" className="workspace-surface p-4">
          <h2 id="exceptions-title" className="mb-3 text-xl font-semibold">الاستثناءات ({formatCount(report.exceptions.length)})</h2>
          <ul className="grid gap-2">
            {report.exceptions.slice(0, 30).map((x) => (
              <li key={x.id} className={`flex flex-wrap items-baseline justify-between gap-2 rounded-lg border p-2 text-sm ${x.stale ? TONE_SURFACE.clay : ""}`}>
                <span className="font-semibold">{EXCEPTION_LABELS[x.kind]}</span>
                <span className="text-muted-foreground">{x.branch.name}{x.shiftNumber !== null ? ` · شيفت #${x.shiftNumber}` : ""} · {x.people.map((p) => p.name).join("، ") || "—"}</span>
                <span className="tabular-figures">{x.amount !== null ? formatMoney(x.amount, report.currency) + " · " : ""}{formatDate(x.at)} {formatTime(x.at)}{x.stale ? " · أقدم من 24 ساعة" : ""}</span>
                {x.note && <span className="basis-full text-muted-foreground">{x.note}</span>}
              </li>
            ))}
          </ul>
          {report.exceptions.length > 30 && <p className="mt-2 text-sm text-muted-foreground">والباقي في ملف Excel، ورقة «الاستثناءات».</p>}
        </section>}
      </>}

      <Dialog open={!!person} onOpenChange={(open) => { if (!open) setSelected(null); }}>
        <DialogContent className="top-0 left-0 h-dvh max-h-dvh w-full max-w-[min(100%,44rem)] translate-x-0 translate-y-0 rounded-none sm:max-w-[min(100%,44rem)]">
          {person && report && <EmployeeDetail summary={person} report={report} hide={hide} />}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function LedgerLine({ row, hide, open, onToggle, lines }: { row: LedgerRow; hide: boolean; open: boolean; onToggle: () => void; lines: IngredientLine[] }) {
  const c = row.cash, opening = row.kind === "OPENING";
  const detailId = `detail-${row.id}`;
  return (
    <Fragment>
      <tr className={row.exception ? "" : "text-foreground/90"}>
        <td className="whitespace-nowrap">{formatDate(row.at)}<div className="text-xs text-muted-foreground">{formatTime(row.at)}</div></td>
        <td className="whitespace-nowrap">{row.branch.name}<div className="text-xs text-muted-foreground">شيفت #{row.shift.number} · {opening ? "فتح" : "إقفال"}</div></td>
        <td className="whitespace-nowrap"><Who p={row.outgoing} /> <span aria-hidden className="text-muted-foreground">←</span> <Who p={row.incoming} /></td>
        <td className="whitespace-nowrap">{row.mode ? MODE_LABELS[row.mode] : "—"}</td>
        <td>{opening ? "—" : <Money value={c.expected} />}</td>
        <td>{opening ? "—" : <Money value={c.counted} />}</td>
        <td>{opening ? "—" : c.variance === null ? <Missing label={NOT_RECORDED} /> : <Money value={c.variance} tone={c.variance < 0 ? "short" : "over"} />}</td>
        <td className="whitespace-nowrap">{row.stock.items ? <>{formatCount(row.stock.items)} صنف{!hide && row.stock.shortageValue ? <div className="text-xs text-clay-ink">عجز {formatAmount(row.stock.shortageValue)}</div> : null}</> : row.stock.notCounted ? <Missing label="لم تُعدّ" /> : "—"}</td>
        <td><div className="flex flex-wrap gap-1">{row.statuses.map((s) => <Chip key={s.code} chip={s} />)}</div></td>
        <td><Button type="button" variant="ghost" size="sm" aria-expanded={open} aria-controls={detailId} onClick={onToggle}>{open ? "إخفاء" : "التفاصيل"}</Button></td>
      </tr>
      {open && (
        <tr id={detailId}>
          <td colSpan={10} className="bg-muted/40">
            {/* Sticky and capped, so the details stay in view while a wide table scrolls sideways. */}
            <div className="sticky start-0 grid max-w-[min(52rem,calc(100vw_-_3rem))] gap-3 md:grid-cols-3">
              <Dl title="النقدية" items={opening ? [["الحالة", "فُتح الشيفت بدون استلام مسجل"], ["ملاحظة", row.note ?? "—"]] : [
                ["المتوقع (من الإقفال)", <Money key="e" value={c.expected} />],
                ["المعدود", <Money key="c" value={c.counted} />],
                ["الفرق", c.variance === null ? <Missing key="v" label={NOT_RECORDED} /> : <Money key="v" value={c.variance} />],
                ["سبب الفرق", c.reason ?? "—"],
                ["باقٍ في الدرج", c.retained === null ? (row.mode === "DIRECT" ? <Missing key="r" label={NOT_RECORDED} /> : "—") : formatAmount(c.retained)],
                ["مُورَّد", c.delivered === null ? "—" : formatAmount(c.delivered)],
                ["توريد مؤكد", formatAmount(c.deliveries.confirmed)],
                ["بانتظار التأكيد", formatAmount(c.deliveries.pending)],
                ["متنازع عليه", formatAmount(c.deliveries.disputed)],
                ["عجز توريد بعد الحل (منفصل)", formatAmount(c.deliveries.resolvedShortfall)],
                ["فرق عند الاستلام (مشترك)", c.receiving === null ? "—" : formatAmount(c.receiving)],
              ]} />
              <Dl title="الخامات" items={[
                ["أصناف بفرق", formatCount(row.stock.items)],
                ["عجز خامات", hide ? HIDDEN : row.stock.shortageValue === null ? NOT_RECORDED : formatAmount(row.stock.shortageValue)],
                ["زيادة خامات", hide ? HIDDEN : row.stock.overageValue === null ? NOT_RECORDED : formatAmount(row.stock.overageValue)],
                ["فروق بلا تكلفة", formatCount(row.stock.unpriced)],
                ["أصناف لم تُعدّ (الفرق غير معروف)", formatCount(row.stock.notCounted)],
                ...lines.slice(0, 8).map((l): [string, React.ReactNode] => [l.item.name, `${l.difference === null ? NOT_RECORDED : formatQuantity(l.difference, l.unit)}${!hide && l.value !== null ? ` · ${formatAmount(l.value)}` : ""}`]),
              ]} />
              <Dl title="المكان والتسليم" items={[
                ["حالة التسليم", row.handoverStatus ? HANDOVER_STATUS_LABELS[row.handoverStatus] ?? row.handoverStatus : "—"],
                ["استلام المكان", row.place ? PLACE_STATUS_LABELS[row.place.status] ?? row.place.status : NOT_RECORDED],
                ["أعطال مرصودة", formatCount(row.place?.faults ?? 0)],
                ["بلاغات أعطال مفتوحة", formatCount(row.place?.openIncidents ?? 0)],
                ["مشاكل مفتوحة", formatCount(row.issues.open)],
                ["مشاكل محلولة", formatCount(row.issues.resolved)],
              ]} />
            </div>
          </td>
        </tr>
      )}
    </Fragment>
  );
}

function EmployeeDetail({ summary: e, report, hide }: { summary: EmployeeSummary; report: AccountabilityReport; hide: boolean }) {
  const id = e.employee.id;
  const rows = report.ledger.filter((r) => r.outgoing?.id === id || r.incoming?.id === id);
  const lines = report.ingredients.filter((l) => l.employee?.id === id || l.participants.some((p) => p.id === id));
  return (
    <>
      <DialogHeader>
        <DialogTitle className="text-xl">{e.employee.name}{!e.employee.active && <span className="ms-2 text-sm text-muted-foreground">(غير نشط)</span>}</DialogTitle>
        <DialogDescription>{ROLE_LABELS[e.employee.role]} · {formatDateStr(report.period.from)} — {formatDateStr(report.period.to)}</DialogDescription>
      </DialogHeader>
      <div className="grid grid-cols-2 gap-2">
        <Kpi label="عجز نقدي" value={formatMoney(e.cash.shortage, report.currency)} tone="clay" />
        <Kpi label="زيادة نقدية" value={formatMoney(e.cash.overage, report.currency)} tone="caramel" />
        <Kpi label="عجز خامات" value={hide ? HIDDEN : formatMoney(e.stock.shortageValue ?? 0, report.currency)} tone="clay" />
        <Kpi label="زيادة خامات" value={hide ? HIDDEN : formatMoney(e.stock.overageValue ?? 0, report.currency)} tone="caramel" />
      </div>
      <section>
        <h3 className="mb-2 font-semibold">التسليمات ({formatCount(rows.length)})</h3>
        {rows.length === 0 ? <p className="text-sm text-muted-foreground">لا توجد تسليمات.</p> : (
          <ul className="grid gap-2">
            {rows.map((r) => (
              <li key={r.id} className="rounded-lg border p-2 text-sm">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-semibold">{formatDate(r.at)} {formatTime(r.at)} · شيفت #{r.shift.number}</span>
                  <span className="text-muted-foreground">{r.outgoing?.id === id ? `سلّم إلى ${personName(r.incoming)}` : `استلم من ${personName(r.outgoing)}`}</span>
                </div>
                <div className="mt-1 flex flex-wrap gap-1">{r.statuses.map((s) => <Chip key={s.code} chip={s} />)}</div>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section>
        <h3 className="mb-2 font-semibold">فروق الخامات ({formatCount(lines.length)})</h3>
        {lines.length === 0 ? <p className="text-sm text-muted-foreground">لا توجد فروق خامات.</p> : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-muted-foreground [&>th]:whitespace-nowrap"><th className="p-1 text-start">الصنف</th><th className="p-1 text-start">الفرق</th><th className="p-1 text-start">القيمة</th><th className="p-1 text-start">النسبة</th></tr></thead>
              <tbody>
                {lines.map((l) => (
                  <tr key={l.id} className="border-t">
                    <td className="p-1">{l.item.name}<div className="text-xs text-muted-foreground">{formatDate(l.at)} · {CASE_STATUS_LABELS[l.caseStatus] ?? l.caseStatus}</div></td>
                    <td className="p-1 whitespace-nowrap">{l.difference === null ? <Missing label={NOT_RECORDED} /> : formatQuantity(l.difference, l.unit)}</td>
                    <td className="p-1 whitespace-nowrap">{hide ? <Missing label={HIDDEN} /> : !l.priced ? <Missing label={NOT_RECORDED} /> : formatAmount(l.value ?? 0)}</td>
                    <td className="p-1 text-xs">{l.employee ? "منسوب له" : <>مشترك غير منسوب<div className="text-muted-foreground">{l.participants.map((p) => p.name).join("، ") || "عهدة الفرع"}{l.shifts.length ? ` · ${l.shifts.map((n) => "#" + n).join("، ")}` : ""}</div></>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
