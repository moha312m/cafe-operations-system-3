"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { api, money } from "@/lib/client";
import { useApp } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  CLOSING_STATUSES,
  LEGAL_NEXT,
  STATUS_LABEL,
  TYPE_LABEL,
  keyForTarget,
  type VarianceStatus,
  type VarianceType,
} from "./variance-labels";
import { CONFIDENCE_LABEL, NO_REASON, formatVarianceRow, type VarianceRow } from "./variance-format";
import { DifferenceCell, figure } from "./variance-list";

type CaseDetail = VarianceRow & {
  type: VarianceType;
  status: VarianceStatus;
  financialImpactUnavailableReason: string | null;
  confidence: "VERIFIED" | "PARTIAL" | "UNVERIFIABLE";
  assignedResponsibilityUserId: string | null;
  assignedResponsibility: {id:string;name:string}|null;
  resolvedAt: string | null;
  resolutionNote: string | null;
  openedBy: { id: string; name: string } | null;
  resolvedBy: { id: string; name: string } | null;
};

export function VarianceDetail({
  caseId,
  onClose,
  onAdvanced,
}: {
  caseId: string | null;
  onClose: () => void;
  onAdvanced: () => void;
}) {
  const { canKey, cafe } = useApp();
  const [detail, setDetail] = useState<CaseDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [assignee, setAssignee] = useState("");
  const [candidates,setCandidates]=useState<Array<{id:string;name:string}>>([]);

  const load = useCallback(async () => {
    if (!caseId) return;
    setLoading(true);
    try {
      const { case: found, responsibilityCandidates } = await api<{ case: CaseDetail;responsibilityCandidates:Array<{id:string;name:string}> }>(`/api/variances/${caseId}`);
      setDetail(found);
      setCandidates(responsibilityCandidates);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "تعذّر فتح الحالة");
      setDetail(null);
    } finally {
      setLoading(false);
    }
  }, [caseId]);

  useEffect(() => {
    setNote("");
    setAssignee("");
    load();
  }, [load]);

  async function advance(to: VarianceStatus) {
    if (!detail) return;
    setBusy(true);
    try {
      await api(`/api/variances/${detail.id}/advance`, {
        method: "POST",
        body: {
          to,
          note: note.trim() || undefined,
          assignedResponsibilityUserId: to==="RESPONSIBILITY_ASSIGNED"?assignee.trim()||undefined:undefined,
        },
      });
      toast.success(`الحالة بقت «${STATUS_LABEL[to]}»`);
      // The new status is read back from the server rather than assumed: the
      // service writes resolvedAt/resolvedBy of its own accord, and a locally
      // patched row would show a case nobody saved.
      await load();
      onAdvanced();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "تعذّر تحديث الحالة");
    } finally {
      setBusy(false);
    }
  }

  const moves = detail ? LEGAL_NEXT[detail.status] ?? [] : [];
  const currency = cafe?.currency ?? "EGP";
  const f = detail ? formatVarianceRow(detail) : null;
  const shift = detail ? (detail.type === "CASH" ? detail.cashShift ?? detail.shift : detail.shift ?? detail.cashShift) ?? null : null;
  const handover = detail?.acceptedHandover ?? null;

  return (
    <Dialog open={caseId !== null} onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>تفاصيل حالة الفرق</DialogTitle>
        </DialogHeader>

        {loading && <p className="text-sm text-muted-foreground">جاري التحميل…</p>}

        {!loading && detail && (
          <div className="space-y-4 text-sm">
            {f && <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border bg-muted/30 p-3" data-testid="variance-context">
              <span className="font-semibold">{f.branchName ?? "—"}</span>
              {shift && <Link className="text-primary underline" href={`/reports/shift/${shift.id}`} target="_blank">شيفت #{shift.shiftNumber}</Link>}
              {shift && <span>الكاشير: {shift.cashier.name}</span>}
              {handover && <span>{handover.outgoingUser?.name ?? "—"} ← {handover.incomingUser?.name ?? (handover.target === "BRANCH_CUSTODY" ? "عهدة الفرع" : "—")}</span>}
              <span className="text-muted-foreground">{new Date(f.date).toLocaleString("ar-EG", { dateStyle: "medium", timeStyle: "short" })}</span>
            </div>}

            {f && <div className="grid gap-2 sm:grid-cols-3" data-testid="variance-figures">
              <div className="rounded-lg border bg-background p-2.5">
                <div className="text-xs text-muted-foreground">المتوقع</div>
                <div className="mt-0.5 font-bold tabular-nums">{figure(f, f.expected, currency)}</div>
                {f.openingCash !== null && <div className="mt-0.5 text-xs text-muted-foreground">منها رصيد افتتاح الدرج {money(f.openingCash, currency)}</div>}
              </div>
              <div className="rounded-lg border bg-background p-2.5">
                <div className="text-xs text-muted-foreground">الفعلي</div>
                <div className="mt-0.5 font-bold tabular-nums">{figure(f, f.actual, currency)}</div>
              </div>
              <div className="rounded-lg border bg-background p-2.5">
                <div className="text-xs text-muted-foreground">الفرق</div>
                <div className="mt-0.5"><DifferenceCell f={f} currency={currency} /></div>
              </div>
            </div>}

            {f && !f.isMoney && <p className="rounded-lg border bg-amber-500/5 p-2.5" data-testid="variance-stock-impact">
              الأثر المالي التقديري: <strong className="tabular-nums">{f.costImpact !== null ? money(f.costImpact, currency) : `غير متاح${detail.financialImpactUnavailableReason ? ` (${detail.financialImpactUnavailableReason})` : ""}`}</strong>
            </p>}

            <div className="rounded-lg border p-2.5" data-testid="variance-reason">
              <div className="text-xs text-muted-foreground">سبب الموظف</div>
              <p className={f?.reason === NO_REASON ? "text-muted-foreground" : "font-medium"}>{f?.reason ?? NO_REASON}</p>
            </div>

            <dl className="space-y-1.5 rounded-lg border bg-muted/30 p-3">
              {[
                ["النوع", f?.typeLabel ?? TYPE_LABEL[detail.type] ?? detail.type],
                ["الحالة", STATUS_LABEL[detail.status] ?? detail.status],
                ["درجة الثقة", CONFIDENCE_LABEL[detail.confidence] ?? detail.confidence],
                ["الموظف المسؤول", f?.employeeName ?? "غير محدد"],
                ["فتحها", detail.openedBy?.name ?? "—"],
                ["المسؤول المعتمد",detail.assignedResponsibility?.name??"لم تعتمد المسؤولية"],
                ...(detail.resolvedBy ? [["قرّرها", detail.resolvedBy.name]] : []),
              ].map(([label, value]) => (
                <div key={label} className="flex justify-between gap-3">
                  <dt className="text-muted-foreground">{label}</dt>
                  <dd className="font-medium">{value}</dd>
                </div>
              ))}
            </dl>

            {detail.custodyPeriod?.participants && detail.custodyPeriod.participants.length > 0 && <p className="text-xs text-muted-foreground" data-testid="variance-custody">
              العهدة: {detail.custodyPeriod.participants.map((p) => `${p.user.name} (${p.role === "PRIMARY" ? "مسؤول أساسي" : "مشارك"})`).join("، ")}
            </p>}

            {detail.resolutionNote && (
              <p className="rounded-lg border bg-muted/20 p-3 text-muted-foreground">
                {detail.resolutionNote}
              </p>
            )}

            {moves.length === 0 ? (
              <p className="text-muted-foreground">الحالة دي مقفولة — مفيش خطوات تانية.</p>
            ) : (
              <div className="space-y-3">
                <div className="space-y-2">
                  <Label>ملاحظة {/* required by the server for a closing move */}</Label>
                  <Textarea
                    rows={2}
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    placeholder="لازم تكتب سبب عند إقفال الحالة"
                  />
                </div>

                {moves.includes("RESPONSIBILITY_ASSIGNED") && (
                  <div className="space-y-2">
                    <Label>الموظف المسؤول</Label>
                    <select aria-label="الموظف المسؤول" className="w-full rounded-md border bg-background p-2" value={assignee} onChange={e=>setAssignee(e.target.value)}>
                      <option value="">اختار الموظف</option>{candidates.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}
                    </select>
                  </div>
                )}

                <div className="flex flex-wrap gap-2">
                  {moves.map((to) => {
                    // Two different powers: investigating a case and ending
                    // one. The button is drawn only for the key its own
                    // target costs, and the route re-checks the same thing.
                    const allowed = canKey(keyForTarget(to));
                    if (!allowed) return null;
                    const closing = CLOSING_STATUSES.includes(to);
                    return (
                      <Button
                        key={to}
                        size="sm"
                        variant={closing ? "default" : "outline"}
                        disabled={busy || (closing && note.trim() === "") || (to==="RESPONSIBILITY_ASSIGNED" && (assignee.trim()==="" || detail.confidence!=="VERIFIED"))}
                        onClick={() => advance(to)}
                        data-testid={`variance-advance-${to}`}
                      >
                        {STATUS_LABEL[to]}
                      </Button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
