"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { StockCountDetail } from "@/components/stock-counts/stock-count-detail";
import { DetailFrame, ConfirmHandoverAction } from "./detail-frame";
import { HandoverOverview, type Overview } from "./handover-overview";
import { BranchSigningPanel } from "./branch-signing-panel";
import { OpeningCashPanel } from "./opening-cash-panel";
import { OpeningVerificationPanel } from "./opening-verification-panel";
import { PlaceReceiptPanel } from "./place-receipt-panel";
import { buildJourney, type JourneyInput, type Panel } from "./handover-journey";
import { ActivityPanel, JourneyStatus, PANELS, StageList, SummaryCard, TabBar, fmtDateTime } from "./handover-workspace-parts";
import type { ActivityEvent } from "@/lib/handover-activity";
import type { ShiftReadiness } from "@/lib/handover-readiness";
import { ReceivingSheet } from "./receiving-sheet";
import { receivingRowDisplay, reviewPriority, type ReceivingAck } from "./receiving-model";
import { TONE_SIDE, TONE_SURFACE } from "@/components/ui/tone";
import { handoverStep } from "./workflow-state";
import { handoverBlockMessage } from "./workflow-state";
import { api, money as formatMoney } from "@/lib/client";
import { UNIT_LABEL } from "@/lib/inventory";
import { cn } from "@/lib/utils";
import { useApp } from "@/components/app-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { HandoverActionBar } from "./handover-action-bar";
import { HANDOVER_STATUS_LABEL, TARGET_LABEL, type HandoverStatus } from "./handover-labels";

/**
 * A line of the count being handed over.
 *
 * The five figure fields are optional because the payload itself changes
 * shape: before anybody has acknowledged a line, the server does not send
 * them at all. The arriving custodian counts first and is shown the
 * outgoing party's numbers second — which is the whole point, and why this
 * screen must not invent a zero where a key is missing.
 */
type HandoverLine = {
  id: string;
  inventoryItemId: string;
  unit: string;
  disposition: string;
  inventoryItem: { id: string; name: string; category: string | null; unit: string; isCritical?: boolean };
  countedQuantity?: string | null;
  effectiveCountedQuantity?: string | null;
  expectedQuantity?: string | null;
  varianceQuantity?: string | null;
};

type HandoverView = {
  overview: Overview;
  workflow: { branchName: string; acknowledgements: ReceivingAck[]; incomingShift: { id: string; shiftNumber: number; cashierId: string; cashier: { name: string } } | null; incomingAmbiguous: boolean; readiness: ShiftReadiness[]; timezone: string; currency: string };
  activity: ActivityEvent[];
  segregatedReturns?: { id: string; quantity: number; inventoryItemId: string }[];
  financialSummary?:{outgoingName:string;incomingName:string|null;shiftId:string;shiftNumber:number;cashVariance:string|null;cashReason:string|null;tenders:Array<{method:string;varianceAmount:string|null;reasonNote:string|null}>;cashReceiptVariance:string|null;cashVerifiedAt:string|null};
  handoverId: string;
  status: HandoverStatus;
  branchId: string;
  target: string | null;
  mode: string | null;
  outgoingUserId: string;
  submittedAt: string | null;
  acknowledged: boolean;
  requiredItems: Array<{
    inventoryItemId: string;
    itemNameSnapshot: string;
    unitSnapshot: string;
    isCriticalSnapshot: boolean;
  }>;
  count: {
    sessionId: string;
    status: string;
    type: string;
    confirmedAt: string | null;
    systemValidated?: boolean;
    countVersion: string;
    lines: HandoverLine[];
  } | null;
};

const unitLabel = (unit: string) => UNIT_LABEL[unit as keyof typeof UNIT_LABEL] ?? unit;

