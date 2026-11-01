"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { StockCountDetail } from "@/components/stock-counts/stock-count-detail";
import { DetailFrame, ConfirmHandoverAction } from "./detail-frame";
import { HandoverOverview, type Overview } from "./handover-overview";
import { ReceivingSheet } from "./receiving-sheet";
import { receivingRowDisplay, reviewPriority, type ReceivingAck } from "./receiving-model";
import { TONE_SIDE, TONE_SURFACE } from "@/components/ui/tone";
import { handoverStep } from "./workflow-state";
import { handoverBlockMessage } from "./workflow-state";
import { api } from "@/lib/client";
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
  workflow: { branchName: string; acknowledgements: ReceivingAck[]; incomingShift: { id: string; shiftNumber: number; cashierId: string; cashier: { name: string } } | null; incomingAmbiguous: boolean };
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

// The steps follow `handoverStep`, which only names where the handover is;
// every transition is still decided by the existing handover services.
const STEPS = [
  { id: "count", label: "الجرد" },
  { id: "review", label: "اعتماد الجرد" },
  { id: "submit", label: "تقديم العهدة" },
  { id: "receive", label: "استلام المستلم" },
  { id: "complete", label: "مكتمل" },
] as const;
const NEXT_STEP: Record<string, string> = {
  count: "اعدّ الأصناف المطلوبة وسجّل الكمية الفعلية لكل صنف، ثم أرسل الجرد. الفروقات بتتسجل والتسليم بيكمّل.",
  review: "الجرد مُرسل — يعتمده مسؤول بصلاحية تأكيد الجرد.",
  submit: "الجرد معتمد — قدّم العهدة للمستلم.",
  receive: "راجع ورقة الاستلام: عدّ مستقل أو استلام صريح دون عدّ مستقل لكل صنف، ثم تأكيد الورقة. الكمية المختلفة بتتسجل وتكمّل؛ الرفض الصريح بس هو اللي يوقف العهدة.",
  complete: "التسليم مكتمل.",
  disputed: "الاستلام معترض عليه — اطلب إعادة الجرد؛ لا يمكن إكمال العهدة قبل ذلك.",
  unknown: "حالة غير متوقعة — حدّث الصفحة.",
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

  const step = view ? handoverStep(view.status, view.count?.status ?? null) : "unknown";
  const steps = view?.count?.systemValidated ? STEPS.filter(s => s.id !== "review") : STEPS;
  const stepIndex = steps.findIndex((s) => s.id === step);
  const pendingReturns = (view?.segregatedReturns ?? []).reduce((sum, row) => sum + row.quantity, 0);
  const receiptVisible = !!view && view.count !== null && !["DRAFT", "REJECTED"].includes(view.status);
  const isRecipient = !!view && view.workflow.incomingShift?.cashierId === user.id;
  const mayReviewStock = !!view && canKey("handover.accept") && ["OUTGOING_SUBMITTED", "INCOMING_REVIEW"].includes(view.status)
    && isRecipient && !view.workflow.incomingAmbiguous && view.target === "SHIFT_TO_SHIFT";
  const unreviewedLines = view?.count?.lines.filter(line => line.disposition !== "PENDING" && !view.workflow.acknowledgements.some(ack => ack.stockCountLineId === line.id)) ?? [];
  const canReceiveLines = mayReviewStock && unreviewedLines.length > 0;
  // The server already limits these to the current count round, so a dispute from a superseded round cannot appear here.
  const disputedAcks = view?.workflow.acknowledgements.filter(ack => ack.decision === "DISPUTED") ?? [];
  const receivingDisputed = disputedAcks.length > 0;
  const stockReviewReady = !!view?.count && unreviewedLines.length === 0 && !receivingDisputed;
  const disputedNames = (view?.count?.lines ?? []).filter(line => disputedAcks.some(ack => ack.stockCountLineId === line.id)).map(line => line.inventoryItem.name);

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

          {!loading && view && (
            <div className="min-w-0 space-y-4 text-sm">
              <section className="space-y-3 rounded-lg border bg-muted/30 p-3" aria-label="تقدم التسليم">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="font-medium">{view.workflow.branchName} · شيفت #{view.financialSummary?.shiftNumber ?? view.overview.shiftNumber}</p>
                  <Badge>{HANDOVER_STATUS_LABEL[view.status] ?? view.status}</Badge>
                  {view.target && (
                    <Badge className="bg-muted text-foreground hover:bg-muted">
                      {TARGET_LABEL[view.target] ?? view.target}
                    </Badge>
                  )}
                  <span className="flex-1" />
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => void after()}>تحديث</Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  المُسلّم: {view.overview.signatures.outgoingName} · المستلم: {view.workflow.incomingShift?.cashier.name ?? "لم يُحدد بعد"}
                  {view.workflow.incomingShift && ` (شيفت #${view.workflow.incomingShift.shiftNumber})`}
                  {!view.overview.financiallyClosedAt && " · الإقفال المالي غير مسجل"}
                </p>
                <ol className="flex flex-wrap gap-2 text-sm font-medium" aria-label="خطوات التسليم">
                  {steps.map((s, i) => {
                    const state = stepIndex > i ? "done" : stepIndex === i ? "current" : "todo";
                    return (
                      <li
                        key={s.id}
                        aria-current={state === "current" ? "step" : undefined}
                        className={cn(
                          "rounded-full border px-3.5 py-1.5 shadow-xs transition-colors",
                          state === "current" && "border-primary bg-primary text-primary-foreground",
                          state === "done" && TONE_SURFACE.sage,
                          state === "todo" && "text-muted-foreground"
                        )}
                      >
                        {state === "done" ? "✓ " : `${i + 1}. `}{s.label}
                      </li>
                    );
                  })}
                </ol>
                <p className="rounded-lg border border-primary/25 bg-primary/5 px-3 py-2 text-sm font-semibold text-foreground">المطلوب الآن: {step === "receive" && receivingDisputed ? NEXT_STEP.disputed : (NEXT_STEP[step] ?? NEXT_STEP.unknown)}</p>
                {receivingDisputed && step !== "complete" && (
                  // The current dispute outranks any earlier all-clear: the outgoing count may well have matched,
                  // and it still says nothing about what the receiver found.
                  <p role="alert" data-testid="handover-receiving-disputed" className={`rounded-lg border p-3 text-sm font-medium ${TONE_SURFACE.caramel} ${TONE_SIDE.caramel}`}>
                    الاستلام معترض عليه والعهدة لم تكتمل{disputedNames.length > 0 ? `: ${disputedNames.join("، ")}` : ""}.
                    {view.count?.systemValidated ? " جرد المُسلّم كان مطابقًا وتحقّق منه النظام، لكن عدّ المستلم يختلف عمّا سُلّم." : ""}
                  </p>
                )}
                {step === "receive" && !canReceiveLines && !stockReviewReady && !receivingDisputed && (
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
                {step !== "complete" && (
                  <p className="text-xs text-muted-foreground" data-testid="handover-actor-status">
                    {handoverBlockMessage({ status: view.status, countStatus: view.count?.status ?? null, outgoingName: view.overview.signatures.outgoingName, outgoingShiftNumber: view.financialSummary?.shiftNumber ?? view.overview.shiftNumber })}
                  </p>
                )}
                {view.count?.systemValidated && !receivingDisputed && <p role="status" className="text-xs text-emerald-800 dark:text-emerald-200">الكميات مطابقة — تحقّق منها النظام دون توقيع اعتماد من مسؤول.</p>}
                {view.workflow.incomingAmbiguous && <p role="alert" className="text-amber-800 dark:text-amber-200">فيه أكتر من شيفت ممكن يستلم — لازم يتحدد المستلم قبل القبول، والنظام مش هيختار بالنيابة عنك.</p>}
                {step === "review" && !canKey("stock_count.confirm") && <p className="text-xs text-muted-foreground">اعتماد الجرد يحتاج مسؤولًا بصلاحية تأكيد الجرد.</p>}
                {step === "receive" && !view.acknowledged && (
                  // Named rather than left as empty columns: the arriving
                  // custodian counts before they are shown what they were
                  // meant to find.
                  <Badge className="bg-slate-200 text-slate-800 hover:bg-slate-200">
                    كميات المُسلّم تُعرض بعد تسجيل قرارات الاستلام
                  </Badge>
                )}
                {view.status === "REJECTED" && <p role="status">الجرد اترجع للمُسلّم: افتح جرد إعادة التسليم. الجرد القديم وسجل الاعتراض محفوظين ومش هيتحسبوا كدليل مقبول.</p>}

                {canKey("handover.submit") && view.outgoingUserId === user.id && ["DRAFT", "REJECTED"].includes(view.status) && (
                  <div className="flex flex-wrap gap-2">
                    {(!view.count || view.status === "REJECTED") && <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => outgoing("start_count")}
                      data-testid="handover-start-count"
                    >
                      {view.status === "REJECTED" ? "فتح جرد إعادة التسليم" : "فتح جرد التسليم"}
                    </Button>}
                    {view.count?.status === "CONFIRMED" && <Button
                      size="sm"
                      variant="default"
                      disabled={busy || view.status !== "DRAFT" || view.count?.status !== "CONFIRMED"}
                      onClick={() => setConfirmSubmit(true)}
                      data-testid="handover-submit"
                    >
                      تقديم العهدة للمستلم
                    </Button>}
                  </div>
                )}
              </section>

              <div className="grid items-start gap-4 lg:grid-cols-12" data-testid="handover-wide-grid">
              <div className="min-w-0 space-y-4 lg:col-span-7 xl:col-span-8">
              {view.requiredItems.length > 0 && (
                <p className="text-muted-foreground">
                  <span className="font-medium text-foreground">أصناف مطلوب جردها: </span>
                  {view.requiredItems.map((i) => `${i.itemNameSnapshot} (${unitLabel(i.unitSnapshot)})`).join(" · ")}
                </p>
              )}

              {view.count && view.status === "DRAFT" && canKey("stock_count.view") && <StockCountDetail key={view.count.sessionId} embedded expectedBranchId={view.branchId} sessionId={view.count.sessionId} onClose={onClose} onChanged={after} />}
              {view.count === null && (
                <p className="rounded-lg border border-dashed p-4 text-center text-muted-foreground">
                  مفيش جرد مربوط بالتسليم ده لسه
                </p>
              )}
              {canReceiveLines && view.count && <ReceivingSheet key={view.count.sessionId} handoverId={view.handoverId} countSessionId={view.count.sessionId} countVersion={view.count.countVersion} lines={view.count.lines} acknowledgements={view.workflow.acknowledgements} onSaved={after} />}
              {receiptVisible && view.count && !canReceiveLines && (
                <div className="space-y-2">
                  <label className="block">بحث عن صنف<input className="mt-1 h-9 w-full rounded-lg border px-3" aria-label="بحث أصناف الاستلام" value={search} onChange={e => setSearch(e.target.value)} /></label>
                  <div className="max-h-[55vh] overflow-auto rounded-xl border">
                    <Table>
                      <TableHeader className="max-sm:hidden">
                        <TableRow>
                          <TableHead>الصنف</TableHead>
                          <TableHead>الوحدة</TableHead>
                          <TableHead>جرد المُسلّم</TableHead>
                          <TableHead className="text-end">استلام</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {[...view.count.lines].sort((a, b) => reviewPriority(a) - reviewPriority(b)).filter(line => line.inventoryItem.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())).map((line) => (
                          <TableRow key={line.id} data-testid="handover-line-row" className="max-sm:block max-sm:border-b max-sm:py-2">
                            <TableCell className="min-w-36 max-w-56 whitespace-normal font-medium [overflow-wrap:anywhere] max-sm:block max-sm:max-w-none">
                              {line.inventoryItem.name}
                            </TableCell>
                            <TableCell className="text-muted-foreground max-sm:block max-sm:pb-0">{unitLabel(line.unit)}</TableCell>
                            {(() => {
                              const row = receivingRowDisplay(line, view.workflow.acknowledgements.find(ack => ack.stockCountLineId === line.id), view.acknowledged);
                              return <>
                                <TableCell className="min-w-32 whitespace-normal tabular-nums max-sm:block">
                                  <div>العدّ: {row.outgoingCount}</div>
                                  <div className="text-xs text-muted-foreground">الفرق عن المتوقع: {row.outgoingDifference}</div>
                                </TableCell>
                                <TableCell className="min-w-40 whitespace-normal text-end max-sm:block max-sm:text-start">
                                  {row.state === "pending" ? <span className="text-muted-foreground">لم يُسجّل استلام بعد</span> : <>
                                    <div className={row.state === "disputed" ? "font-semibold" : undefined}>{row.state === "disputed" ? "معترض عليه — اطلب إعادة الجرد" : "تم استلام السطر"}</div>
                                    <div className="text-xs text-muted-foreground tabular-nums">عدّ المستلم: {row.incomingCount} · المُسلَّم: {row.handedOver}</div>
                                    <div className="text-xs text-muted-foreground tabular-nums">فرق الاستلام: {row.receivingDifference}</div>
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
              </div>
              <div className="min-w-0 space-y-4 lg:col-span-5 xl:col-span-4">

              {pendingReturns > 0 && (
                // Only shown when something is actually held aside: physical
                // returns during a count freeze stay out of the counted stock.
                <section className="space-y-1 rounded-lg border border-amber-500 p-3">
                  <p className="font-medium">مرتجعات محجوزة أثناء التجميد: {pendingReturns} قطعة</p>
                  <p className="text-xs text-muted-foreground">متتباعش ومتتعدّش في الجرد — بتتضاف بعد التسوية ورفع التجميد.</p>
                  {(view.segregatedReturns ?? []).map(row => <p key={row.id} className="text-xs">إيصال {row.id}: {row.quantity} قطعة — معلّق</p>)}
                  {canKey("inventory.transactions") && <Link href="/inventory" className="text-primary underline">مراجعة المرتجع في المخزون</Link>}
                </section>
              )}

              <HandoverOverview overview={view.overview} />
              </div>
              </div>
            </div>
          )}
      </DetailFrame>
      <ConfirmHandoverAction title="تسليم العهدة للمراجعة والاستلام" open={confirmSubmit} busy={busy} onCancel={() => setConfirmSubmit(false)} onConfirm={() => {setConfirmSubmit(false); void outgoing("submit");}} />


    </>
  );
}
