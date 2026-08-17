"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api, money } from "@/lib/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

type OrderTarget = {
  kind: "order";
  orderId: string;
  orderNumber: number;
  branchName: string;
  status: string;
  tableNumber: string | null;
  customerName: string | null;
  total: number;
  paidAmount: number;
  remainingAmount: number;
  paymentStatus: string;
  payments: { id: string; amount: number; method: string; createdAt: string }[];
};

const METHOD_LABEL: Record<string, string> = { CASH: "كاش", CARD: "فيزا", WALLET: "محفظة" };

// POS collection mode for a single order (/pos?collectOrderId=…): the one
// place money is collected. Loads totals + history via collect-info (which
// audits the started-from-POS event) and posts to the central service.
export function CollectPaymentPanel({
  orderId,
  currency,
  needsShift,
  shiftActive,
  onDone,
  onClose,
}: {
  orderId: string;
  currency: string;
  needsShift: boolean;
  shiftActive: boolean;
  onDone: () => void;
  onClose: () => void;
}) {
  const [target, setTarget] = useState<OrderTarget | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<"CASH" | "CARD" | "WALLET">("CASH");
  const [busy, setBusy] = useState(false);
  // Set after a successful collection → receipt actions view.
  const [receipt, setReceipt] = useState<{ paymentId: string; amount: number } | null>(null);

  useEffect(() => {
    api<{ target: OrderTarget }>(`/api/payments/collect-info?orderId=${orderId}`)
      .then((r) => {
        setTarget(r.target);
        setAmount(String(r.target.remainingAmount));
      })
      .catch((e) => setError(e instanceof Error ? e.message : "فشل التحميل"));
  }, [orderId]);

  const shiftBlocked = needsShift && !shiftActive;
  const settled = (target?.remainingAmount ?? 0) <= 0.001;

  async function collect() {
    if (!target || busy) return;
    const amt = Number(amount) || 0;
    if (amt <= 0) return toast.error("مبلغ الدفع يجب أن يكون أكبر من صفر");
    if (amt > target.remainingAmount + 0.001)
      return toast.error("مبلغ الدفع أكبر من المتبقي على الطلب");
    setBusy(true);
    try {
      const r = await api<{ payments: { id: string }[] }>("/api/payments", {
        method: "POST",
        body: { orderId: target.orderId, amount: amt, method },
      });
      toast.success("تم تحصيل الدفع بنجاح");
      setReceipt({ paymentId: r.payments[0]?.id ?? "", amount: amt });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "فشل التحصيل");
      // Refresh so a duplicate attempt shows the settled state.
      try {
        const r = await api<{ target: OrderTarget }>(`/api/payments/collect-info?orderId=${orderId}`);
        setTarget(r.target);
        setAmount(String(r.target.remainingAmount));
      } catch { /* keep old view */ }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>
            تحصيل الدفع{target ? ` — طلب #${target.orderNumber}` : ""}
          </DialogTitle>
        </DialogHeader>

        {receipt ? (
          /* ── Post-payment success: receipt actions ── */
          <div className="space-y-3 py-2 text-center">
            <p className="text-4xl">✅</p>
            <p className="text-base font-bold">تم تحصيل الدفع بنجاح</p>
            <p className="text-sm text-muted-foreground">
              {money(receipt.amount, currency)}{target ? ` — طلب #${target.orderNumber}` : ""}
            </p>
            <div className="grid gap-2">
              <Button
                className="h-11 w-full"
                onClick={() =>
                  window.open(`/receipts/payment/${receipt.paymentId}?print=1`, "_blank")
                }
              >
                🖨️ طباعة الريسيت
              </Button>
              <Button
                variant="outline"
                className="h-11 w-full"
                onClick={() => window.open(`/receipts/payment/${receipt.paymentId}`, "_blank")}
              >
                عرض الريسيت
              </Button>
              <Button variant="ghost" className="h-10 w-full text-muted-foreground" onClick={onDone}>
                إغلاق
              </Button>
            </div>
          </div>
        ) : error ? (
          <p className="text-sm text-destructive">{error}</p>
        ) : !target ? (
          <p className="text-sm text-muted-foreground">جاري التحميل…</p>
        ) : (
          <div className="space-y-3">
            {/* الحساب المحدد */}
            <div className="space-y-1 rounded-xl bg-muted/40 p-3 text-sm">
              <p className="text-xs font-semibold text-muted-foreground">الحساب المحدد</p>
              <div className="flex justify-between">
                <span className="text-muted-foreground">الإجمالي</span>
                <span className="tabular-nums font-semibold">{money(target.total, currency)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">المدفوع</span>
                <span className="tabular-nums text-emerald-600">{money(target.paidAmount, currency)}</span>
              </div>
              <div className="flex justify-between text-base font-bold">
                <span>المبلغ المتبقي</span>
                <span className="tabular-nums text-amber-600 dark:text-amber-400">
                  {money(target.remainingAmount, currency)}
                </span>
              </div>
              {(target.tableNumber || target.customerName) && (
                <p className="pt-0.5 text-[11px] text-muted-foreground">
                  {target.tableNumber ? `ترابيزة ${target.tableNumber}` : ""}
                  {target.tableNumber && target.customerName ? " · " : ""}
                  {target.customerName ?? ""}
                </p>
              )}
            </div>

            {/* Payment history */}
            {target.payments.length > 0 && (
              <div className="space-y-1">
                <p className="text-xs font-semibold text-muted-foreground">الدفعات السابقة</p>
                <div className="max-h-24 space-y-1 overflow-y-auto">
                  {target.payments.map((p) => (
                    <div key={p.id} className="flex items-center justify-between gap-1.5 rounded-lg border px-2.5 py-1 text-xs">
                      <span>{METHOD_LABEL[p.method] ?? p.method}</span>
                      <span className="text-muted-foreground">
                        {new Date(p.createdAt).toLocaleTimeString("ar-EG", { hour: "2-digit", minute: "2-digit" })}
                      </span>
                      <b className="tabular-nums">{money(p.amount, currency)}</b>
                      {/* إعادة طباعة — read-only, never re-collects */}
                      <button
                        type="button"
                        title="إعادة طباعة الريسيت"
                        className="text-muted-foreground hover:text-foreground"
                        onClick={() => window.open(`/receipts/payment/${p.id}?print=1&reprint=1`, "_blank")}
                      >
                        🖨️
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {settled ? (
              <p className="rounded-lg bg-emerald-500/10 px-3 py-2 text-sm font-medium text-emerald-700 dark:text-emerald-400">
                تم تحصيل هذا الحساب بالفعل ✅
              </p>
            ) : shiftBlocked ? (
              <p className="rounded-lg bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-400">
                لا يمكن تحصيل الدفع بدون شيفت مفتوح — افتح الشيفت من أعلى شاشة الكاشير أولًا.
              </p>
            ) : (
              <>
                <div className="space-y-1.5">
                  <Label>مبلغ التحصيل</Label>
                  <Input
                    type="number" min="0" step="0.01" dir="ltr"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>طريقة الدفع</Label>
                  <div className="grid grid-cols-3 gap-1.5">
                    {(["CASH", "CARD", "WALLET"] as const).map((m) => (
                      <button
                        key={m}
                        type="button"
                        onClick={() => setMethod(m)}
                        className={cn(
                          "rounded-lg border px-2 py-2 text-sm font-medium",
                          method === m ? "border-foreground bg-foreground text-background" : "border-border"
                        )}
                      >
                        {METHOD_LABEL[m]}
                      </button>
                    ))}
                  </div>
                </div>
              </>
            )}
          </div>
        )}

        {!receipt && (
          <DialogFooter>
            <Button variant="outline" onClick={onClose} disabled={busy}>
              رجوع لإنشاء طلب
            </Button>
            {target && !settled && !shiftBlocked && (
              <Button onClick={collect} disabled={busy}>
                {busy ? "جاري التحصيل…" : "تحصيل الدفع"}
              </Button>
            )}
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
