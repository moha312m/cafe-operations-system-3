"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

// Payment has already committed. This component can only load/print its receipt;
// it deliberately has no collection callback or financial request dependency.
export function PaymentReceiptPreview({ paymentId, scope, onClose, extraActions }: {
  paymentId: string | null;
  scope: "order" | "table";
  onClose: () => void;
  extraActions?: ReactNode;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const pendingPrint = useRef(false);
  const [attempt, setAttempt] = useState(0);
  const [printRequest, setPrintRequest] = useState(0);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    if (!paymentId || status !== "loading") return;
    const timeout = setTimeout(() => setStatus("error"), 15000);
    return () => clearTimeout(timeout);
  }, [paymentId, attempt, status]);

  function loaded(element: HTMLIFrameElement) {
    if (element !== frame.current) return;
    try {
      // Only a successfully authorized receipt exposes this marker. Login,
      // permission refusals, missing records and server failures stay unprintable.
      const ready = !!element.contentDocument?.querySelector('[data-receipt-ready="true"]');
      setStatus(ready ? "ready" : "error");
      if (ready && pendingPrint.current) {
        pendingPrint.current = false;
        element.contentWindow?.focus();
        element.contentWindow?.print();
      }
    } catch { pendingPrint.current = false; setStatus("error"); }
  }

  function printReceipt() {
    if (status !== "ready") return;
    // Retain the existing authorized RECEIPT_PRINTED audit request. Embedded
    // mode never auto-prints; only this explicit click arms the following load.
    pendingPrint.current = true;
    setStatus("loading");
    setPrintRequest((value) => value + 1);
  }

  return (
    <Dialog open onOpenChange={(open, details) => !open && details.reason !== "outside-press" && onClose()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>تم تحصيل الدفع بنجاح — الفاتورة</DialogTitle>
        </DialogHeader>
        {paymentId ? (
          <div className="min-w-0 space-y-2" data-testid="payment-receipt-preview">
            {status === "loading" && <p role="status" className="text-sm text-muted-foreground">جاري تحميل الفاتورة…</p>}
            {status === "error" && (
              <div role="alert" className="space-y-2 rounded-lg border p-3 text-sm">
                <p>تم تحصيل الدفع وحفظه. تعذّر تحميل الفاتورة أو لا توجد صلاحية لعرضها. لا تعِد تحصيل الدفع.</p>
                <Button variant="outline" onClick={() => { pendingPrint.current = false; setPrintRequest(0); setStatus("loading"); setAttempt((value) => value + 1); }}>إعادة تحميل الفاتورة</Button>
              </div>
            )}
            <iframe
              key={`${paymentId}:${scope}:${attempt}:${printRequest}`}
              ref={frame}
              title="معاينة الفاتورة بعد الدفع"
              src={`/receipts/payment/${encodeURIComponent(paymentId)}?scope=${scope}&embedded=1${printRequest ? `&print=1&printRequest=${printRequest}` : ""}`}
              className="h-[50dvh] min-h-40 w-full rounded-lg border bg-white"
              onLoad={(event) => loaded(event.currentTarget)}
              onError={() => setStatus("error")}
            />
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">تم سداد الحساب بخصم النقاط بالكامل — لا توجد دفعة مالية لطباعتها.</p>
        )}
        <DialogFooter className="flex-wrap">
          {extraActions}
          {paymentId && <Button disabled={status !== "ready"} onClick={printReceipt}>🖨️ طباعة الفاتورة</Button>}
          <Button variant="outline" onClick={onClose}>إغلاق بدون طباعة</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
