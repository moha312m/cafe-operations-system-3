"use client";

import { useCallback, useEffect, useState } from "react";
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
import { CountLineRow, type CountLine } from "./count-line-row";
import {
  CONFIRMABLE,
  COUNT_STATUS_LABEL,
  COUNT_TYPE_LABEL,
  OPEN_FOR_CAPTURE,
  type CountStatus,
  type CountType,
} from "./stock-count-labels";

type SessionDetail = {
  id: string;
  branchId: string;
  type: CountType;
  status: CountStatus;
  mode: "BLIND" | "OPEN";
  scopeDerivation: string;
  startedAt: string | null;
  submittedAt: string | null;
  confirmedAt: string | null;
  notes: string | null;
  blind: boolean;
  lines: CountLine[];
};

type PendingAction = {
  kind: "recount" | "accept-variance" | "correction";
  line: CountLine;
};

export function StockCountDetail({
  sessionId,
  onClose,
  onChanged,
}: {
  sessionId: string | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { canKey } = useApp();
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [quantity, setQuantity] = useState("");
  const [reasonCodeId, setReasonCodeId] = useState("");
  const [note, setNote] = useState("");

  const load = useCallback(async () => {
    if (!sessionId) return;
    setLoading(true);
    try {
      const { session } = await api<{ session: SessionDetail }>(
        `/api/stock-counts/${sessionId}`
      );
      setDetail(session);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "تعذّر فتح الجرد");
      setDetail(null);
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

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
      setBusy(false);
    }
  }

  async function submit() {
    if (!detail) return;
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
      setBusy(false);
    }
  }

  async function confirm() {
    if (!detail) return;
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
    const base = `/api/stock-counts/${detail.id}/lines/${pending.line.id}`;
    setBusy(true);
    try {
      if (pending.kind === "recount") {
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
      setBusy(false);
    }
  }

  const needsQuantity = pending?.kind === "recount" || pending?.kind === "correction";
  const needsReason = pending?.kind !== "recount";

  return (
    <>
      <Dialog open={sessionId !== null} onOpenChange={(o) => !o && !busy && onClose()}>
        <DialogContent className="max-h-[88vh] max-w-4xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>تفاصيل الجرد</DialogTitle>
          </DialogHeader>

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
                <div className="ms-auto flex gap-2">
                  {OPEN_FOR_CAPTURE.includes(detail.status) && canKey("stock_count.submit") && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={submit}
                      data-testid="count-submit"
                    >
                      تسليم الجرد
                    </Button>
                  )}
                  {CONFIRMABLE.includes(detail.status) && canKey("stock_count.confirm") && (
                    <Button
                      size="sm"
                      disabled={busy}
                      onClick={confirm}
                      data-testid="count-confirm"
                    >
                      تأكيد الجرد
                    </Button>
                  )}
                </div>
              </div>

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
                    {detail.lines.map((line) => (
                      <CountLineRow
                        key={line.id}
                        line={line}
                        sessionStatus={detail.status}
                        blind={detail.blind}
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
        </DialogContent>
      </Dialog>

      {/* One small form for the three line actions that need more than a
          click. The reason code is typed as an id because no endpoint lists
          reason codes — see the note in the page header. */}
      <Dialog open={pending !== null} onOpenChange={(o) => !o && !busy && setPending(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>
              {pending?.kind === "recount"
                ? "إعادة عد"
                : pending?.kind === "accept-variance"
                  ? "اعتماد الفرق"
                  : "طلب تصحيح"}
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
                <Label>معرّف سبب المخزون (reasonCodeId)</Label>
                <Input
                  value={reasonCodeId}
                  onChange={(e) => setReasonCodeId(e.target.value)}
                  placeholder="reasonCodeId"
                />
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
