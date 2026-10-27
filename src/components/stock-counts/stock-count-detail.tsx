"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/client";
import { useApp } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
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
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ReasonCodeSelect } from "./reason-code-select";
import { CountLineRow, type CountLine } from "./count-line-row";
import {
  CONFIRMABLE,
  COUNT_STATUS_LABEL,
  COUNT_TYPE_LABEL,
  OPEN_FOR_CAPTURE,
  type CountStatus,
  type CountType,
} from "./stock-count-labels";

import { DetailFrame, ConfirmHandoverAction } from "@/components/handovers/detail-frame";

type SessionDetail = {
  id: string;
  branchId: string;
  type: CountType;
  status: CountStatus;
  mode: "BLIND" | "OPEN";
  scopeDerivation: string;
  accountabilityContext: string;
  startedAt: string | null;
  submittedAt: string | null;
  confirmedAt: string | null;
  notes: string | null;
  blind: boolean;
  lines: CountLine[];
};

type PendingAction = {
  kind: "recount" | "accept-variance" | "correction" | "reason";
  line: CountLine;
};

export function StockCountDetail({
  sessionId,
  onClose,
  onChanged,
  embedded = false,
  expectedBranchId,
}: {
  embedded?: boolean;
  expectedBranchId?: string;
  sessionId: string | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { canKey } = useApp();
  const [search, setSearch] = useState("");
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [quantity, setQuantity] = useState("");
  const [reasonCodeId, setReasonCodeId] = useState("");
  const [note, setNote] = useState("");
  const inFlight = useRef(false);
  const [confirmation, setConfirmation] = useState<"submit" | "confirm" | null>(null);

  const load = useCallback(async () => {
    if (!sessionId) return;
    if (!embedded) setLoading(true);
    try {
      const { session } = await api<{ session: SessionDetail }>(
        `/api/stock-counts/${sessionId}`
      );
      if (expectedBranchId && session.branchId !== expectedBranchId) throw new Error("الجرد لا يخص الفرع المحدد — حدّث الحالة");
      setDetail(session);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "تعذّر فتح الجرد");
      setDetail(null);
    } finally {
      setLoading(false);
    }
  }, [sessionId, embedded, expectedBranchId]);

  useEffect(() => {
    load();
  }, [load]);

  // Every mutation ends the same way: ask the server what the session looks
  // like now. Dispositions, session status and the blind flag are all the
  // service's conclusions, and a locally patched row would be a count nobody
  // recorded.
  const after = useCallback(async () => {
    await load();
    onChanged();
  }, [load, onChanged]);

  async function capture(lineId: string, value: number) {
    if (!detail) return;
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      await api(`/api/stock-counts/${detail.id}/lines/${lineId}`, {
        method: "PATCH",
        body: { countedQuantity: value },
      });
      toast.success("اتسجلت الكمية");
      await after();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "تعذّر تسجيل الكمية");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  async function submit() {
    if (!detail) return;
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      const res = await api<{ status: string; within: number; outside: number }>(
        `/api/stock-counts/${detail.id}/submit`,
        { method: "POST" }
      );
      toast.success(`اتسلّم الجرد · داخل السماحية ${res.within} · خارجها ${res.outside}`);
      await after();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "تعذّر تسليم الجرد");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  async function confirm() {
    if (!detail) return;
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      const res = await api<{ alreadyConfirmed: boolean; varianceCaseIds: string[] }>(
        `/api/stock-counts/${detail.id}/confirm`,
        { method: "POST", body: {} }
      );
      toast.success(
        res.alreadyConfirmed
          ? "الجرد كان متأكد قبل كده"
          : `اتأكد الجرد · حالات فروقات: ${res.varianceCaseIds.length}`
      );
      await after();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "تعذّر تأكيد الجرد");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  function startAction(kind: PendingAction["kind"], line: CountLine) {
    setQuantity("");
    setReasonCodeId("");
    setNote("");
    setPending({ kind, line });
  }

  async function runPending() {
    if (!detail || !pending) return;
    if (inFlight.current) return;
    inFlight.current = true;
    const base = `/api/stock-counts/${detail.id}/lines/${pending.line.id}`;
    setBusy(true);
    try {
      if (pending.kind === "reason") {
        await api(`${base}/variance-reason`, { method: "POST", body: { reasonCodeId: reasonCodeId.trim(), note: note.trim() || undefined } });
        toast.success("اتسجل سبب الفرق دون تغيير العد أو حالته");
      } else if (pending.kind === "recount") {
        await api(`${base}/recount`, {
          method: "POST",
          body: { countedQuantity: Number(quantity) },
        });
        toast.success("اتسجلت إعادة العد");
      } else if (pending.kind === "accept-variance") {
        await api(`${base}/accept-variance`, {
          method: "POST",
          body: { reasonCodeId: reasonCodeId.trim(), note: note.trim() || undefined },
        });
        toast.success("اتعتمد الفرق");
      } else {
        await api(`${base}/correction`, {
          method: "POST",
          body: {
            newCountedQuantity: Number(quantity),
            reasonCodeId: reasonCodeId.trim(),
            note: note.trim() || undefined,
          },
        });
        // A correction is a REQUEST. Saying "corrected" here would report an
        // approval that has not happened.
        toast.success("اتسجل طلب التصحيح — مستني الاعتماد");
      }
      setPending(null);
      await after();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "تعذّر تنفيذ الإجراء");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  const needsQuantity = pending?.kind === "recount" || pending?.kind === "correction";
  const needsReason = pending?.kind !== "recount";

  return (
    <>
      <DetailFrame embedded={embedded} hideBack={embedded} open={sessionId !== null} busy={busy} title="العد ومراجعة الجرد" onClose={onClose}>

          {loading && <p className="text-sm text-muted-foreground">جاري التحميل…</p>}

          {!loading && detail && (
            <div className="space-y-4 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <Badge>{COUNT_STATUS_LABEL[detail.status] ?? detail.status}</Badge>
                <Badge className="bg-muted text-foreground hover:bg-muted">
                  {COUNT_TYPE_LABEL[detail.type] ?? detail.type}
                </Badge>
                {detail.blind && (
                  // Said out loud: the counter is not being shown the target,
                  // and an empty column is the design rather than a bug.
                  <Badge className="bg-slate-200 text-slate-800 hover:bg-slate-200">
                    جرد أعمى — المتوقع مخفي عنك
                  </Badge>
                )}
                <div className="ms-auto flex flex-wrap gap-2">
                  {OPEN_FOR_CAPTURE.includes(detail.status) && canKey("stock_count.submit") && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => setConfirmation("submit")}
                      data-testid="count-submit"
                    >
                      تسليم الجرد
                    </Button>
                  )}
                  {CONFIRMABLE.includes(detail.status) && canKey("stock_count.confirm") && (
                    <Button
                      size="sm"
                      disabled={busy}
                      onClick={() => setConfirmation("confirm")}
                      data-testid="count-confirm"
                    >
                      تأكيد الجرد
                    </Button>
                  )}
                </div>
              </div>

              <label className="block">بحث الأصناف<Input aria-label="بحث أصناف الجرد" value={search} onChange={e => setSearch(e.target.value)} /></label>
              <p>المسجل: {detail.lines.filter(line => line.countedQuantity !== null).length} / {detail.lines.length} صنف. الفراغ ليس صفرًا؛ لا يتم تسليم كمية غير مدخلة.</p>
              <div className="overflow-x-auto rounded-xl border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>الصنف</TableHead>
                      <TableHead>الوحدة</TableHead>
                      <TableHead>المعدود</TableHead>
                      <TableHead>المتوقع</TableHead>
                      <TableHead>الفرق</TableHead>
                      <TableHead>الحالة</TableHead>
                      <TableHead className="text-end">إجراءات</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {detail.lines.filter(line => line.inventoryItem.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())).map((line) => (
                      <CountLineRow
                        key={line.id}
                        line={line}
                        sessionStatus={detail.status}
                        blind={detail.blind}
                        handover={detail.accountabilityContext === "HANDOVER"}
                        can={canKey}
                        busy={busy}
                        onCapture={capture}
                        onAct={startAction}
                      />
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>
          )}
      </DetailFrame>
      <ConfirmHandoverAction title={confirmation === "submit" ? "تسليم الجرد للمراجعة" : "اعتماد الجرد"} open={confirmation !== null} busy={busy} onCancel={() => setConfirmation(null)} onConfirm={() => { const action = confirmation; setConfirmation(null); if (action === "submit") void submit(); else if (action === "confirm") void confirm(); }} />

      {/* Line actions use the active reasons configured for this cafe. */}
      <Dialog open={pending !== null} onOpenChange={(o) => !o && !busy && setPending(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>
              {pending?.kind === "recount"
                ? "إعادة عد"
                : pending?.kind === "accept-variance"
                  ? "اعتماد الفرق"
                  : pending?.kind === "reason" ? "تسجيل سبب فرق التسليم" : "طلب تصحيح"}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <p className="text-muted-foreground">{pending?.line.inventoryItem.name}</p>
            {needsQuantity && (
              <div className="space-y-2">
                <Label>الكمية</Label>
                <Input
                  inputMode="decimal"
                  value={quantity}
                  onChange={(e) => setQuantity(e.target.value)}
                />
              </div>
            )}
            {needsReason && (
              <div className="space-y-2">
                <ReasonCodeSelect domain="STOCK" value={reasonCodeId} onChange={setReasonCodeId} label="سبب فرق المخزون" />
              </div>
            )}
            <div className="space-y-2">
              <Label>ملاحظة</Label>
              <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
            </div>
          </div>
          <DialogFooter>
            <Button
              className="w-full"
              disabled={
                busy ||
                (needsQuantity && quantity.trim() === "") ||
                (needsReason && reasonCodeId.trim() === "")
              }
              onClick={runPending}
              data-testid="count-line-action-confirm"
            >
              تنفيذ
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
