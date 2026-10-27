"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { StockCountDetail } from "@/components/stock-counts/stock-count-detail";
import { DetailFrame, ConfirmHandoverAction } from "./detail-frame";
import { HandoverOverview, type Overview } from "./handover-overview";
import { ReceiptLine } from "./receipt-line";
import { api } from "@/lib/client";
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
  inventoryItem: { id: string; name: string; category: string | null; unit: string };
  countedQuantity?: string | null;
  effectiveCountedQuantity?: string | null;
  expectedQuantity?: string | null;
  varianceQuantity?: string | null;
};

type HandoverView = {
  overview: Overview;
  workflow: { branchName: string; acknowledgements: { stockCountLineId: string; decision: string }[]; incomingShift: { id: string; shiftNumber: number; cashierId: string; cashier: { name: string } } | null; incomingAmbiguous: boolean };
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
    lines: HandoverLine[];
  } | null;
};

export function HandoverDetail({
  handoverId,
  onClose,
  onChanged,
  embedded = false,
  expectedBranchId,
  reviewSessionId,
}: {
  embedded?: boolean;
  expectedBranchId?: string;
  reviewSessionId?: string | null;
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

  async function acknowledge(ackLine: HandoverLine, spotCount: string, disputeReasonCodeId: string, disputeNote: string) {
    if (!view || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      const res = await api<{
        handedOverQuantity: number;
        varianceQuantity: number | null;
        decision: "ACCEPTED" | "DISPUTED";
      }>(`/api/handovers/${view.handoverId}/acknowledge`, {
        method: "POST",
        body: {
          stockCountLineId: ackLine.id,
          // Empty means "signed without counting", which the server records
          // as a NULL variance. Sending 0 would claim a count of nothing.
          incomingCountedQuantity:
            spotCount.trim() === "" ? undefined : Number(spotCount),
          disputeReasonCodeId: disputeReasonCodeId.trim() || undefined,
          disputeNote: disputeNote.trim() || undefined,
        },
      });
      toast.success(
        res.decision === "DISPUTED" ? "اتسجل اعتراض على السطر" : "اتسجل استلام السطر"
      );
      // The first acknowledgement changes what the server will disclose, so
      // the whole view is re-read rather than patched.
      await after();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "تعذّر تسجيل الاستلام");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

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

  return (
    <>
      <DetailFrame embedded={embedded} open={handoverId !== null} busy={busy} title="تسليم الشيفت" onClose={onClose}>

          {loading && <p className="text-sm text-muted-foreground">جاري التحميل…</p>}
          {error && <p role="alert" className="rounded-lg border p-3 text-sm">{error}. إذا كان التسليم مسودة لشخص آخر، يراجع المسؤول الجرد بصلاحيته الحالية، ثم يعود المُسلّم لتسليم العهدة للمراجعة. لم نغير أي حالة.</p>}
          {!view && reviewSessionId && canKey("stock_count.confirm") && canKey("stock_count.view") && <StockCountDetail key={reviewSessionId} embedded expectedBranchId={expectedBranchId} sessionId={reviewSessionId} onClose={onClose} onChanged={onChanged} />}

          {!loading && view && (
            <div className="min-w-0 space-y-4 text-sm">
              <section className="space-y-3 rounded-lg bg-muted/30 p-3" aria-label="تقدم التسليم">
                <p className="font-medium">{view.workflow.branchName} · تسليم شيفت #{view.financialSummary?.shiftNumber} — {view.overview.financiallyClosedAt ? "الإقفال المالي مكتمل" : "الإقفال المالي غير مسجل"}، حالة العهدة: {HANDOVER_STATUS_LABEL[view.status]}</p>
                <p>المُسلّم: {view.overview.signatures.outgoingName}. المستلم المنتظر: {view.workflow.incomingShift?.cashier.name ?? "غير محدد"}{view.workflow.incomingShift && ` — شيفت #${view.workflow.incomingShift.shiftNumber}`}. جميع الأقسام هنا؛ أكمل المتطلبات غير المنجزة دون الانتقال إلى معالج خطوات.</p>
                {view.workflow.incomingAmbiguous && <p role="alert">يوجد أكثر من شيفت مستلم؛ يلزم تحديد المستلم وفق الإجراء القائم قبل القبول. لن نختار نيابة عنك.</p>}
                {!canKey("stock_count.confirm") && <p>اعتماد الجرد يحتاج مسؤولًا بصلاحية تأكيد الجرد؛ لا يمنحك عرض الصفحة هذه الصلاحية.</p>}
                <p className="text-muted-foreground">الكميات الفعلية لا تُملأ تلقائيًا. المتوقع والفروق يظهران عند نقطة الإفصاح المسموحة فقط؛ لن نُظهر هدف الجرد الأعمى قبلها.</p>
                <Button size="sm" variant="outline" disabled={busy} onClick={() => void after()}>تحديث الحالة</Button>
              </section>
              <div className="flex flex-wrap items-center gap-2">
                <Badge>{HANDOVER_STATUS_LABEL[view.status] ?? view.status}</Badge>
                {view.target && (
                  <Badge className="bg-muted text-foreground hover:bg-muted">
                    {TARGET_LABEL[view.target] ?? view.target}
                  </Badge>
                )}
                {!view.acknowledged && (
                  // Named rather than left as empty columns: the arriving
                  // custodian counts before they are shown what they were
                  // meant to find.
                  <Badge className="bg-slate-200 text-slate-800 hover:bg-slate-200">
                    الكميات مخفية لحد أول استلام سطر
                  </Badge>
                )}
              </div>

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
                  <Button
                    size="sm"
                    variant="default"
                    disabled={busy || view.status !== "DRAFT" || view.count?.status !== "CONFIRMED"}
                    onClick={() => setConfirmSubmit(true)}
                    data-testid="handover-submit"
                  >
                    تأكيد تقديم عهدة الشيفت
                  </Button>
                </div>
              )}

              <HandoverOverview overview={view.overview} />
              <section className="rounded border border-amber-500 p-3 text-sm">
                <p>المرتجعات المادية أثناء التجميد تُحفظ منفصلة. لا تبيعها ولا تدخلها في كمية الجرد. تُضاف بعد التسوية ورفع التجميد.</p>
                {canKey("inventory.transactions") && <Link href="/inventory" className="text-primary underline">تسجيل ومراجعة مرتجع مادي في المخزون</Link>}
                <p>المعلّق الآن: {(view.segregatedReturns ?? []).reduce((sum, row) => sum + row.quantity, 0)} قطعة — التقييم ينتظر الاستهلاك الأصلي.</p>
                {(view.segregatedReturns ?? []).map(row => <p key={row.id}>إيصال {row.id}: {row.quantity} قطعة — معلّق</p>)}
              </section>
              {view.requiredItems.length > 0 && (
                <div className="rounded-lg border bg-muted/20 p-3">
                  <p className="mb-1 font-medium">أصناف مطلوب جردها</p>
                  <p className="text-muted-foreground">
                    {view.requiredItems.map((i) => `${i.itemNameSnapshot} (${i.unitSnapshot})`).join(" · ")}
                  </p>
                </div>
              )}

              {view.status === "REJECTED" && <p role="status">الجرد السابق أُعيد للمُسلّم. افتح جرد إعادة التسليم؛ سيُحفظ الجرد القديم وسجل الاعتراض ولن نعيد استخدامه كدليل مقبول.</p>}
              {view.count && view.status === "DRAFT" && canKey("stock_count.view") && <StockCountDetail key={view.count.sessionId} embedded expectedBranchId={view.branchId} sessionId={view.count.sessionId} onClose={onClose} onChanged={after} />}
              <label className="block">بحث عن صنف<input className="mt-1 h-9 w-full rounded-lg border px-3" aria-label="بحث أصناف الاستلام" value={search} onChange={e => setSearch(e.target.value)} /></label>
              {view.count === null ? (
                <p className="rounded-lg border border-dashed p-4 text-center text-muted-foreground">
                  مفيش جرد مربوط بالتسليم ده
                </p>
              ) : !["DRAFT", "REJECTED"].includes(view.status) ? (
                <div className="overflow-x-auto rounded-xl border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>الصنف</TableHead>
                        <TableHead>الوحدة</TableHead>
                        <TableHead>المعدود</TableHead>
                        <TableHead>الفرق</TableHead>
                        <TableHead className="text-end">استلام</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {view.count.lines.filter(line => line.inventoryItem.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())).map((line) => (
                        <TableRow key={line.id} data-testid="handover-line-row">
                          <TableCell className="font-medium">
                            {line.inventoryItem.name}
                          </TableCell>
                          <TableCell className="text-muted-foreground">{line.unit}</TableCell>
                          <TableCell className="tabular-nums">
                            {view.acknowledged ? (line.countedQuantity ?? "—") : "مخفي"}
                          </TableCell>
                          <TableCell className="tabular-nums">
                            {view.acknowledged ? (line.varianceQuantity ?? "—") : "مخفي"}
                          </TableCell>
                          <TableCell className="text-end">
                            {view.workflow.acknowledgements.filter(ack => ack.stockCountLineId === line.id).map(ack => <span key={ack.stockCountLineId}>{ack.decision === "DISPUTED" ? "معترض عليه — اطلب إعادة الجرد" : "تم استلام السطر"}</span>)}
                            {canKey("handover.accept") && ["OUTGOING_SUBMITTED", "INCOMING_REVIEW"].includes(view.status) && (view.outgoingUserId !== user.id || user.role === "CAFE_OWNER") && !view.workflow.acknowledgements.some(ack => ack.stockCountLineId === line.id) && (
                              <ReceiptLine name={line.inventoryItem.name} busy={busy} onConfirm={(q,r,n) => acknowledge(line,q,r,n)} />
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              ) : null}
              {(["OUTGOING_SUBMITTED", "INCOMING_REVIEW"] as string[]).includes(view.status) && <HandoverActionBar key={view.handoverId} handoverId={view.handoverId} allowReceive={(view.outgoingUserId !== user.id || user.role === "CAFE_OWNER") && !view.workflow.incomingAmbiguous && view.target === "SHIFT_TO_SHIFT"} onDone={async () => {
                try {
                  if (canKey("shifts.view_current")) await api(`/api/shifts/active?branchId=${encodeURIComponent(view.branchId)}`);
                } catch {
                  toast.warning("تم حفظ الإجراء؛ تعذّر تحديث الشيفت الآن. حدّث نقطة البيع للتحقق من جاهزيته.");
                } finally {
                  await after(); router.refresh();
                }
              }} />}
            </div>
          )}
      </DetailFrame>
      <ConfirmHandoverAction title="تسليم العهدة للمراجعة والاستلام" open={confirmSubmit} busy={busy} onCancel={() => setConfirmSubmit(false)} onConfirm={() => {setConfirmSubmit(false); void outgoing("submit");}} />


    </>
  );
}
