"use client";

import { useRef, useState } from "react";
import { toast } from "sonner";
import { api, money } from "@/lib/client";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export type RefundTarget = {
  id: string;
  orderNumber: number;
  total: string | number;
  /** Methods the money actually came in on, for the confirmation line. */
  methods: string[];
};

const METHOD_LABEL: Record<string, string> = {
  CASH: "نقدي",
  CARD: "فيزا",
  WALLET: "محفظة",
  MIXED: "مختلط",
};

/**
 * Confirm and issue a full refund for one order.
 *
 * The cashier never meets the words COLLECTION or REFUND — they see an order,
 * an amount, how it was paid and a box for why. Everything the server checks
 * (authorisation, custody, already-refunded, reason) it checks again on the
 * request; this dialog is here to prevent mistakes, not to enforce rules.
 */
export function RefundOrderDialog({
  target,
  currency,
  onClose,
  onRefunded,
}: {
  target: RefundTarget | null;
  currency: string;
  onClose: () => void;
  onRefunded: () => void | Promise<void>;
}) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  // `busy` drives the disabled state, but React state does not update within
  // the same tick — two clicks in one tick both read it as false. The ref is
  // what actually stops the second request leaving the browser.
  const inFlight = useRef(false);

  const close = () => {
    if (busy) return; // never disappear mid-request
    setReason("");
    onClose();
  };

  async function confirm() {
    if (!target || inFlight.current || !reason.trim()) return;
    inFlight.current = true;
    setBusy(true);
    try {
      await api(`/api/orders/${target.id}/refund`, {
        method: "POST",
        body: { reason: reason.trim() },
      });
      toast.success(`تم استرجاع ${money(target.total, currency)} لطلب #${target.orderNumber}`);
      setReason("");
      onClose();
      // Re-read from the server rather than patching local state, so what the
      // screen shows is what was actually recorded.
      await onRefunded();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "فشل الاسترجاع");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  const methods = target?.methods.length
    ? [...new Set(target.methods)].map((m) => METHOD_LABEL[m] ?? m).join(" + ")
    : "—";
  const hasCard = Boolean(target?.methods.some((m) => m !== "CASH"));

  return (
    <Dialog open={target !== null} onOpenChange={(o) => !o && close()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {target ? `استرجاع ${money(target.total, currency)}؟` : "استرجاع"}
          </DialogTitle>
        </DialogHeader>

        {target && (
          <div className="space-y-3">
            <dl className="space-y-1.5 rounded-lg bg-muted/40 p-3 text-sm">
              <div className="flex justify-between">
                <dt className="text-muted-foreground">الطلب</dt>
                <dd className="tabular-nums">#{target.orderNumber}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted-foreground">المبلغ</dt>
                <dd className="tabular-nums font-semibold">{money(target.total, currency)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted-foreground">طريقة الدفع</dt>
                <dd>{methods}</dd>
              </div>
            </dl>

            <div className="space-y-2">
              <Label htmlFor="refund-reason">سبب الاسترجاع</Label>
              <Textarea
                id="refund-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="مثال: العميل لغى الطلب"
                rows={2}
                disabled={busy}
              />
            </div>

            {hasCard && (
              // The system records the refund; it does not talk to a card
              // provider. Saying otherwise would promise something untrue.
              <p className="rounded-lg bg-amber-500/10 px-2.5 py-2 text-xs leading-snug text-amber-700 dark:text-amber-400">
                ده تسجيل للاسترجاع في النظام. رجوع الفلوس للعميل على الفيزا/المحفظة
                بيتم من مكنة الدفع أو البنك بشكل منفصل.
              </p>
            )}

            <p className="text-xs text-muted-foreground">
              الطلب هيتقفل بعد الاسترجاع. لو العميل هيشتري تاني، اعمل طلب جديد.
            </p>
          </div>
        )}

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={close} disabled={busy} className="w-full sm:w-auto">
            إلغاء
          </Button>
          <Button
            onClick={confirm}
            // Guarding on `busy` as well as emptiness is what stops a second
            // click landing while the first request is still in flight.
            disabled={busy || !reason.trim()}
            className="w-full sm:w-auto"
          >
            {busy ? "جاري الاسترجاع…" : "تأكيد الاسترجاع"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
