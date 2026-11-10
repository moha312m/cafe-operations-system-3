"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useApp } from "@/components/app-shell";

export type PendingCorrection = {
  id: string;
  lineId: string;
  oldCountedQuantity: number | string;
  newCountedQuantity: number | string;
  note: string | null;
  createdAt: string;
  actor: { id: string; name: string; role: string };
  reasonCode: { id: string; code: string; label: string };
  line: {
    id: string;
    unit: string;
    expectedQuantity: number | string | null;
    sessionId: string;
    inventoryItem: { id: string; name: string };
    session: { id: string; handoverId: string | null; branchId: string };
  };
};

export function StockCorrectionsQueue({
  branchId,
  handoverId,
  onUpdated,
}: {
  branchId?: string | null;
  handoverId?: string | null;
  onUpdated?: () => void;
}) {
  const { canKey, user } = useApp();
  const [corrections, setCorrections] = useState<PendingCorrection[]>([]);
  const [busy, setBusy] = useState("");

  const canApprove =
    canKey("stock_count.approve_correction") ||
    user?.role === "CAFE_OWNER" ||
    user?.role === "SUPER_ADMIN";

  const load = useCallback(async () => {
    try {
      const url = branchId
        ? `/api/corrections/pending?branchId=${encodeURIComponent(branchId)}`
        : "/api/corrections/pending";
      const data = await api<{ pendingCorrections: PendingCorrection[] }>(url);
      const filtered = handoverId
        ? data.pendingCorrections.filter((c) => c.line.session.handoverId === handoverId)
        : data.pendingCorrections;
      setCorrections(filtered);
    } catch {
      // Hides quietly if no permission
    }
  }, [branchId, handoverId]);

  useEffect(() => {
    void load();
    const timer = setInterval(load, 12000);
    return () => clearInterval(timer);
  }, [load]);

  async function handleDecision(id: string, action: "approve" | "reject") {
    setBusy(id);
    try {
      await api(`/api/corrections/${id}/${action}`, { method: "POST" });
      toast.success(action === "approve" ? "تم اعتماد تصحيح الكمية بنجاح" : "تم رفض طلب التصحيح");
      await load();
      onUpdated?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "تعذر إتمام الإجراء");
    } finally {
      setBusy("");
    }
  }

  if (corrections.length === 0) return null;

  return (
    <section className="space-y-3" data-testid="stock-corrections-queue">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold text-foreground">
            طلبات تصحيح كميات الجرد والمخزون ({corrections.length})
          </h2>
          <p className="text-xs text-muted-foreground">
            طلبات تصحيح مقدمة من الموظفين بانتظار اعتماد المالك أو المدير.
          </p>
        </div>
        <Badge variant="destructive" className="animate-pulse">
          بانتظار الاعتماد
        </Badge>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {corrections.map((item) => (
          <Card key={item.id} className="border-amber-500/40 bg-amber-500/5 shadow-sm">
            <CardContent className="space-y-2 p-3 text-sm">
              <div className="flex items-center justify-between gap-2">
                <span className="font-semibold text-foreground">
                  {item.line.inventoryItem.name}
                </span>
                <span className="text-xs text-muted-foreground">
                  {new Date(item.createdAt).toLocaleTimeString("ar-EG", {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </span>
              </div>

              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="text-muted-foreground">الكمية السابقة:</span>
                <span className="line-through">{Number(item.oldCountedQuantity)}</span>
                <span className="font-bold text-emerald-700 dark:text-emerald-300">
                  ← المصححة: {Number(item.newCountedQuantity)} {item.line.unit}
                </span>
              </div>

              <div className="rounded bg-muted/60 p-1.5 text-xs text-muted-foreground">
                <p>
                  <strong>السبب:</strong> {item.reasonCode.label}
                </p>
                {item.note && (
                  <p className="mt-0.5">
                    <strong>ملاحظة:</strong> {item.note}
                  </p>
                )}
                <p className="mt-0.5">
                  <strong>مقدم الطلب:</strong> {item.actor.name} ({item.actor.role})
                </p>
              </div>

              {canApprove && (
                <div className="flex items-center gap-2 pt-1">
                  <Button
                    size="sm"
                    className="h-8 flex-1 bg-emerald-600 text-xs font-semibold text-white hover:bg-emerald-700"
                    disabled={busy === item.id}
                    onClick={() => handleDecision(item.id, "approve")}
                    data-testid={`approve-correction-${item.id}`}
                  >
                    اعتماد التصحيح
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8 flex-1 text-xs text-destructive hover:bg-destructive/10"
                    disabled={busy === item.id}
                    onClick={() => handleDecision(item.id, "reject")}
                    data-testid={`reject-correction-${item.id}`}
                  >
                    رفض
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        ))}
      </div>
    </section>
  );
}
