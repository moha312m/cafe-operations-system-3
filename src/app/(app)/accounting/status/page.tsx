"use client";

import { useState } from "react";
import {
  BookCheck,
  CalendarPlus,
  CheckCircle2,
  ClipboardCheck,
  Lock,
  PackageCheck,
  Scale,
  ShieldAlert,
  Truck,
  Wallet,
} from "lucide-react";
import { toast } from "sonner";
import { useApp } from "@/components/app-shell";
import { useAccountingData } from "@/components/accounting/use-accounting-data";
import { ISSUE_LABELS, statusLabel } from "@/components/accounting/accounting-shell";
import { EmptyState, LoadingState, Panel, StatCard } from "@/components/cafe/ui";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, money } from "@/lib/client";
import { dateStrInTz } from "@/lib/date-range";
import { formatTime } from "@/lib/i18n";
import { cn } from "@/lib/utils";

type ChecklistItem = { key: string; label: string; status: "ok" | "warning" | "blocking"; detail: string };
type Overview =
  | { configured: false; notice: string }
  | {
      configured: true;
      notice: string;
      mode: "SHADOW";
      entity: { name: string; currency: string; accounts: number };
      branchScope: string | null;
      periods: { id: string; startsOn: string; endsOn: string; status: string }[];
      currentPeriod: { id: string; startsOn: string; endsOn: string; status: string } | null;
      lastProjection: {
        at: string;
        windowFrom: string;
        windowTo: string;
        posted: number;
        replayed: number;
        issues: number;
      } | null;
      journal: { entries: number; lastEntryDate: string | null };
      openingBalances: { posted: boolean; date: string | null };
      issues: {
        byKind: Record<string, number>;
        open: { kind: string; severity: string; sourceKey: string; sourceType: string; reason: string; eventAt: string }[];
      };
      checklist: { canClose: boolean; checkedAt: string; items: ChecklistItem[] } | null;
    };

type PeriodsPayload = {
  configured: boolean;
  periods: {
    id: string;
    startsOn: string;
    endsOn: string;
    status: string;
    closedAt: string | null;
    closedBy: string | null;
    entriesCount: number;
  }[];
};

type ReconciliationPayload = {
  asOf: string;
  branchScope: string | null;
  inventory: {
    glInventory: number;
    ledgerValue: number;
    unposted: number;
    uncostedRows: number;
    currentValuation: number;
    revaluation: number;
  };
  suppliers: {
    payable: number;
    glPayable: number;
    payableDiff: number;
    advanceTotal: number;
    glAdvances: number;
    advanceDiff: number;
    byBucket: Record<string, number>;
  };
  bridge: {
    expenseCategories: { totalActive: number; mappedToday: number; unmappedActive: number };
    unpostedOperations: { operatingExpenses: number; operatingExpenseReturns: number; treasuryMovements: number };
    tenderReconciliations: { total: number; draftCount: number; submittedCount: number; totalVariance: number };
    inventoryCutover: { totalActiveItems: number; zeroStockItems: number; positiveStockItems: number };
    controlBalances: {
      cashDrawer: number;
      cashSafe: number;
      bank: number;
      cardClearing: number;
      cashOverShort: number;
      accountsPayable: number;
      supplierAdvances: number;
      inventory: number;
    };
  };
};

const CHECKLIST_BADGE = {
  ok: "border-sage-line bg-sage-soft text-sage-ink",
  warning: "border-caramel-line bg-caramel-soft text-caramel-ink",
  blocking: "border-clay-line bg-clay-soft text-clay-ink",
};
const CHECKLIST_TEXT = { ok: "سليم", warning: "تنبيه", blocking: "يمنع القفل" };

