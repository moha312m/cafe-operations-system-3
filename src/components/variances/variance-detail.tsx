"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { api, money } from "@/lib/client";
import { useApp } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
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

type CaseDetail = {
  id: string;
  type: VarianceType;
  status: VarianceStatus;
  quantityVariance: string | null;
  amountVariance: string | null;
  financialImpact: string | null;
  financialImpactAvailable: boolean;
  financialImpactUnavailableReason: string | null;
  confidence: "VERIFIED" | "PARTIAL" | "UNVERIFIABLE";
  assignedResponsibilityUserId: string | null;
  blocking: boolean;
  openedAt: string;
  resolvedAt: string | null;
  resolutionNote: string | null;
  stockCountLine: {
    id: string;
    disposition: string;
    expectedQuantity: string | null;
    countedQuantity: string | null;
    varianceQuantity: string | null;
    inventoryItem: { id: string; name: string; unit: string; category: string | null };
  } | null;
  shift: { id: string; shiftNumber: number; status: string } | null;
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

  const load = useCallback(async () => {
    if (!caseId) return;
    setLoading(true);
    try {
      const { case: found } = await api<{ case: CaseDetail }>(`/api/variances/${caseId}`);
      setDetail(found);
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
          assignedResponsibilityUserId: assignee.trim() || undefined,
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

  return (
    <Dialog open={caseId !== null} onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>تفاصيل حالة الفرق</DialogTitle>
        </DialogHeader>

        {loading && <p className="text-sm text-muted-foreground">جاري التحميل…</p>}

        {!loading && detail && (
          <div className="space-y-4 text-sm">
            <dl className="space-y-1.5 rounded-lg border bg-muted/30 p-3">
              {[
                ["النوع", TYPE_LABEL[detail.type] ?? detail.type],
                ["الحالة", STATUS_LABEL[detail.status] ?? detail.status],
                ["درجة الثقة", detail.confidence],
                ["فرق الكمية", detail.quantityVariance ?? "—"],
                [
                  "الأثر المالي",
                  detail.financialImpactAvailable && detail.financialImpact !== null
                    ? money(detail.financialImpact, cafe?.currency ?? "EGP")
                    : `غير متاح${
                        detail.financialImpactUnavailableReason
                          ? ` (${detail.financialImpactUnavailableReason})`
                          : ""
                      }`,
                ],
                ["الصنف", detail.stockCountLine?.inventoryItem.name ?? "—"],
                ["الوردية", detail.shift ? `#${detail.shift.shiftNumber}` : "—"],
                ["فتحها", detail.openedBy?.name ?? "—"],
              ].map(([label, value]) => (
                <div key={label} className="flex justify-between gap-3">
                  <dt className="text-muted-foreground">{label}</dt>
                  <dd className="font-medium">{value}</dd>
                </div>
              ))}
            </dl>

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
                    <Label>معرّف الموظف المسؤول</Label>
                    <Input
                      value={assignee}
                      onChange={(e) => setAssignee(e.target.value)}
                      placeholder="userId"
                    />
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
                        disabled={busy || (closing && note.trim() === "")}
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
