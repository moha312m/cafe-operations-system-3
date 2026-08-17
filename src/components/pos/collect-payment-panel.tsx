"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { api, money } from "@/lib/client";
import { useApp } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { maxRedeemablePoints, pointsValue, type LoyaltyCalcSettings } from "@/lib/loyalty-calc";

type LookupCustomer = {
  id: string;
  name: string | null;
  phone: string;
  loyaltyPointsBalance: number;
  totalOrders: number;
  totalSpent?: number;
  lastOrderAt: string | null;
  isActive: boolean;
};

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
  alreadyRedeemed: boolean;
  customer: LookupCustomer | null;
  payments: { id: string; amount: number; method: string; createdAt: string }[];
};

const METHOD_LABEL: Record<string, string> = { CASH: "كاش", CARD: "فيزا", WALLET: "محفظة" };

function lastVisitLabel(v: string | null): string {
  if (!v) return "لا يوجد";
  const days = Math.floor((Date.now() - new Date(v).getTime()) / 86_400_000);
  if (days <= 0) return "اليوم";
  if (days === 1) return "أمس";
  return `منذ ${days} يوم`;
}

// POS collection mode for a single order (/pos?collectOrderId=…): the one
// place money is collected. Includes the customer/points section — the
// cashier can apply a loyalty discount before collecting the rest.
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
  const { canKey } = useApp();
  const canRedeem = canKey("loyalty.redeem_points");

  const [target, setTarget] = useState<OrderTarget | null>(null);
  const [loyalty, setLoyalty] = useState<LoyaltyCalcSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<"CASH" | "CARD" | "WALLET">("CASH");
  const [busy, setBusy] = useState(false);
  const [receipt, setReceipt] = useState<{ paymentId: string | null; amount: number; loyaltyDiscount: number } | null>(null);

  // بيانات العميل والنقاط
  const [phone, setPhone] = useState("");
  const [customer, setCustomer] = useState<LookupCustomer | null>(null);
  const [looked, setLooked] = useState(false);
  const [redeem, setRedeemState] = useState<{ points: number; discount: number }>({ points: 0, discount: 0 });
  const [redeemOpen, setRedeemOpen] = useState(false);
  const [pointsInput, setPointsInput] = useState("");
  const [redeemError, setRedeemError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  async function loadTarget() {
    const r = await api<{ target: OrderTarget; loyalty: LoyaltyCalcSettings }>(
      `/api/payments/collect-info?orderId=${orderId}`
    );
    setTarget(r.target);
    setLoyalty(r.loyalty);
    // Linked customer loads automatically — no retyping the phone.
    if (r.target.customer) {
      setCustomer(r.target.customer);
      setLooked(true);
    }
    return r.target;
  }

  useEffect(() => {
    loadTarget()
      .then((t) => setAmount(String(t.remainingAmount)))
      .catch((e) => setError(e instanceof Error ? e.message : "فشل التحميل"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderId]);

  // Phone lookup (only needed when the order has no linked customer).
  useEffect(() => {
    if (target?.customer) return; // already linked
    setLooked(false);
    setCustomer(null);
    setRedeemState({ points: 0, discount: 0 });
    const digits = phone.replace(/\D/g, "");
    if (digits.length < 10) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      try {
        const r = await api<{ customer: LookupCustomer | null }>(
          `/api/customers/lookup?phone=${encodeURIComponent(phone)}`
        );
        setCustomer(r.customer);
        setLooked(true);
      } catch { setLooked(false); }
    }, 400);
    return () => { if (timer.current) clearTimeout(timer.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phone, target?.customer]);

  const remaining = target?.remainingAmount ?? 0;
  const settled = remaining <= 0.001;
  const shiftBlocked = needsShift && !shiftActive;

  // Redemption caps: balance, min, max% of the invoice, and the remaining.
  const cap = target && loyalty && customer
    ? Math.min(
        maxRedeemablePoints(customer.loyaltyPointsBalance, target.total, loyalty),
        loyalty.pointValueAmount > 0 ? Math.floor(remaining / loyalty.pointValueAmount) : 0
      )
    : 0;
  const showLoyaltyBlock =
    !!target && !!loyalty && loyalty.enabled && canRedeem && !settled && !target.alreadyRedeemed;

  const requiredToCollect = Math.max(Math.round((remaining - redeem.discount) * 100) / 100, 0);

  // Keep the money field synced to "المطلوب تحصيله".
  useEffect(() => {
    if (target) setAmount(String(requiredToCollect));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [redeem.discount, target?.remainingAmount]);

  function applyRedemption() {
    if (!customer || !loyalty) return setRedeemError("يجب اختيار عميل أولًا");
    const pts = Math.floor(Number(pointsInput) || 0);
    if (pts <= 0) return setRedeemError("اكتب عدد النقاط المستخدمة");
    if (pts > customer.loyaltyPointsBalance) return setRedeemError("لا يمكن استخدام نقاط أكثر من رصيد العميل");
    if (pts < loyalty.minPointsToRedeem) return setRedeemError(`أقل عدد نقاط للاستخدام هو ${loyalty.minPointsToRedeem} نقطة`);
    if (pts > cap) return setRedeemError("لا يمكن أن يتجاوز خصم النقاط الحد المسموح");
    setRedeemError(null);
    setRedeemState({ points: pts, discount: pointsValue(pts, loyalty) });
    setRedeemOpen(false);
  }

  async function collect() {
    if (!target || busy) return;
    const amt = Number(amount) || 0;
    if (amt <= 0 && redeem.points === 0) return toast.error("مبلغ الدفع يجب أن يكون أكبر من صفر");
    if (amt > requiredToCollect + 0.001) return toast.error("مبلغ الدفع أكبر من المطلوب تحصيله");
    setBusy(true);
    try {
      const body: Record<string, unknown> = { orderId: target.orderId };
      if (amt > 0) { body.amount = amt; body.method = method; }
      if (redeem.points > 0) {
        body.loyaltyPointsToRedeem = redeem.points;
        if (!target.customer && customer) body.customerPhone = customer.phone;
      }
      const r = await api<{ payments: { id: string }[] }>("/api/payments", { method: "POST", body });
      toast.success("تم تحصيل الدفع بنجاح");
      setReceipt({ paymentId: r.payments[0]?.id ?? null, amount: amt, loyaltyDiscount: redeem.discount });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "فشل التحصيل");
      // Refresh so a duplicate attempt shows the settled state.
      try {
        const t = await loadTarget();
        setRedeemState({ points: 0, discount: 0 });
        setAmount(String(t.remainingAmount));
      } catch { /* keep old view */ }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-sm">
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
              {money(receipt.amount, currency)}
              {receipt.loyaltyDiscount > 0 && (
                <span> + خصم نقاط {money(receipt.loyaltyDiscount, currency)}</span>
              )}
              {target ? ` — طلب #${target.orderNumber}` : ""}
            </p>
            <div className="grid gap-2">
              {receipt.paymentId ? (
                <>
                  <Button
                    className="h-11 w-full"
                    onClick={() => window.open(`/receipts/payment/${receipt.paymentId}?print=1`, "_blank")}
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
                </>
              ) : (
                <p className="text-xs text-muted-foreground">
                  تم سداد الحساب بخصم النقاط بالكامل — لا توجد دفعة نقدية لطباعتها.
                </p>
              )}
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
                <span className="text-muted-foreground">إجمالي الحساب</span>
                <span className="tabular-nums font-semibold">{money(target.total, currency)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">المدفوع سابقًا</span>
                <span className="tabular-nums text-emerald-600">{money(target.paidAmount, currency)}</span>
              </div>
              {redeem.discount > 0 && (
                <div className="flex justify-between text-amber-600 dark:text-amber-400">
                  <span>خصم نقاط الولاء ({redeem.points} نقطة)</span>
                  <span className="tabular-nums">−{money(redeem.discount, currency)}</span>
                </div>
              )}
              <div className="flex justify-between text-base font-bold">
                <span>{redeem.discount > 0 ? "المطلوب تحصيله" : "المبلغ المتبقي"}</span>
                <span className="tabular-nums text-amber-600 dark:text-amber-400">
                  {money(requiredToCollect, currency)}
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

            {/* ── بيانات العميل والنقاط ── */}
            {!settled && (
              <div className="space-y-1.5 rounded-xl border p-2.5">
                <p className="text-xs font-semibold">بيانات العميل والنقاط</p>
                {!target.customer && (
                  <Input
                    dir="ltr"
                    inputMode="tel"
                    placeholder="رقم موبايل العميل — 01xx xxx xxxx"
                    className="h-10"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                  />
                )}
                {customer ? (
                  <div className="space-y-1 rounded-lg bg-blue-500/10 px-2.5 py-1.5 text-[11px] leading-snug text-blue-800 dark:text-blue-300">
                    <p className="text-xs font-semibold">عميل موجود{customer.name ? `: ${customer.name}` : ""}</p>
                    <div className="flex flex-wrap gap-x-3 gap-y-0.5">
                      <span>رصيد النقاط: <b className="tabular-nums">{customer.loyaltyPointsBalance}</b> نقطة</span>
                      <span>إجمالي الطلبات: <b className="tabular-nums">{customer.totalOrders}</b></span>
                      <span>آخر زيارة: {lastVisitLabel(customer.lastOrderAt)}</span>
                    </div>
                  </div>
                ) : looked ? (
                  <p className="rounded-lg bg-muted/50 px-2.5 py-1.5 text-[11px] text-muted-foreground">
                    عميل جديد — لا يوجد رصيد نقاط
                  </p>
                ) : null}

                {/* Redemption */}
                {showLoyaltyBlock && customer && (
                  redeem.points > 0 ? (
                    <div className="flex items-center justify-between rounded-md bg-emerald-500/10 px-2 py-1.5 text-xs text-emerald-700 dark:text-emerald-400">
                      <span>
                        النقاط المستخدمة: <b className="tabular-nums">{redeem.points}</b> · الخصم:{" "}
                        <b className="tabular-nums">{money(redeem.discount, currency)}</b>
                      </span>
                      <button
                        type="button"
                        className="text-[11px] font-medium text-red-600 underline"
                        onClick={() => { setRedeemState({ points: 0, discount: 0 }); setPointsInput(""); }}
                      >
                        إلغاء
                      </button>
                    </div>
                  ) : customer.loyaltyPointsBalance <= 0 ? (
                    <Button size="sm" variant="outline" className="h-8 w-full text-xs" disabled>
                      استخدام نقاط الولاء — لا يوجد رصيد نقاط
                    </Button>
                  ) : customer.loyaltyPointsBalance < (loyalty?.minPointsToRedeem ?? 0) ? (
                    <p className="text-[11px] text-muted-foreground">
                      أقل عدد نقاط للاستخدام هو {loyalty!.minPointsToRedeem} نقطة
                    </p>
                  ) : cap <= 0 ? (
                    <p className="text-[11px] text-muted-foreground">لا يوجد رصيد نقاط كافي</p>
                  ) : !redeemOpen ? (
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-8 w-full border-amber-500/60 text-xs font-semibold"
                      onClick={() => { setPointsInput(String(cap)); setRedeemError(null); setRedeemOpen(true); }}
                    >
                      ⭐ استخدام نقاط الولاء
                    </Button>
                  ) : (
                    <div className="space-y-1.5 rounded-lg border border-amber-500/40 bg-amber-500/5 p-2">
                      <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
                        <span>رصيد العميل: <b>{customer.loyaltyPointsBalance}</b> نقطة</span>
                        <span>1 نقطة = {money(loyalty!.pointValueAmount, currency)}</span>
                        <span>الأقصى: <b>{cap}</b> نقطة</span>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <Input
                          type="number" dir="ltr" min={0} max={cap} placeholder="عدد النقاط"
                          className="h-9"
                          value={pointsInput}
                          onChange={(e) => { setPointsInput(e.target.value); setRedeemError(null); }}
                        />
                        <Button size="sm" className="h-9 shrink-0 px-3 text-xs" onClick={applyRedemption}>
                          تطبيق الخصم
                        </Button>
                        <Button size="sm" variant="ghost" className="h-9 shrink-0 px-2 text-xs" onClick={() => setRedeemOpen(false)}>
                          إلغاء
                        </Button>
                      </div>
                      {Number(pointsInput) > 0 && loyalty && (
                        <p className="text-[11px] text-muted-foreground">
                          قيمة الخصم: {money(pointsValue(Math.floor(Number(pointsInput) || 0), loyalty), currency)} ·
                          المتبقي بعد الخصم: {money(Math.max(remaining - pointsValue(Math.floor(Number(pointsInput) || 0), loyalty), 0), currency)}
                        </p>
                      )}
                      {redeemError && <p className="text-[11px] text-destructive">{redeemError}</p>}
                    </div>
                  )
                )}
                {target.alreadyRedeemed && (
                  <p className="text-[11px] text-muted-foreground">تم استخدام نقاط الولاء لهذا الطلب بالفعل</p>
                )}
              </div>
            )}

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
