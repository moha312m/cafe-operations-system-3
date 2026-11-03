"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { TONE_SURFACE } from "@/components/ui/tone";
import { ReasonCodeSelect } from "./reason-code-select";
import { CountLineRow, type CountLine } from "./count-line-row";
import { CountEntryQueue } from "./count-entry-queue";
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
  handoverId?: string | null;
  systemValidated?: boolean;
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
  const [filterTab, setFilterTab] = useState<string>("all");
  const tableWrapRef = useRef<HTMLDivElement | null>(null);
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [quantity, setQuantity] = useState("");
  const [reasonCodeId, setReasonCodeId] = useState("");
  const [note, setNote] = useState("");
  const inFlight = useRef(false);
  const [confirmation, setConfirmation] = useState<"submit" | "confirm" | null>(null);
  const [, redrawEntries] = useState(0);
  const loadRevision = useRef(0);
  const queue = useMemo(() => new CountEntryQueue(async (lineId, value, expectedCountedAt) => {
    const { session, line } = await api<{ session: SessionDetail; line: CountLine }>(`/api/stock-counts/${sessionId}/lines/${lineId}`, {
      method: "PATCH", body: { countedQuantity: value, expectedCountedAt },
    });
    if (!line || line.id !== lineId || session.id !== sessionId) throw new Error("تعذّر التحقق من حفظ الكمية — أعد المحاولة");
    // A row response owns only that row. Other drafts and newer session state survive.
    setDetail(current => current?.id === sessionId ? {
      ...current,
      status: current.status === "DRAFT" && session.status === "IN_PROGRESS" ? "IN_PROGRESS" : current.status,
      lines: current.lines.map(row => row.id === lineId ? line : row),
    } : current);
    return line;
  }, () => redrawEntries(version => version + 1), async lineId => {
    const { session } = await api<{ session: SessionDetail }>(`/api/stock-counts/${sessionId}`);
    const line = session.lines.find(row => row.id === lineId);
    if (session.id !== sessionId || !line) throw new Error("تعذّر تحديث سطر الجرد");
    setDetail(current => current?.id === sessionId ? { ...current, status: session.status, lines: current.lines.map(row => row.id === lineId ? line : row) } : current);
    return line;
  }), [sessionId]);


  const load = useCallback(async () => {
    if (!sessionId) return;
    const revision = ++loadRevision.current;
    if (!embedded) setLoading(true);
    try {
      const { session } = await api<{ session: SessionDetail }>(
        `/api/stock-counts/${sessionId}`
      );
      if (expectedBranchId && session.branchId !== expectedBranchId) throw new Error("الجرد لا يخص الفرع المحدد — حدّث الحالة");
      if (revision !== loadRevision.current) return;
      queue.reconcile(session.lines);
      setDetail(current => current?.id === session.id ? { ...session, lines: session.lines.map(line => {
        const previous = current.lines.find(row => row.id === line.id);
        return previous?.countedAt && (!line.countedAt || Date.parse(previous.countedAt) > Date.parse(line.countedAt)) ? previous : line;
      }) } : session);
    } catch (e) {
      if (revision !== loadRevision.current) return;
      toast.error(e instanceof Error ? e.message : "تعذّر فتح الجرد");
      setDetail(null);
    } finally {
      if (revision === loadRevision.current) setLoading(false);
    }
  }, [sessionId, embedded, expectedBranchId, queue]);

  useEffect(() => {
    setDetail(null);
    setSearch("");
    load();
    return () => { loadRevision.current += 1; };
  }, [load]);

  // Every mutation ends the same way: ask the server what the session looks
  // like now. Dispositions, session status and the blind flag are all the
  // service's conclusions, and a locally patched row would be a count nobody
  // recorded.
  const after = useCallback(async () => {
    await load();
    onChanged();
  }, [load, onChanged]);

  function editQuantity(lineId: string, value: string) {
    if (!inFlight.current) queue.edit(lineId, value);
  }
  function saveQuantity(lineId: string) {
    if (!inFlight.current) void queue.save(lineId);
  }

  async function submit() {
    if (!detail) return;
    if (inFlight.current || !queue.canSubmit(detail.accountabilityContext === "HANDOVER")) return;
    inFlight.current = true;
    setBusy(true);
    try {
      const res = await api<{ status: string; within: number; outside: number; systemValidated?: boolean }>(
        `/api/stock-counts/${detail.id}/submit`,
        { method: "POST" }
      );
      toast.success(res.systemValidated ? "الكميات متطابقة — تحقّق النظام من الجرد؛ قدّم العهدة للمستلم" : detail.accountabilityContext === "HANDOVER" ? "اتسلّم الجرد — الفروق أو النواقص تحتاج مراجعة المسؤول" : `اتسلّم الجرد · داخل السماحية ${res.within} · خارجها ${res.outside}`);
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
    if (inFlight.current || !queue.canSubmit()) return;
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
    if (inFlight.current || !queue.canSubmit()) return;
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
  const isHandover = detail?.accountabilityContext === "HANDOVER";
  const compactCapture = isHandover && !!detail && ["DRAFT", "IN_PROGRESS"].includes(detail.status);
  const captureBlocked = !queue.canSubmit(!!isHandover);
  const sortedLines = [...(detail?.lines ?? [])].sort((a, b) => {
    const priority = (line: CountLine) => line.countedQuantity === null ? 0 : line.varianceQuantity != null && Number(line.varianceQuantity) !== 0 ? 1 : 2;
    return compactCapture ? 0 : priority(a) - priority(b);
  });


  return (
    <>
      <DetailFrame embedded={embedded} hideBack={embedded} open={sessionId !== null} busy={busy || !queue.canSubmit()} title="العد ومراجعة الجرد" onClose={onClose}>

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
                      disabled={busy || captureBlocked}
                      onClick={() => { if (queue.canSubmit(!!isHandover)) { if (isHandover) void submit(); else setConfirmation("submit"); } }}
                      data-testid="count-submit"
                    >
                      {isHandover ? "إنهاء العد والتحقق" : "تسليم الجرد"}
                    </Button>
                  )}
                  {CONFIRMABLE.includes(detail.status) && canKey("stock_count.confirm") && (
                    <Button
                      size="sm"
                      disabled={busy || !queue.canSubmit()}
                      onClick={() => setConfirmation("confirm")}
                      data-testid="count-confirm"
                    >
                      تأكيد الجرد
                    </Button>
                  )}
                </div>
              </div>

              {isHandover && detail.systemValidated && <p role="status" className={`rounded-lg border p-3 ${TONE_SURFACE.sage}`}>الكميات متطابقة — تحقّق النظام من هذا الإصدار دون اعتماد مدير.</p>}
              {isHandover && CONFIRMABLE.includes(detail.status) && <p role="status" className="rounded-lg border p-3">النواقص والفروق ظاهرة أولًا. يعتمد الفروق مسؤول بصلاحية تأكيد الجرد؛ التطابق داخل السماحية وحده لا يعفي الفرق من المراجعة.</p>}
              {compactCapture && <p className="text-xs text-muted-foreground">أدخل الكمية ثم اضغط Enter أو انتقل للخانة التالية للحفظ. الفراغ يعني أن الصنف لم يُعدّ؛ أدخل صفرًا فقط إذا عدَدته وكانت كميته صفرًا.</p>}
              <div className="flex flex-wrap items-center gap-2 rounded-xl border bg-muted p-1" data-testid="count-filter-tabs">
                <Button type="button" size="sm" variant={filterTab === "all" ? "default" : "outline"} onClick={() => setFilterTab("all")}>الكل ({detail.lines.length})</Button>
                <Button type="button" size="sm" variant={filterTab === "uncounted" ? "default" : "outline"} onClick={() => setFilterTab("uncounted")}>لم يُجرد بعد ({detail.lines.filter(l => (queue.get(l.id)?.status ?? (l.countedQuantity === null ? "empty" : "saved")) === "empty").length})</Button>
                <Button type="button" size="sm" variant={filterTab === "critical" ? "default" : "outline"} onClick={() => setFilterTab("critical")}>الأصناف الحرجة ({detail.lines.filter(l => l.inventoryItem.isCritical).length})</Button>
                {Array.from(new Set(detail.lines.map(l => l.inventoryItem.category).filter((c): c is string => !!c))).map(cat => (
                  <Button key={cat} type="button" size="sm" variant={filterTab === `cat:${cat}` ? "default" : "outline"} onClick={() => setFilterTab(`cat:${cat}`)}>{cat}</Button>
                ))}
                {OPEN_FOR_CAPTURE.includes(detail.status) && canKey("stock_count.submit") && (
                  <Button type="button" size="sm" variant="secondary" className="ms-auto" data-testid="count-next-uncounted" onClick={() => {
                    setFilterTab("all");
                    setSearch("");
                    setTimeout(() => {
                      const inputs = Array.from(tableWrapRef.current?.querySelectorAll<HTMLInputElement>('input[inputmode="decimal"]') ?? []);
                      const emptyInput = inputs.find(inp => inp.value.trim() === "");
                      (emptyInput ?? inputs[0])?.focus();
                    }, 0);
                  }}>الصنف التالي غير المعدود</Button>
                )}
              </div>
              <label className="block">بحث الأصناف<Input aria-label="بحث أصناف الجرد" value={search} onChange={e => setSearch(e.target.value)} /></label>
              {(() => {
                const savedCount = detail.lines.filter(line => queue.get(line.id)?.status === "saved").length;
                const total = detail.lines.length;
                const percent = total === 0 ? 0 : Math.round((savedCount / total) * 100);
                return <div className="surface-espresso space-y-2 rounded-2xl p-4" data-testid="stock-count-progress-banner">
                  <p className="text-sm font-semibold">المحفوظ: {savedCount} / {total} صنف.</p>
                  <div role="progressbar" aria-label="تقدم الجرد" aria-valuemin={0} aria-valuemax={total} aria-valuenow={savedCount} className="h-2 overflow-hidden rounded-full bg-white/15" data-testid="stock-count-progress-bar">
                    <div className="h-full rounded-full bg-gradient-to-r from-emerald-300 to-amber-200 transition-[width] duration-300" style={{ width: `${percent}%` }} />
                  </div>
                </div>;
              })()}
              {captureBlocked && OPEN_FOR_CAPTURE.includes(detail.status) && <p role="status" className="text-xs text-muted-foreground">أكمل الكميات واحفظ التعديلات قبل إنهاء العد. عند فشل الحفظ تبقى الكمية في خانتها لإعادة المحاولة.</p>}
              <div ref={tableWrapRef} className="max-h-[55vh] overflow-auto rounded-xl border">
                <Table>
                  <TableHeader className={compactCapture ? "max-sm:hidden" : undefined}>
                    <TableRow>
                      <TableHead>الصنف</TableHead>
                      <TableHead>الوحدة</TableHead>
                      {compactCapture ? <><TableHead>الكمية الفعلية</TableHead><TableHead>الحفظ</TableHead></> : <>
                        <TableHead>المعدود</TableHead>
                        <TableHead>المتوقع</TableHead>
                        <TableHead>الفرق</TableHead>
                        <TableHead>الحالة</TableHead>
                        <TableHead className="text-end">إجراءات</TableHead>
                      </>}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {sortedLines.filter(line => {
                      if (!line.inventoryItem.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())) return false;
                      if (filterTab === "uncounted") return (queue.get(line.id)?.status ?? (line.countedQuantity === null ? "empty" : "saved")) === "empty";
                      if (filterTab === "critical") return !!line.inventoryItem.isCritical;
                      if (filterTab.startsWith("cat:")) return line.inventoryItem.category === filterTab.slice(4);
                      return true;
                    }).map((line) => (
                      <CountLineRow
                        key={line.id}
                        line={line}
                        sessionStatus={detail.status}
                        blind={detail.blind}
                        handover={detail.accountabilityContext === "HANDOVER"}
                        can={canKey}
                        busy={busy}
                        entry={queue.get(line.id) ?? { value: line.countedQuantity ?? "", status: line.countedQuantity === null ? "empty" : "saved" }}
                        onDraft={editQuantity}
                        onSave={saveQuantity}
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