export function HandoverDetail({
  handoverId,
  onClose,
  onChanged,
  embedded = false,
  expectedBranchId,
  reviewSessionId,
  listedStatus,
  listedHandover,
  listLoading = false,
  auxiliary = null,
}: {
  embedded?: boolean;
  expectedBranchId?: string;
  reviewSessionId?: string | null;
  // Status the list already shows for this handover; lets a draft that is not
  // open for receiving yet be explained instead of reported as an error.
  listedStatus?: string | null;
  listedHandover?: { status: string; outgoingUser?: { name: string } | null; outgoingShift?: { shiftNumber: number } | null; stockCountSession?: { status: string } | null } | null;
  // True while the list is still loading: the failure is not worded yet, so
  // the red box does not flash before the calm explanation can replace it.
  listLoading?: boolean;
  // Shown when the handover itself cannot be opened (for example a draft that is not the viewer's), so the
  // opening-verification, cash and place panels stay reachable from the same entry point.
  auxiliary?: ReactNode;
  handoverId: string | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { canKey, user } = useApp();
  const router = useRouter();
  const inFlight = useRef(false);
  const [confirmSubmit, setConfirmSubmit] = useState(false);
  const [view, setView] = useState<HandoverView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState("");

  const load = useCallback(async () => {
    if (!handoverId) return;
    setError("");
    if (!embedded) setLoading(true);
    try {
      const { handover } = await api<{ handover: HandoverView }>(
        `/api/handovers/${handoverId}`
      );
      if (expectedBranchId && handover.branchId !== expectedBranchId) throw new Error("التسليم لا يخص الفرع المحدد — ارجع للقائمة واختر الفرع الصحيح");
      setView(handover);
    } catch (e) {
      const message = e instanceof Error ? e.message : "تعذّر فتح التسليم";
      setError(message);
      setView(null);
    } finally {
      setLoading(false);
    }
  }, [handoverId, embedded, expectedBranchId]);

  useEffect(() => {
    load();
  }, [load]);

  const after = useCallback(async () => {
    await load();
    onChanged();
  }, [load, onChanged]);

  async function outgoing(action: "start_count" | "submit") {
    if (!view || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      await api("/api/handovers", {
        method: "POST",
        body: { action, handoverId: view.handoverId },
      });
      toast.success(action === "start_count" ? "اتفتح جرد التسليم" : "اتسلّمت العهدة");
      await after();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "تعذّر تنفيذ الإجراء");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  const { cafe } = useApp();
  const tz = view?.workflow.timezone ?? "Africa/Cairo";
  const currency = view?.workflow.currency ?? cafe?.currency ?? "EGP";
  const [tab, setTab] = useState<Panel>(() => {
    const hash = typeof window === "undefined" ? "" : window.location.hash.replace("#", "");
    return (PANELS as string[]).includes(hash) ? (hash as Panel) : "summary";
  });
  const [pickedFilter, setPickedFilter] = useState<"action" | "discrepancy" | "excluded" | "all" | null>(null);
  const openPanel = useCallback((p: Panel) => {
    setTab(p);
    try { window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}#${p}`); } catch { /* the tab still switches */ }
    requestAnimationFrame(() => document.getElementById(`handover-panel-${p}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" }));
  }, []);

  const branchCustody = view?.target === "BRANCH_CUSTODY";
  const isRecipient = !!view && view.workflow.incomingShift?.cashierId === user.id;
  const mayReviewStock = !!view && canKey("handover.accept") && ["OUTGOING_SUBMITTED", "INCOMING_REVIEW"].includes(view.status)
    && isRecipient && !view.workflow.incomingAmbiguous && view.target === "SHIFT_TO_SHIFT";
  const lines = view?.count?.lines ?? [];
  const acks = view?.workflow.acknowledgements ?? [];
  const ackByLine = new Map(acks.map((a) => [a.stockCountLineId, a]));
  const unreviewedLines = lines.filter((line) => line.disposition !== "PENDING" && !ackByLine.has(line.id));
  const excludedLines = lines.filter((line) => line.disposition === "PENDING");
  const canReceiveLines = mayReviewStock && unreviewedLines.length > 0;
  const canSignForBranch = !!view && branchCustody && canKey("handover.accept") && canKey("handover.exception")
    && ["OUTGOING_SUBMITTED", "INCOMING_REVIEW"].includes(view.status);
  // The server already limits these to the current count round, so a dispute from a superseded round cannot appear here.
  const disputedAcks = acks.filter((ack) => ack.decision === "DISPUTED");
  const receivingDisputed = disputedAcks.length > 0;
  const stockReviewReady = !!view?.count && unreviewedLines.length === 0 && !receivingDisputed;
  const disputedNames = lines.filter((line) => disputedAcks.some((ack) => ack.stockCountLineId === line.id)).map((line) => line.inventoryItem.name);
  const receiptVisible = !!view && view.count !== null && !["DRAFT", "REJECTED"].includes(view.status);
  const pendingReturns = (view?.segregatedReturns ?? []).reduce((sum, row) => sum + row.quantity, 0);
  const step = view ? handoverStep(view.status, view.count?.status ?? null) : "unknown";

  const readinessFocus = view ? (view.workflow.readiness.find((r) => r.shiftId === view.workflow.incomingShift?.id) ?? view.workflow.readiness.find((r) => r.gate !== null) ?? null) : null;
  const journey = view ? buildJourney({
    target: (view.target as JourneyInput["target"]) ?? null, status: view.status, countStatus: view.count?.status ?? null, systemValidated: !!view.count?.systemValidated,
    financiallyClosed: !!view.overview.financiallyClosedAt, disputed: receivingDisputed, unreviewedLines: unreviewedLines.length, excludedLines: excludedLines.length,
    outgoingName: view.overview.signatures.outgoingName, incomingShift: view.workflow.incomingShift ? { shiftNumber: view.workflow.incomingShift.shiftNumber, name: view.workflow.incomingShift.cashier.name } : null,
    incomingAmbiguous: view.workflow.incomingAmbiguous, readiness: readinessFocus,
    can: { submit: canKey("handover.submit"), confirmCount: canKey("stock_count.confirm"), accept: canKey("handover.accept"), exception: canKey("handover.exception") },
    viewer: { isOutgoing: view.outgoingUserId === user.id, isRecipient, name: user.name },
  }) : null;

  // Cards: each states exactly what it counts. Lines are counted as lines, never summed across units.
  const money = view?.overview.money ?? null;
  const cashPending = readinessFocus?.requirements.find((r) => r.id === "cash-receipt");
  const lineCounted = lines.length - excludedLines.length;
  const discrepancyLines = view?.acknowledged ? lines.filter((l) => l.varianceQuantity != null && Number(l.varianceQuantity) !== 0).length : null;
  const tenderDifferences = money?.payments.filter((p) => p.variance != null && Math.abs(Number(p.variance)) > 0.005).length ?? 0;
  const cashDifference = money?.closingDifference != null && Math.abs(Number(money.closingDifference)) > 0.005;
  const carried = view?.overview.operations ?? null;

  const filterCounts = {
    action: lines.filter((l) => (l.disposition !== "PENDING" && !ackByLine.has(l.id)) || ackByLine.get(l.id)?.decision === "DISPUTED").length,
    discrepancy: lines.filter((l) => ackByLine.get(l.id)?.decision === "DISPUTED" || (view?.acknowledged && l.varianceQuantity != null && Number(l.varianceQuantity) !== 0)).length,
    excluded: excludedLines.length, all: lines.length,
  };
  // Until the viewer picks one: lines needing action when there are any, otherwise every line (never an empty table by default).
  const lineFilter = pickedFilter ?? (filterCounts.action > 0 ? "action" : "all");
  const lineRows = lines
    .map((line) => ({ line, ack: ackByLine.get(line.id) }))
    .filter(({ line, ack }) => {
      if (search.trim() && !line.inventoryItem.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())) return false;
      const needsAction = (line.disposition !== "PENDING" && !ack) || ack?.decision === "DISPUTED";
      const discrepancy = ack?.decision === "DISPUTED" || (view?.acknowledged && line.varianceQuantity != null && Number(line.varianceQuantity) !== 0) || (!!ack && ack.varianceQuantity != null && Number(ack.varianceQuantity) !== 0);
      return lineFilter === "all" ? true : lineFilter === "action" ? needsAction : lineFilter === "discrepancy" ? !!discrepancy : line.disposition === "PENDING";
    })
    .sort((a, b) => reviewPriority(a.line) - reviewPriority(b.line));
  const latestSignature = view?.overview.signatures.acceptedAt ?? null;

  const reportUrl = (format: "xlsx" | "html") => `/api/handovers/${view?.handoverId}/report?format=${format}`;

  return (
    <>
      <DetailFrame embedded={embedded} open={handoverId !== null} busy={busy} title="تسليم الشيفت" onClose={onClose}>

          {loading && <p className="text-sm text-muted-foreground">جاري التحميل…</p>}
          {error && !(listLoading && !view) && (!view && (listedStatus === "DRAFT" || listedStatus === "REJECTED")
            ? <p role="status" data-testid="handover-not-open-yet" className="rounded-lg border bg-muted/30 p-3 text-sm">
                {listedStatus === "REJECTED" ? "التسليم اترجع للمُسلّم لإعادة الجرد."
                  : handoverStep(listedStatus, listedHandover?.stockCountSession?.status ?? null) === "review" ? "التسليم لسه عند المُسلّم، والجرد بانتظار اعتماد مسؤول بصلاحية تأكيد الجرد."
                  : "التسليم لسه عند المُسلّم ومفيش إجراء مطلوب منك دلوقتي."}{" "}{handoverBlockMessage({ status: listedStatus, countStatus: listedHandover?.stockCountSession?.status ?? null, outgoingName: listedHandover?.outgoingUser?.name ?? "المُسلّم", outgoingShiftNumber: listedHandover?.outgoingShift?.shiftNumber ?? null })}{" "}
                بعد ما يقدّم العهدة هتقدر تراجع الأصناف وتستلم من هنا. لم يتغير شيء.
                {reviewSessionId && canKey("stock_count.confirm") && canKey("stock_count.view") ? " جرد المُسلّم ظاهر تحت للمراجعة." : ""}
              </p>
            : <p role="alert" className="rounded-lg border p-3 text-sm">{error}. لم يتغير شيء — لو التسليم مسودة لموظف آخر، المسؤول يراجع الجرد ثم يقدّم المُسلّم العهدة.</p>)}
          {!view && reviewSessionId && canKey("stock_count.confirm") && canKey("stock_count.view") && <StockCountDetail key={reviewSessionId} embedded expectedBranchId={expectedBranchId} sessionId={reviewSessionId} onClose={onClose} onChanged={onChanged} />}

          {!loading && !view && !error && auxiliary}
          {!loading && view && journey && (
            <div className="min-w-0 space-y-4 text-sm">
              <section className="space-y-3 rounded-xl border bg-card p-3" aria-label="تقدم التسليم" data-testid="handover-header">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-base font-semibold [overflow-wrap:anywhere]">{view.workflow.branchName} · شيفت #{view.financialSummary?.shiftNumber ?? view.overview.shiftNumber}</h2>
                  <Badge>{HANDOVER_STATUS_LABEL[view.status] ?? view.status}</Badge>
                  {view.target && <Badge className="bg-muted text-foreground hover:bg-muted">{TARGET_LABEL[view.target] ?? view.target}</Badge>}
                  <span className="flex-1" />
                  <Button size="sm" variant="outline" className="min-h-9" disabled={busy} onClick={() => void after()}>تحديث</Button>
                  {canKey("reports.export") && <>
                    <a className="inline-flex min-h-9 items-center rounded-lg border px-3 text-xs font-medium hover:bg-muted" href={reportUrl("xlsx")} data-testid="handover-export-xlsx">تصدير Excel</a>
                    <a className="inline-flex min-h-9 items-center rounded-lg border px-3 text-xs font-medium hover:bg-muted" href={reportUrl("html")} target="_blank" rel="noopener" data-testid="handover-print">طباعة التقرير</a>
                  </>}
                </div>
                <dl className="grid gap-x-4 gap-y-1 text-xs sm:grid-cols-2 lg:grid-cols-3">
                  <div><dt className="inline text-muted-foreground">المُسلّم: </dt><dd className="inline font-medium">{view.overview.signatures.outgoingName} (شيفت #{view.financialSummary?.shiftNumber ?? view.overview.shiftNumber})</dd></div>
                  <div><dt className="inline text-muted-foreground">{branchCustody ? "الجهة المستلمة: " : "المستلم: "}</dt><dd className="inline font-medium">{branchCustody ? "عهدة الفرع (توقيع باسم الفرع)" : view.workflow.incomingShift ? `${view.workflow.incomingShift.cashier.name} (شيفت #${view.workflow.incomingShift.shiftNumber})` : "لم يُحدد بعد"}</dd></div>
                  {branchCustody && view.workflow.incomingShift && <div><dt className="inline text-muted-foreground">شيفت منتظر: </dt><dd className="inline font-medium">#{view.workflow.incomingShift.shiftNumber} — {view.workflow.incomingShift.cashier.name}</dd></div>}
                  <div><dt className="inline text-muted-foreground">الإقفال المالي: </dt><dd className="inline font-medium">{fmtDateTime(view.overview.financiallyClosedAt, tz)}</dd></div>
                  <div><dt className="inline text-muted-foreground">تقديم العهدة: </dt><dd className="inline font-medium">{fmtDateTime(view.overview.signatures.submittedAt, tz)}</dd></div>
                  <div><dt className="inline text-muted-foreground">اكتمال التسليم: </dt><dd className="inline font-medium">{fmtDateTime(view.overview.signatures.completedAt, tz)}</dd></div>
                </dl>
                <JourneyStatus journey={journey} />
              </section>

              {/* REQUIRED NOW — one prominent panel: what, who, why blocked, and the direct action. */}
              <section className="space-y-2 rounded-xl border border-primary/30 bg-primary/5 p-3" aria-label="المطلوب الآن" data-testid="handover-required-now">
                <p className="text-xs font-medium text-muted-foreground">المطلوب الآن</p>
                <p className="text-base font-semibold [overflow-wrap:anywhere]">{journey.requiredNow.title}</p>
                <p className="text-xs text-muted-foreground">المسؤول: {journey.requiredNow.actor}</p>
                {journey.requiredNow.blocker && <p role="status" className="rounded-lg border border-dashed p-2 text-xs" data-testid="handover-required-blocker">{journey.requiredNow.blocker}</p>}
                <div className="flex flex-wrap gap-2">
                  {journey.requiredNow.panel && journey.requiredNow.actionLabel && <Button size="sm" className="min-h-10" onClick={() => openPanel(journey.requiredNow.panel!)}>{journey.requiredNow.actionLabel}</Button>}
                  {canKey("handover.submit") && view.outgoingUserId === user.id && ["DRAFT", "REJECTED"].includes(view.status) && <>
                    {(!view.count || view.status === "REJECTED") && <Button size="sm" variant="outline" className="min-h-10" disabled={busy} onClick={() => outgoing("start_count")} data-testid="handover-start-count">
                      {view.status === "REJECTED" ? "فتح جرد إعادة التسليم" : "فتح جرد التسليم"}
                    </Button>}
                    {view.count?.status === "CONFIRMED" && <Button size="sm" variant="default" className="min-h-10" disabled={busy || view.status !== "DRAFT" || view.count?.status !== "CONFIRMED"} onClick={() => setConfirmSubmit(true)} data-testid="handover-submit">
                      تقديم العهدة للمستلم
                    </Button>}
                  </>}
                </div>
                {journey.requiredNow.parallel.length > 0 && (
                  <div className="space-y-1 border-t pt-2" data-testid="handover-parallel">
                    <p className="text-xs font-medium text-muted-foreground">مطلوب كمان (مستقل، ممكن يتعمل بالتوازي):</p>
                    <ul className="space-y-1">{journey.requiredNow.parallel.map((s) => <li key={s.id} className="flex flex-wrap items-center gap-2 text-xs"><span className="font-medium">{s.label}</span><span className="text-muted-foreground">— {s.actor}</span><button type="button" className="text-primary underline" onClick={() => openPanel(s.panel)}>افتح</button></li>)}</ul>
                  </div>
                )}
              </section>

              {receivingDisputed && step !== "complete" && (
                // The current dispute outranks any earlier all-clear: the outgoing count may well have matched,
                // and it still says nothing about what the receiver found.
                <p role="alert" data-testid="handover-receiving-disputed" className={`rounded-lg border p-3 text-sm font-medium ${TONE_SURFACE.caramel} ${TONE_SIDE.caramel}`}>
                  الاستلام معترض عليه والعهدة لم تكتمل{disputedNames.length > 0 ? `: ${disputedNames.join("، ")}` : ""}.
                  {view.count?.systemValidated ? " جرد المُسلّم كان مطابقًا وتحقّق منه النظام، لكن عدّ المستلم يختلف عمّا سُلّم." : ""}
                </p>
              )}
              {step === "receive" && !branchCustody && !canReceiveLines && !stockReviewReady && !receivingDisputed && (
                <div role="status" data-testid="handover-receive-blocker-callout" className={`flex flex-wrap items-center justify-between gap-3 rounded-xl border p-3 text-sm font-medium ${TONE_SURFACE.caramel} ${TONE_SIDE.caramel}`}>
                  <span>
                    {!view.workflow.incomingShift
                      ? "تم تأكيد جرد الأصناف وتقديم العهدة، لكن لا يوجد شيفت مستلم مفتوح حاليًا في هذا الفرع لتسجيل ورقة الاستلام. المستلم يفتح شيفته من حسابه هو أولًا، وبعدها يوقّع ورقة الاستلام."
                      : `بانتظار المستلم (${view.workflow.incomingShift.cashier.name} — شيفت #${view.workflow.incomingShift.shiftNumber}) لتسجيل قرارات ورقة الاستلام للأصناف (${unreviewedLines.length}) قبل تفعيل تأكيد الاستلام أو الاستلام الاستثنائي.`}
                  </span>
                  {/* The shift opens under whoever clicks, so the outgoing user never gets this shortcut. */}
                  {!view.workflow.incomingShift && view.outgoingUserId !== user.id && (
                    <Link href="/current-shift" className="inline-flex h-9 items-center justify-center rounded-lg bg-primary px-3 text-xs font-semibold text-primary-foreground shadow-xs hover:bg-primary/90">أنا المستلم: افتح شيفتي</Link>
                  )}
                </div>
              )}
              {view.count?.systemValidated && !receivingDisputed && <p role="status" className="text-xs text-emerald-800 dark:text-emerald-200">الكميات مطابقة — تحقّق منها النظام دون توقيع اعتماد من مسؤول.</p>}
              {view.workflow.incomingAmbiguous && <p role="alert" className="text-amber-800 dark:text-amber-200">فيه أكتر من شيفت ممكن يستلم — لازم يتحدد المستلم قبل القبول، والنظام مش هيختار بالنيابة عنك.</p>}
              {view.status === "REJECTED" && <p role="status">الجرد اترجع للمُسلّم: افتح جرد إعادة التسليم. الجرد القديم وسجل الاعتراض محفوظين ومش هيتحسبوا كدليل مقبول.</p>}

              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-label="ملخص التسليم" data-testid="handover-cards">
                <SummaryCard panel="cash" tone={cashDifference || tenderDifferences > 0 ? "clay" : cashPending?.state === "pending" ? "caramel" : "sage"} title="المال واستلام الكاش"
                  value={money ? (money.closingDifference == null ? "غير مسجل" : formatMoney(Number(money.closingDifference), currency)) : "غير متاح"}
                  lines={[money ? "فرق الإقفال النقدي (المعدود − المتوقع)" : "تفاصيل المال لصاحب صلاحية تقارير الشيفت", cashPending ? `استلام كاش الدرج: ${cashPending.state === "done" ? "تم" : cashPending.state === "pending" ? "مطلوب" : "غير مطلوب"}` : "استلام كاش الدرج: غير مطلوب", ...(tenderDifferences > 0 ? [`${tenderDifferences} فرق في البطاقة/المحفظة`] : [])]} onOpen={openPanel} />
                <SummaryCard panel="inventory" tone={unreviewedLines.length > 0 || receivingDisputed ? "caramel" : "sage"} title="سطور جرد محتاجة إجراء"
                  value={view.count ? `${unreviewedLines.length + disputedAcks.length}` : "—"}
                  lines={view.count ? [`${unreviewedLines.length} بلا ${branchCustody ? "توقيع" : "قرار استلام"} من ${lineCounted} معدود`, `${disputedAcks.length} معترض عليه`, `${excludedLines.length} غير معدود (خارج التوقيع)`] : ["لا يوجد جرد مربوط"]} onOpen={openPanel} />
                <SummaryCard panel="inventory" tone={(discrepancyLines ?? 0) > 0 || receivingDisputed || cashDifference ? "clay" : "sage"} title="فروقات للمتابعة"
                  value={discrepancyLines === null ? "مخفي" : `${discrepancyLines + disputedAcks.length}`}
                  lines={[discrepancyLines === null ? "الفروقات تظهر بعد التوقيع (قاعدة العدّ المستقل)" : `${discrepancyLines} سطر جرد بفرق · ${disputedAcks.length} اعتراض`, cashDifference ? "فيه فرق نقدي عند الإقفال" : "لا فرق نقدي مسجل"]} onOpen={openPanel} />
                <SummaryCard panel="orders" tone={carried && carried.length > 0 ? "tide" : "sage"} title="طلبات منقولة" value={carried === null ? "غير متاح" : `${carried.length}`}
                  lines={[carried === null ? "تحتاج صلاحية عرض الطلبات" : carried.length ? "طلبات مفتوحة اتنقلت مع التسليم" : "لا طلبات منقولة"]} onOpen={openPanel} />
              </div>

              <TabBar active={tab} onChange={openPanel} counts={{ inventory: filterCounts.action, orders: carried?.length ?? null, activity: view.activity.length }} />

              <div className="min-w-0" data-testid="handover-wide-grid">
                {tab === "summary" && (
                  <div role="tabpanel" id="handover-panel-summary" aria-labelledby="handover-tab-summary" className="space-y-4">
                    <StageList stages={journey.stages} onOpen={openPanel} />
                  </div>
                )}

                {tab === "cash" && (
                  <div role="tabpanel" id="handover-panel-cash" aria-labelledby="handover-tab-cash" className="space-y-4">
                    <HandoverOverview overview={view.overview} part="money" currency={currency} timezone={tz} />
                    <OpeningCashPanel branchId={view.branchId} />
                  </div>
                )}

                {tab === "inventory" && (
                  <div role="tabpanel" id="handover-panel-inventory" aria-labelledby="handover-tab-inventory" className="space-y-4">
                    {view.requiredItems.length > 0 && (
                      <p className="text-muted-foreground">
                        <span className="font-medium text-foreground">أصناف مطلوب جردها: </span>
                        {view.requiredItems.map((i) => `${i.itemNameSnapshot} (${unitLabel(i.unitSnapshot)})`).join(" · ")}
                      </p>
                    )}
                    {view.count && view.status === "DRAFT" && canKey("stock_count.view") && <StockCountDetail key={view.count.sessionId} embedded expectedBranchId={view.branchId} sessionId={view.count.sessionId} onClose={onClose} onChanged={after} />}
                    {view.count === null && <p className="rounded-lg border border-dashed p-4 text-center text-muted-foreground">مفيش جرد مربوط بالتسليم ده لسه</p>}
                    {canSignForBranch && view.count && <BranchSigningPanel key={view.count.sessionId} handoverId={view.handoverId} lines={lines} acknowledgements={acks} signedAt={latestSignature ? fmtDateTime(latestSignature, tz) : null} actorName={user.name} onChanged={after} />}
                    {canReceiveLines && view.count && <ReceivingSheet key={view.count.sessionId} handoverId={view.handoverId} countSessionId={view.count.sessionId} countVersion={view.count.countVersion} lines={view.count.lines} acknowledgements={view.workflow.acknowledgements} onSaved={after} />}
                    {receiptVisible && view.count && !canReceiveLines && (
                      <div className="space-y-2">
                        <div className="flex flex-wrap items-end gap-2">
                          <label className="block min-w-48 flex-1">بحث عن صنف<input className="mt-1 h-10 w-full rounded-lg border px-3" aria-label="بحث أصناف الاستلام" value={search} onChange={e => setSearch(e.target.value)} /></label>
                          <div role="group" aria-label="تصفية السطور" className="flex flex-wrap gap-1">
                            {([["action", "محتاج إجراء"], ["discrepancy", "فروقات"], ["excluded", "غير معدود/مستثنى"], ["all", "الكل"]] as const).map(([id, label]) => (
                              <button key={id} type="button" aria-pressed={lineFilter === id} onClick={() => setPickedFilter(id)} data-testid={`handover-filter-${id}`}
                                className={cn("min-h-10 rounded-full border px-3 text-xs font-medium", lineFilter === id ? "border-primary bg-primary text-primary-foreground" : "hover:bg-muted")}>
                                {label} <span className="tabular-nums">({filterCounts[id]})</span>
                              </button>
                            ))}
                          </div>
                        </div>
                        {!view.acknowledged && <p className="text-xs text-muted-foreground">كميات المُسلّم تُعرض بعد تسجيل {branchCustody ? "التوقيع باسم الفرع" : "قرارات الاستلام"}.</p>}
                        <div className="max-h-[55vh] overflow-auto rounded-xl border">
                          <Table>
                            <TableHeader className="max-sm:hidden">
                              <TableRow>
                                <TableHead>الصنف</TableHead>
                                <TableHead>الوحدة</TableHead>
                                <TableHead>جرد المُسلّم</TableHead>
                                <TableHead className="text-end">{branchCustody ? "توقيع الفرع" : "استلام"}</TableHead>
                              </TableRow>
                            </TableHeader>
                            <TableBody>
                              {lineRows.length === 0 && <TableRow><TableCell colSpan={4} className="text-center text-muted-foreground">مفيش سطور في الفلتر ده.</TableCell></TableRow>}
                              {lineRows.map(({ line }) => (
                                <TableRow key={line.id} data-testid="handover-line-row" className="max-sm:block max-sm:border-b max-sm:py-2">
                                  <TableCell className="min-w-36 max-w-56 whitespace-normal font-medium [overflow-wrap:anywhere] max-sm:block max-sm:max-w-none">
                                    {line.inventoryItem.name}
                                  </TableCell>
                                  <TableCell className="text-muted-foreground max-sm:block max-sm:pb-0">{unitLabel(line.unit)}</TableCell>
                                  {(() => {
                                    const row = receivingRowDisplay(line, view.workflow.acknowledgements.find(ack => ack.stockCountLineId === line.id), view.acknowledged);
                                    return <>
                                      <TableCell className="min-w-32 whitespace-normal tabular-nums max-sm:block">
                                        {line.disposition === "PENDING" ? <span className="text-muted-foreground">غير معدود — خارج التوقيع</span> : <>
                                          <div>العدّ: {row.outgoingCount}</div>
                                          <div className="text-xs text-muted-foreground">الفرق عن المتوقع: {row.outgoingDifference}</div>
                                        </>}
                                      </TableCell>
                                      <TableCell className="min-w-40 whitespace-normal text-end max-sm:block max-sm:text-start">
                                        {row.state === "pending" ? <span className="text-muted-foreground">{line.disposition === "PENDING" ? "—" : branchCustody ? "لم يُوقّع بعد" : "لم يُسجّل استلام بعد"}</span> : <>
                                          <div className={row.state === "disputed" ? "font-semibold" : undefined}>{row.state === "disputed" ? "معترض عليه — اطلب إعادة الجرد" : branchCustody ? "موقّع باسم الفرع (بدون عدّ مستقل)" : "تم استلام السطر"}</div>
                                          {!branchCustody && <div className="text-xs text-muted-foreground tabular-nums">عدّ المستلم: {row.incomingCount} · المُسلَّم: {row.handedOver}</div>}
                                          {!branchCustody && <div className="text-xs text-muted-foreground tabular-nums">فرق الاستلام: {row.receivingDifference}</div>}
                                        </>}
                                      </TableCell>
                                    </>;
                                  })()}
                                </TableRow>
                              ))}
                            </TableBody>
                          </Table>
                        </div>
                      </div>
                    )}
                    {(["OUTGOING_SUBMITTED", "INCOMING_REVIEW"] as string[]).includes(view.status) && <HandoverActionBar key={view.handoverId} handoverId={view.handoverId} allowReceive={mayReviewStock && stockReviewReady} hasIncomingShift={!!view.workflow.incomingShift} stockReviewReady={stockReviewReady} target={view.target} onDone={async () => {
                      try {
                        if (canKey("shifts.view_current")) await api(`/api/shifts/active?branchId=${encodeURIComponent(view.branchId)}`);
                      } catch {
                        toast.warning("تم حفظ الإجراء؛ تعذّر تحديث الشيفت الآن. حدّث نقطة البيع للتحقق من جاهزيته.");
                      } finally {
                        await after(); router.refresh();
                      }
                    }} />}
                    <OpeningVerificationPanel key={`opening:${view.branchId}:${view.status}`} branchId={view.branchId} includeCash={false} />
                  </div>
                )}

                {tab === "place" && (
                  <div role="tabpanel" id="handover-panel-place" aria-labelledby="handover-tab-place" className="space-y-3">
                    <p className="text-xs text-muted-foreground">فحص المكان والأجهزة مستقل عن تسليم المخزون: ممكن يتم بالتوازي لما يكون شيفت المستلم مفتوح.</p>
                    <PlaceReceiptPanel key={`place:${view.branchId}`} branchId={view.branchId} />
                  </div>
                )}

                {tab === "orders" && (
                  <div role="tabpanel" id="handover-panel-orders" aria-labelledby="handover-tab-orders" className="space-y-4">
                    <HandoverOverview overview={view.overview} part="orders" currency={currency} timezone={tz} />
                    {view.overview.operations !== null && view.overview.operations.length === 0 && <p className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground">لا توجد طلبات منقولة مع هذا التسليم.</p>}
                    {pendingReturns > 0 && (
                      // Only shown when something is actually held aside: physical returns during a count freeze stay out of the counted stock.
                      <section className="space-y-1 rounded-lg border border-amber-500 p-3">
                        <p className="font-medium">مرتجعات محجوزة أثناء التجميد: {pendingReturns} قطعة</p>
                        <p className="text-xs text-muted-foreground">متتباعش ومتتعدّش في الجرد — بتتضاف بعد التسوية ورفع التجميد.</p>
                        {(view.segregatedReturns ?? []).map(row => <p key={row.id} className="text-xs">إيصال {row.id}: {row.quantity} قطعة — معلّق</p>)}
                        {canKey("inventory.transactions") && <Link href="/inventory" className="text-primary underline">مراجعة المرتجع في المخزون</Link>}
                      </section>
                    )}
                  </div>
                )}

                {tab === "activity" && (
                  <div role="tabpanel" id="handover-panel-activity" aria-labelledby="handover-tab-activity" className="space-y-4">
                    <ActivityPanel events={view.activity} tz={tz} />
                    <HandoverOverview overview={view.overview} part="signatures" currency={currency} timezone={tz} />
                  </div>
                )}
              </div>
            </div>
          )}
      </DetailFrame>
      <ConfirmHandoverAction title="تسليم العهدة للمراجعة والاستلام" open={confirmSubmit} busy={busy} onCancel={() => setConfirmSubmit(false)} onConfirm={() => {setConfirmSubmit(false); void outgoing("submit");}} />


    </>
  );
}