export default function AccountingOverviewPage() {
  const { cafe, user, canKey } = useApp();
  const currency = cafe?.currency ?? "EGP";
  const today = dateStrInTz(new Date());

  const { data, error, loading, reload } = useAccountingData<Overview>("/api/accounting/overview");
  const isConfigured = !!(data && data.configured);

  const periodsState = useAccountingData<PeriodsPayload>(isConfigured ? "/api/accounting/periods" : null);
  const reconState = useAccountingData<ReconciliationPayload>(
    isConfigured && canKey("accounting.reconcile") ? `/api/accounting/reconciliation?asOf=${today}` : null,
  );

  const [initializing, setInitializing] = useState(false);

  // Open new period dialog
  const [openPeriodModal, setOpenPeriodModal] = useState(false);
  const [startsOn, setStartsOn] = useState(`${today.slice(0, 7)}-01`);
  const [endsOn, setEndsOn] = useState(today);
  const [openReason, setOpenReason] = useState("");
  const [openKey, setOpenKey] = useState("");
  const [openingPeriod, setOpeningPeriod] = useState(false);
  const [openError, setOpenError] = useState("");

  // Close period confirmation dialog
  const [closingTarget, setClosingTarget] = useState<PeriodsPayload["periods"][number] | null>(null);
  const [closeNote, setCloseNote] = useState("");
  const [closeKey, setCloseKey] = useState("");
  const [closingBusy, setClosingBusy] = useState(false);
  const [closeError, setCloseError] = useState("");

  async function reloadAll() {
    await Promise.all([reload(), periodsState.reload(), reconState.reload()]);
  }

  async function handleInitializeBooks() {
    setInitializing(true);
    try {
      await api("/api/accounting/pnl", { method: "POST" });
      toast.success("تم تهيئة دفاتر الكافيه ودليل الحسابات بنجاح");
      await reloadAll();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "تعذّر تهيئة الدفاتر");
    } finally {
      setInitializing(false);
    }
  }

  async function submitOpenPeriod(e: React.FormEvent) {
    e.preventDefault();
    if (!startsOn || !endsOn || startsOn > endsOn) {
      setOpenError("تاريخ البداية لازم يكون قبل أو يساوي تاريخ النهاية");
      return;
    }
    setOpeningPeriod(true);
    setOpenError("");
    try {
      await api("/api/accounting/periods", {
        method: "POST",
        body: { startsOn, endsOn, ...(openReason.trim() ? { reason: openReason.trim() } : {}) },
        idempotencyKey: openKey || `open_period_${crypto.randomUUID()}`,
      });
      toast.success(`تم فتح الفترة المحاسبية ${startsOn} ← ${endsOn}`);
      setOpenPeriodModal(false);
      setOpenReason("");
      await reloadAll();
    } catch (err) {
      setOpenError(err instanceof Error ? err.message : "تعذّر فتح الفترة");
    } finally {
      setOpeningPeriod(false);
    }
  }

  async function submitClosePeriod(e: React.FormEvent) {
    e.preventDefault();
    if (!closingTarget) return;
    setClosingBusy(true);
    setCloseError("");
    try {
      await api(`/api/accounting/periods/${closingTarget.id}/close`, {
        method: "POST",
        body: closeNote.trim() ? { note: closeNote.trim() } : {},
        idempotencyKey: closeKey || `close_period_${closingTarget.id}_${crypto.randomUUID()}`,
      });
      toast.success(`تم إقفال الفترة ${closingTarget.startsOn} ← ${closingTarget.endsOn} بنجاح`);
      setClosingTarget(null);
      setCloseNote("");
      await reloadAll();
    } catch (err) {
      setCloseError(err instanceof Error ? err.message : "تعذّر إقفال الفترة");
    } finally {
      setClosingBusy(false);
    }
  }

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
  if (!data) return <LoadingState label={loading ? "جارٍ تحميل حالة النظام المحاسبي…" : "جارٍ التحضير…"} />;

  if (!data.configured) {
    return (
      <div data-testid="accounting-unconfigured">
        <Panel title="الدفاتر لسه ماتعملتش">
          <div className="space-y-4 text-sm leading-7">
            <p>مفيش دفاتر محاسبية للكافيه ده لحد دلوقتي. فتح الصفحة دي مش بيعمل دفاتر ولا بيرحّل أي حاجة.</p>
            <ol className="list-decimal space-y-1 pe-6 text-muted-foreground">
              <li>المحاسب يراجع دليل الحسابات المقترح وقواعد الترحيل.</li>
              <li>يتحدد تاريخ البداية ومين هيوقّع الأرصدة الافتتاحية.</li>
              <li>بعدها يتشغّل الترحيل التجريبي على فترة محددة، ويتراجع قبل أي اعتماد.</li>
            </ol>
            {!user.branchId && canKey("accounting.setup") && (
              <Button onClick={handleInitializeBooks} disabled={initializing}>
                {initializing ? "جارٍ التهيئة…" : "تهيئة دفاتر الكافيه ودليل الحسابات"}
              </Button>
            )}
          </div>
        </Panel>
      </div>
    );
  }

  const fmt = (n: number) => money(n, currency);
  const blocking = data.checklist?.items.filter((i) => i.status === "blocking").length ?? 0;
  const periods = periodsState.data?.periods ?? data.periods.map((p) => ({ ...p, closedAt: null, closedBy: null, entriesCount: 0 }));
  const recon = reconState.data;

  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <StatCard
          label="الشركة والدفاتر"
          value={data.entity.name}
          accent="blue"
          icon={<BookCheck className="size-5" />}
          hint={`${data.entity.accounts} حساب — ${data.branchScope ? "نطاق فرعك" : "كل الفروع"}`}
        />
        <StatCard
          label="الفترة الحالية"
          value={data.currentPeriod ? statusLabel(data.currentPeriod.status) : "غير محددة"}
          accent={data.currentPeriod?.status === "OPEN" ? "emerald" : "slate"}
          icon={<ClipboardCheck className="size-5" />}
          hint={data.currentPeriod ? `${data.currentPeriod.startsOn} ← ${data.currentPeriod.endsOn}` : "افتح فترة جديدة"}
        />
        <StatCard
          label="القيود المرحّلة"
          value={data.journal.entries}
          accent="emerald"
          icon={<Scale className="size-5" />}
          hint={data.journal.lastEntryDate ? `آخر قيد: ${data.journal.lastEntryDate}` : "لا توجد قيود بعد"}
        />
        <StatCard
          label="آخر ترحيل تجريبي"
          value={data.lastProjection ? `${data.lastProjection.posted} قيد` : "لم يُشغّل"}
          accent="slate"
          icon={<CheckCircle2 className="size-5" />}
          hint={data.lastProjection ? formatTime(data.lastProjection.at) : "التشغيل من شاشة P&L"}
        />
        <StatCard
          label="الأرصدة الافتتاحية"
          value={data.openingBalances.posted ? "مسجّلة" : "غير مسجّلة"}
          accent={data.openingBalances.posted ? "emerald" : "amber"}
          icon={<Wallet className="size-5" />}
          hint={data.openingBalances.date ?? "بانتظار اعتماد المحاسب"}
        />
        <StatCard
          label="حالات المراجعة / القفل"
          value={`${data.issues.open.length} تنبيه · ${data.checklist ? blocking : "—"} مانع`}
          accent={blocking > 0 || data.issues.open.length > 0 ? "red" : "emerald"}
          icon={<ShieldAlert className="size-5" />}
          hint={blocking > 0 ? "بنود تمنع إقفال الفترة" : "جاهزية المراجعة"}
        />
      </div>

      <Panel
        title="الفترات المحاسبية وإدارة الإقفال"
        bodyClassName="p-0"
        action={
          !user.branchId && canKey("accounting.setup") ? (
            <Button
              size="sm"
              onClick={() => {
                setOpenReason("");
                setOpenKey(`open_period_${crypto.randomUUID()}`);
                setOpenError("");
                setOpenPeriodModal(true);
              }}
            >
              <CalendarPlus className="size-4" />
              <span>فتح فترة محاسبية</span>
            </Button>
          ) : undefined
        }
      >
        {periods.length === 0 ? (
          <div className="p-5">
            <EmptyState message="لا توجد فترات محاسبية بعد. افتح أول فترة لتنظيم القيود وإقفالها شهريًا." icon="📅" />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <Table className="workspace-table">
              <TableHeader>
                <TableRow>
                  <TableHead>بداية الفترة</TableHead>
                  <TableHead>نهاية الفترة</TableHead>
                  <TableHead>الحالة</TableHead>
                  <TableHead>عدد القيود</TableHead>
                  <TableHead>تفاصيل الإقفال</TableHead>
                  <TableHead className="text-end">الإجراء</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {periods.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell dir="ltr" className="tabular-figures font-medium">
                      {p.startsOn}
                    </TableCell>
                    <TableCell dir="ltr" className="tabular-figures font-medium">
                      {p.endsOn}
                    </TableCell>
                    <TableCell>
                      <span
                        className={cn(
                          "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium",
                          p.status === "OPEN"
                            ? "border-sage-line bg-sage-soft text-sage-ink"
                            : "border-border bg-muted/60 text-muted-foreground",
                        )}
                      >
                        {statusLabel(p.status)}
                      </span>
                    </TableCell>
                    <TableCell className="tabular-figures">{p.entriesCount}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {p.closedAt ? `${formatTime(p.closedAt)}${p.closedBy ? ` — ${p.closedBy}` : ""}` : "—"}
                    </TableCell>
                    <TableCell className="text-end">
                      {!user.branchId && p.status === "OPEN" && canKey("accounting.close") ? (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            setClosingTarget(p);
                            setCloseNote("");
                            setCloseKey(`close_${p.id}_${crypto.randomUUID()}`);
                            setCloseError("");
                          }}
                        >
                          <Lock className="size-3.5" />
                          <span>إقفال الفترة</span>
                        </Button>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </Panel>

      {recon && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Panel
            title="مطابقة المخزون والموردين مقابل الأستاذ العام"
            action={<span className="text-xs text-muted-foreground">حتى {recon.asOf}</span>}
          >
            <div className="space-y-4">
              <div className="rounded-xl border border-border/80 bg-background/60 p-3.5">
                <div className="mb-2 flex items-center justify-between">
                  <span className="flex items-center gap-1.5 text-sm font-semibold">
                    <PackageCheck className="size-4 text-primary" />
                    <span>مراقبة المخزون</span>
                  </span>
                  <span
                    className={cn(
                      "rounded-full border px-2.5 py-0.5 text-xs font-medium",
                      recon.inventory.unposted === 0 && recon.inventory.uncostedRows === 0
                        ? "border-sage-line bg-sage-soft text-sage-ink"
                        : "border-caramel-line bg-caramel-soft text-caramel-ink",
                    )}
                  >
                    {recon.inventory.unposted === 0 && recon.inventory.uncostedRows === 0 ? "متطابق" : "يحتاج مراجعة"}
                  </span>
                </div>
                <dl className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-3">
                  <div>
                    <dt className="text-muted-foreground">سجل حركات المخزون</dt>
                    <dd className="font-semibold tabular-figures">{fmt(recon.inventory.ledgerValue)}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">الأستاذ العام للمخزون</dt>
                    <dd className="font-semibold tabular-figures">{fmt(recon.inventory.glInventory)}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">فرق غير مرحّل</dt>
                    <dd className={cn("font-semibold tabular-figures", recon.inventory.unposted !== 0 && "text-clay-ink")}>
                      {fmt(recon.inventory.unposted)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">التقييم الحالي بالمتوسط</dt>
                    <dd className="font-semibold tabular-figures">{fmt(recon.inventory.currentValuation)}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">حركات بلا تكلفة</dt>
                    <dd className={cn("font-semibold tabular-figures", recon.inventory.uncostedRows > 0 && "text-clay-ink")}>
                      {recon.inventory.uncostedRows}
                    </dd>
                  </div>
                </dl>
              </div>

              <div className="rounded-xl border border-border/80 bg-background/60 p-3.5">
                <div className="mb-2 flex items-center justify-between">
                  <span className="flex items-center gap-1.5 text-sm font-semibold">
                    <Truck className="size-4 text-primary" />
                    <span>ذمم وسلف الموردين</span>
                  </span>
                  <span
                    className={cn(
                      "rounded-full border px-2.5 py-0.5 text-xs font-medium",
                      recon.suppliers.payableDiff === 0 && recon.suppliers.advanceDiff === 0
                        ? "border-sage-line bg-sage-soft text-sage-ink"
                        : "border-caramel-line bg-caramel-soft text-caramel-ink",
                    )}
                  >
                    {recon.suppliers.payableDiff === 0 && recon.suppliers.advanceDiff === 0 ? "متطابق" : "فرق ترحيل"}
                  </span>
                </div>
                <dl className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-3">
                  <div>
                    <dt className="text-muted-foreground">ذمم الموردين (التشغيل)</dt>
                    <dd className="font-semibold tabular-figures">{fmt(recon.suppliers.payable)}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">حساب الموردين (GL)</dt>
                    <dd className="font-semibold tabular-figures">{fmt(recon.suppliers.glPayable)}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">الفرق</dt>
                    <dd className={cn("font-semibold tabular-figures", recon.suppliers.payableDiff !== 0 && "text-clay-ink")}>
                      {fmt(recon.suppliers.payableDiff)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">دفعات مقدمة للموردين</dt>
                    <dd className="font-semibold tabular-figures">{fmt(recon.suppliers.advanceTotal)}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">سلف الموردين (GL)</dt>
                    <dd className="font-semibold tabular-figures">{fmt(recon.suppliers.glAdvances)}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">فرق السلف</dt>
                    <dd className={cn("font-semibold tabular-figures", recon.suppliers.advanceDiff !== 0 && "text-clay-ink")}>
                      {fmt(recon.suppliers.advanceDiff)}
                    </dd>
                  </div>
                </dl>
              </div>
            </div>
          </Panel>

          <Panel
            title="جاهزية التكامل المالي والنقدي بالدفاتر"
            action={<span className="text-xs text-muted-foreground">قراءة رقابية</span>}
          >
            <div className="space-y-4 text-sm">
              <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
                <div className="rounded-xl border border-border/70 bg-background/60 p-2.5">
                  <p className="text-xs text-muted-foreground">درج النقدية (GL)</p>
                  <p className="mt-1 font-bold tabular-figures">{fmt(recon.bridge.controlBalances.cashDrawer)}</p>
                </div>
                <div className="rounded-xl border border-border/70 bg-background/60 p-2.5">
                  <p className="text-xs text-muted-foreground">الخزينة الرئيسية (GL)</p>
                  <p className="mt-1 font-bold tabular-figures">{fmt(recon.bridge.controlBalances.cashSafe)}</p>
                </div>
                <div className="rounded-xl border border-border/70 bg-background/60 p-2.5">
                  <p className="text-xs text-muted-foreground">حسابات البنك / التحصيل</p>
                  <p className="mt-1 font-bold tabular-figures">
                    {fmt(recon.bridge.controlBalances.bank + recon.bridge.controlBalances.cardClearing)}
                  </p>
                </div>
              </div>

              <ul className="divide-y divide-border/70 text-xs">
                <li className="flex items-center justify-between gap-2 py-2">
                  <span>ربط تصنيفات المصروفات بالحسابات</span>
                  <span
                    className={cn(
                      "rounded-full border px-2 py-0.5 font-medium",
                      recon.bridge.expenseCategories.unmappedActive === 0
                        ? "border-sage-line bg-sage-soft text-sage-ink"
                        : "border-caramel-line bg-caramel-soft text-caramel-ink",
                    )}
                  >
                    {recon.bridge.expenseCategories.mappedToday} / {recon.bridge.expenseCategories.totalActive} مربوط
                  </span>
                </li>
                <li className="flex items-center justify-between gap-2 py-2">
                  <span>مصروفات تشغيلية وتحويلات خزينة غير مرحّلة (بانتظار اعتماد الترحيل)</span>
                  <span className="rounded-full border border-caramel-line bg-caramel-soft px-2 py-0.5 font-medium text-caramel-ink tabular-figures">
                    {recon.bridge.unpostedOperations.operatingExpenses +
                      recon.bridge.unpostedOperations.operatingExpenseReturns +
                      recon.bridge.unpostedOperations.treasuryMovements}{" "}
                    عملية
                  </span>
                </li>
                <li className="flex items-center justify-between gap-2 py-2">
                  <span>تسويات البطاقات والمحافظ قيد الانتظار (D7)</span>
                  <span className="rounded-full border border-tide-line bg-tide-soft px-2 py-0.5 font-medium text-tide-ink tabular-figures">
                    {recon.bridge.tenderReconciliations.draftCount + recon.bridge.tenderReconciliations.submittedCount} معلّقة · فرق{" "}
                    {fmt(recon.bridge.tenderReconciliations.totalVariance)}
                  </span>
                </li>
                <li className="flex items-center justify-between gap-2 py-2">
                  <span>أصناف المخزون برصيد صفري (تحضير الأرصدة الافتتاحية)</span>
                  <span className="rounded-full border border-border bg-muted/50 px-2 py-0.5 font-medium tabular-figures">
                    {recon.bridge.inventoryCutover.zeroStockItems} / {recon.bridge.inventoryCutover.totalActiveItems} صنف
                  </span>
                </li>
              </ul>
            </div>
          </Panel>
        </div>
      )}

      {data.checklist && (
        <Panel
          title="قائمة التحقق قبل إقفال الفترة الحالية"
          action={<span className="text-xs text-muted-foreground">آخر فحص {formatTime(data.checklist.checkedAt)}</span>}
        >
          <ul className="divide-y divide-border/70 text-sm">
            {data.checklist.items.map((i) => (
              <li key={i.key} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                <div>
                  <p className="font-medium text-foreground">{i.label}</p>
                  {i.detail && <p className="text-xs text-muted-foreground">{i.detail}</p>}
                </div>
                <span className={cn("rounded-full border px-2.5 py-0.5 text-xs font-semibold", CHECKLIST_BADGE[i.status])}>
                  {CHECKLIST_TEXT[i.status]}
                </span>
              </li>
            ))}
          </ul>
        </Panel>
      )}

      {data.issues.open.length > 0 && (
        <Panel title={`تنبيهات ومشاكل الترحيل المفتوحة (${data.issues.open.length})`}>
          <ul className="divide-y divide-border/70 text-sm">
            {data.issues.open.map((i) => (
              <li key={`${i.kind}:${i.sourceKey}`} className="flex flex-wrap items-start justify-between gap-2 py-2.5">
                <div>
                  <span
                    className={cn(
                      "me-2 inline-flex rounded-full border px-2 py-0.5 text-xs font-semibold",
                      i.severity === "BLOCKING"
                        ? "border-clay-line bg-clay-soft text-clay-ink"
                        : "border-caramel-line bg-caramel-soft text-caramel-ink",
                    )}
                  >
                    {ISSUE_LABELS[i.kind] ?? i.kind}
                  </span>
                  <span dir="auto">{i.reason}</span>
                  <span className="mt-1 block text-xs text-muted-foreground" dir="ltr">
                    {i.sourceKey} · {formatTime(i.eventAt)}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </Panel>
      )}

      <Dialog open={openPeriodModal} onOpenChange={(open) => !open && setOpenPeriodModal(false)}>
        <DialogContent className="sm:max-w-md" dir="rtl">
          <DialogTitle>فتح فترة محاسبية جديدة</DialogTitle>
          <form onSubmit={submitOpenPeriod} className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="op-start">من تاريخ</Label>
                <Input
                  id="op-start"
                  type="date"
                  dir="ltr"
                  value={startsOn}
                  onChange={(e) => {
                    setStartsOn(e.target.value);
                    setOpenKey(`open_period_${crypto.randomUUID()}`);
                  }}
                  required
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="op-end">إلى تاريخ</Label>
                <Input
                  id="op-end"
                  type="date"
                  dir="ltr"
                  value={endsOn}
                  onChange={(e) => {
                    setEndsOn(e.target.value);
                    setOpenKey(`open_period_${crypto.randomUUID()}`);
                  }}
                  required
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="op-reason">السبب (اختياري)</Label>
              <Input
                id="op-reason"
                placeholder="مثال: دورة نوفمبر ٢٠٢٦"
                value={openReason}
                onChange={(e) => setOpenReason(e.target.value)}
                maxLength={300}
              />
            </div>
            {openError && (
              <p role="alert" className="text-sm font-medium text-destructive">
                {openError}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => setOpenPeriodModal(false)} disabled={openingPeriod}>
                إلغاء
              </Button>
              <Button type="submit" disabled={openingPeriod}>
                {openingPeriod ? "جارٍ الفتح…" : "اعتماد وفتح الفترة"}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={!!closingTarget} onOpenChange={(open) => !open && setClosingTarget(null)}>
        <DialogContent className="sm:max-w-md" dir="rtl">
          <DialogTitle>إقفال الفترة المحاسبية</DialogTitle>
          {closingTarget && (
            <form onSubmit={submitClosePeriod} className="space-y-4">
              <div className="rounded-xl border border-caramel-line bg-caramel-soft p-3 text-xs leading-relaxed text-caramel-ink">
                <p>
                  الفترة المستهدفة: <b dir="ltr">{closingTarget.startsOn} ← {closingTarget.endsOn}</b>
                </p>
                <p className="mt-1">
                  سيتم التحقق التلقائي من جميع بنود الإقفال ومنع أي قيد أو ترحيل جديد داخل هذه الفترة بعد الإغلاق.
                </p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="close-note">ملاحظة الإقفال (اختياري)</Label>
                <Input
                  id="close-note"
                  placeholder="مثال: مراجعة وإقفال شهري معتمد"
                  value={closeNote}
                  onChange={(e) => setCloseNote(e.target.value)}
                  maxLength={300}
                />
              </div>
              {closeError && (
                <p role="alert" className="text-sm font-medium text-destructive">
                  {closeError}
                </p>
              )}
              <div className="flex justify-end gap-2">
                <Button type="button" variant="outline" onClick={() => setClosingTarget(null)} disabled={closingBusy}>
                  إلغاء
                </Button>
                <Button type="submit" disabled={closingBusy}>
                  {closingBusy ? "جارٍ الفحص والإقفال…" : "تأكيد إقفال الفترة"}
                </Button>
              </div>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
