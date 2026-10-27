"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import Link from "next/link";
import { ReasonCodeSelect } from "@/components/stock-counts/reason-code-select";
import { api } from "@/lib/client";
import { useApp } from "@/components/app-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
}: {
  handoverId: string | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { canKey, user } = useApp();
  const [view, setView] = useState<HandoverView | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [ackLine, setAckLine] = useState<HandoverLine | null>(null);
  const [spotCount, setSpotCount] = useState("");
  const [disputeReasonCodeId, setDisputeReasonCodeId] = useState("");
  const [disputeNote, setDisputeNote] = useState("");

  const load = useCallback(async () => {
    if (!handoverId) return;
    setLoading(true);
    try {
      const { handover } = await api<{ handover: HandoverView }>(
        `/api/handovers/${handoverId}`
      );
      setView(handover);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "تعذّر فتح التسليم");
      setView(null);
    } finally {
      setLoading(false);
    }
  }, [handoverId]);

  useEffect(() => {
    load();
  }, [load]);

  const after = useCallback(async () => {
    await load();
    onChanged();
  }, [load, onChanged]);

  async function acknowledge() {
    if (!view || !ackLine) return;
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
      setAckLine(null);
      // The first acknowledgement changes what the server will disclose, so
      // the whole view is re-read rather than patched.
      await after();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "تعذّر تسجيل الاستلام");
    } finally {
      setBusy(false);
    }
  }

  async function outgoing(action: "start_count" | "submit") {
    if (!view) return;
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
      setBusy(false);
    }
  }

  return (
    <>
      <Dialog open={handoverId !== null} onOpenChange={(o) => !o && !busy && onClose()}>
        <DialogContent className="max-h-[88vh] max-w-4xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>تفاصيل التسليم</DialogTitle>
          </DialogHeader>

          {loading && <p className="text-sm text-muted-foreground">جاري التحميل…</p>}

          {!loading && view && (
            <div className="space-y-4 text-sm">
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
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => outgoing("start_count")}
                    data-testid="handover-start-count"
                  >
                    فتح جرد التسليم
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => outgoing("submit")}
                    data-testid="handover-submit"
                  >
                    تسليم العهدة
                  </Button>
                </div>
              )}

              {view.financialSummary && <section className="rounded-lg border p-3 space-y-2">
                <h3 className="font-medium">فروق شيفت التسليم — {view.financialSummary.outgoingName} · #{view.financialSummary.shiftNumber}</h3>
                <p>فرق الكاش: {view.financialSummary.cashVariance??"غير مسجل"} · {view.financialSummary.cashReason??"بدون سبب مسجل"}</p>
                {view.financialSummary.tenders.map(t=><p key={t.method}>{t.method==="CARD"?"فيزا":t.method==="WALLET"?"محفظة":t.method}: {t.varianceAmount??"غير مسجل"} · {t.reasonNote??"بدون سبب مسجل"}</p>)}
                {view.financialSummary.cashVerifiedAt&&<p>فرق النقدية عند الاستلام: {view.financialSummary.cashReceiptVariance??"غير متاح"} · المستلم: {view.financialSummary.incomingName}</p>}
                {canKey("variance.view")&&<Link className="text-primary underline" href={"/reports/employee-variances?handoverId="+view.handoverId}>كشف فروق الشيفت والخامات والمسؤولية</Link>}
              </section>}
              {view.requiredItems.length > 0 && (
                <div className="rounded-lg border bg-muted/20 p-3">
                  <p className="mb-1 font-medium">أصناف مطلوب جردها</p>
                  <p className="text-muted-foreground">
                    {view.requiredItems.map((i) => i.itemNameSnapshot).join(" · ")}
                  </p>
                </div>
              )}

              {view.count === null ? (
                <p className="rounded-lg border border-dashed p-4 text-center text-muted-foreground">
                  مفيش جرد مربوط بالتسليم ده
                </p>
              ) : (
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
                      {view.count.lines.map((line) => (
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
                            {canKey("handover.accept") && ["OUTGOING_SUBMITTED", "INCOMING_REVIEW"].includes(view.status) && view.outgoingUserId !== user.id && (
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={busy}
                                onClick={() => {
                                  setSpotCount("");
                                  setDisputeReasonCodeId("");
                                  setDisputeNote("");
                                  setAckLine(line);
                                }}
                                data-testid="handover-acknowledge-line"
                              >
                                استلام السطر
                              </Button>
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}

              {view.count && <Link className="text-primary underline" href={`/stock-counts?sessionId=${view.count.sessionId}`}>فتح الجرد وتسجيل الكميات</Link>}
              {(["OUTGOING_SUBMITTED", "INCOMING_REVIEW"] as string[]).includes(view.status) && <HandoverActionBar handoverId={view.handoverId} onDone={() => { onChanged(); onClose(); }} />}
            </div>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={ackLine !== null} onOpenChange={(o) => !o && !busy && setAckLine(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>استلام سطر</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <p className="text-muted-foreground">{ackLine?.inventoryItem.name}</p>
            <div className="space-y-2">
              <Label>عدّك أنت (سيبها فاضية لو وقّعت من غير عد)</Label>
              <Input
                inputMode="decimal"
                value={spotCount}
                onChange={(e) => setSpotCount(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <ReasonCodeSelect domain="HANDOVER" value={disputeReasonCodeId} onChange={setDisputeReasonCodeId} label="سبب الاعتراض عند وجود فرق" optional />
            </div>
            <div className="space-y-2">
              <Label>ملاحظة</Label>
              <Textarea
                rows={2}
                value={disputeNote}
                onChange={(e) => setDisputeNote(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              className="w-full"
              disabled={busy}
              onClick={acknowledge}
              data-testid="handover-acknowledge-confirm"
            >
              تسجيل الاستلام
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
