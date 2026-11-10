"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Bell, Check, X, Clock, AlertTriangle, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/client";
import { useApp } from "@/components/app-shell";
import { ROLE_LABELS } from "@/lib/permissions";
import { UNIT_LABEL } from "@/lib/inventory";
import type { InventoryUnit } from "@prisma/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

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

function timeAgo(dateStr: string): string {
  const diffMs = Date.now() - new Date(dateStr).getTime();
  const diffMins = Math.max(0, Math.floor(diffMs / 60_000));
  if (diffMins < 1) return "الآن";
  if (diffMins < 60) return `منذ ${diffMins} دقيقة`;
  const hours = Math.floor(diffMins / 60);
  const remMins = diffMins % 60;
  return `منذ ${hours} س ${remMins > 0 ? `${remMins} د` : ""}`;
}

export function StockCorrectionBell() {
  const { user, canKey } = useApp();
  const router = useRouter();
  const [corrections, setCorrections] = useState<PendingCorrection[]>([]);
  const [count, setCount] = useState(0);
  const [isOpen, setIsOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const prevCount = useRef<number | null>(null);

  const canApprove =
    user?.role === "CAFE_OWNER" ||
    user?.role === "BRANCH_MANAGER" ||
    user?.role === "SUPER_ADMIN" ||
    canKey("stock_count.approve_correction");

  const loadPending = useCallback(async () => {
    if (!canApprove) return;
    try {
      const data = await api<{ count?: number; pendingCorrections: PendingCorrection[] }>(
        "/api/corrections/pending"
      );
      const items = data.pendingCorrections ?? [];
      const newCount = typeof data.count === "number" ? data.count : items.length;
      
      // Notify owner if count increased while on screen
      if (prevCount.current !== null && newCount > prevCount.current) {
        toast.info("🔔 يوجد طلب تصحيح جرد جديد بانتظار اعتمادك", {
          description: "قم بفتح جرس الإشعارات لمراجعة واعتماد الكمية.",
          duration: 6000,
        });
      }
      prevCount.current = newCount;
      setCorrections(items);
      setCount(newCount);
    } catch {
      // Hides quietly if network drops or session changes
    }
  }, [canApprove]);

  useEffect(() => {
    if (!canApprove) return;
    void loadPending();

    const interval = setInterval(loadPending, 15_000);
    const onFocus = () => void loadPending();
    const onCustomUpdate = () => void loadPending();

    window.addEventListener("focus", onFocus);
    window.addEventListener("stock-correction-updated", onCustomUpdate);

    return () => {
      clearInterval(interval);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("stock-correction-updated", onCustomUpdate);
    };
  }, [canApprove, loadPending]);

  if (!canApprove) return null;

  async function handleApprove(id: string) {
    setBusyId(id);
    try {
      await api(`/api/corrections/${id}/approve`, { method: "POST" });
      toast.success("✅ تم اعتماد تصحيح الكمية بنجاح");
      window.dispatchEvent(new Event("stock-correction-updated"));
      await loadPending();
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "تعذر اعتماد التصحيح");
    } finally {
      setBusyId(null);
    }
  }

  async function handleReject(id: string) {
    setBusyId(id);
    try {
      await api(`/api/corrections/${id}/reject`, { method: "POST" });
      toast.success("تم رفض طلب التصحيح");
      window.dispatchEvent(new Event("stock-correction-updated"));
      await loadPending();
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "تعذر رفض التصحيح");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setIsOpen(true)}
        aria-label="إشعارات طلبات تصحيح الجرد"
        title="إشعارات تصحيح الجرد والمخزون"
        className="relative flex size-9 items-center justify-center rounded-lg border border-sidebar-border bg-sidebar-accent/50 text-sidebar-foreground transition-all hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sidebar-ring"
      >
        <Bell className="size-5" />
        {count > 0 && (
          <span className="absolute -top-1.5 -end-1.5 flex min-w-5 h-5 items-center justify-center rounded-full bg-red-600 px-1 text-[11px] font-bold text-white shadow-sm animate-pulse">
            {count > 99 ? "+99" : count}
          </span>
        )}
      </button>

      <Dialog open={isOpen} onOpenChange={setIsOpen}>
        <DialogContent className="max-w-lg p-0 overflow-hidden sm:rounded-xl">
          <DialogHeader className="border-b px-5 py-4 bg-muted/30">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="flex size-8 items-center justify-center rounded-full bg-amber-500/15 text-amber-600 dark:text-amber-400">
                  <ShieldCheck className="size-5" />
                </span>
                <div>
                  <DialogTitle className="text-base font-bold text-foreground">
                    طلبات تصحيح الجرد المعلقة
                  </DialogTitle>
                  <p className="text-xs text-muted-foreground">
                    اعتماد أو رفض تعديلات الكميات المدخلة من طاقم العمل
                  </p>
                </div>
              </div>
              <Badge variant={count > 0 ? "destructive" : "secondary"}>
                {count} {count === 1 ? "طلب" : "طلبات"}
              </Badge>
            </div>
          </DialogHeader>

          <div className="max-h-[60vh] overflow-y-auto p-4 space-y-3">
            {corrections.length === 0 ? (
              <div className="py-8 text-center text-muted-foreground space-y-2">
                <Bell className="mx-auto size-10 opacity-30" />
                <p className="text-sm font-medium">لا توجد طلبات تصحيح جرد معلقة حالياً</p>
                <p className="text-xs">أي تعديل يطلبه الموظف على كميات الجرد سيظهر هنا فوراً.</p>
              </div>
            ) : (
              corrections.map((item) => {
                const unitText = UNIT_LABEL[item.line.unit as InventoryUnit] ?? item.line.unit;
                const isItemBusy = busyId === item.id;
                const roleLabel =
                  ROLE_LABELS[item.actor.role as keyof typeof ROLE_LABELS] ?? item.actor.role;

                return (
                  <div
                    key={item.id}
                    className="rounded-lg border bg-card p-3.5 shadow-sm space-y-2.5 transition-colors hover:border-sidebar-ring/40"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <h4 className="font-bold text-foreground text-sm">
                          {item.line.inventoryItem.name}
                        </h4>
                        <div className="flex items-center gap-2 mt-0.5 text-xs text-muted-foreground">
                          <span className="inline-flex items-center gap-1">
                            <Clock className="size-3" />
                            {timeAgo(item.createdAt)}
                          </span>
                          <span>•</span>
                          <span>بواسطة: {item.actor.name} ({roleLabel})</span>
                        </div>
                      </div>
                      <Badge variant="outline" className="text-amber-700 bg-amber-50 dark:bg-amber-950/40 border-amber-300 dark:border-amber-800 text-[11px]">
                        قيد الاعتماد
                      </Badge>
                    </div>

                    <div className="flex flex-wrap items-center gap-2 rounded-md bg-muted/40 px-3 py-2 text-xs">
                      <div className="flex items-center gap-1.5">
                        <span className="text-muted-foreground">الكمية المسجلة:</span>
                        <span className="line-through font-semibold text-muted-foreground tabular-nums">
                          {Number(item.oldCountedQuantity)}
                        </span>
                      </div>
                      <span className="text-muted-foreground">⬅️</span>
                      <div className="flex items-center gap-1.5">
                        <span className="font-bold text-emerald-600 dark:text-emerald-400">
                          الكمية الجديدة:
                        </span>
                        <span className="font-bold text-emerald-700 dark:text-emerald-300 text-sm tabular-nums">
                          {Number(item.newCountedQuantity)} {unitText}
                        </span>
                      </div>
                      {item.line.expectedQuantity !== null && (
                        <span className="ms-auto text-muted-foreground text-[11px]">
                          (المتوقع: {Number(item.line.expectedQuantity)})
                        </span>
                      )}
                    </div>

                    {(item.reasonCode?.label || item.note) && (
                      <div className="text-xs text-muted-foreground space-y-0.5 border-s-2 border-amber-500/50 ps-2">
                        {item.reasonCode?.label && (
                          <p>
                            <span className="font-medium text-foreground">السبب:</span>{" "}
                            {item.reasonCode.label}
                          </p>
                        )}
                        {item.note && (
                          <p className="italic">
                            <span className="font-medium text-foreground not-italic">الملاحظة:</span>{" "}
                            {item.note}
                          </p>
                        )}
                      </div>
                    )}

                    <div className="flex items-center justify-end gap-2 pt-1 border-t">
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={isItemBusy}
                        onClick={() => handleReject(item.id)}
                        className="text-destructive hover:bg-destructive/10 text-xs h-8 px-2.5"
                      >
                        <X className="me-1 size-3.5" />
                        رفض
                      </Button>
                      <Button
                        size="sm"
                        disabled={isItemBusy}
                        onClick={() => handleApprove(item.id)}
                        className="bg-emerald-600 hover:bg-emerald-700 text-white text-xs h-8 px-3"
                      >
                        <Check className="me-1 size-3.5" />
                        {isItemBusy ? "جارٍ الاعتماد…" : "اعتماد فوري"}
                      </Button>
                    </div>
                  </div>
                );
              })
            )}
          </div>

          <div className="flex items-center justify-between border-t bg-muted/20 px-4 py-2.5 text-xs">
            <Link
              href="/approvals"
              onClick={() => setIsOpen(false)}
              className="text-primary hover:underline font-medium"
            >
              عرض صفحة الموافقات العامة ←
            </Link>
            <Button size="sm" variant="outline" onClick={() => setIsOpen(false)} className="h-7 text-xs">
              إغلاق
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
