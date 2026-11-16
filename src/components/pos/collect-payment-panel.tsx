"use client";
import { TouchNumberInput } from "@/components/pos/touch-number-input";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { api, ApiRequestError, money } from "@/lib/client";
import { clientRequestUuid } from "@/lib/client-request-key";
import { useApp } from "@/components/app-shell";
import { PaymentReceiptPreview } from "@/components/receipts/payment-receipt-preview";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { maxRedeemablePoints, pointsValue, type LoyaltyCalcSettings } from "@/lib/loyalty-calc";
import { awaitPickupResponse, PAID_AWAITING_HANDOFF, pickupAttemptStorageKey, pickupSettled, readPickupAttempt, resolvePickupCollection, type PickupCollectionAttempt, type PickupOrderState } from "@/lib/register-pickup";

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
  branchId: string;
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
  shiftActive = false,
  onDone,
  onClose,
  pickup,
}: {
  orderId: string;
  currency: string;
  needsShift: boolean;
  shiftActive?: boolean;
  onDone: () => void;
  onClose: () => void;
  pickup?: { onChange: () => void };
}) {
  const { user, canKey, can } = useApp();
  const canRedeem = canKey("loyalty.redeem_points");
  const canServe = can("orders:update-status");
  const [served, setServed] = useState(false);

  const [target, setTarget] = useState<OrderTarget | null>(null);
  const [loyalty, setLoyalty] = useState<LoyaltyCalcSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<"CASH" | "CARD" | "WALLET">("CASH");
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [collectionError, setCollectionError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<{ paymentId: string | null; amount: number; loyaltyDiscount: number } | null>(null);
  const pendingKey = pickupAttemptStorageKey(user.id, orderId);
  const [initialAttempt] = useState(() => {
    try { return { value: readPickupAttempt(window.sessionStorage, user.id, orderId), error: null }; }
    catch { return { value: null, error: pickup ? "تعذر استعادة التحصيل السابق. راجع الدفعات قبل إعادة المحاولة." : null }; }
  });
  const [attempt, setAttempt] = useState<PickupCollectionAttempt | null>(initialAttempt.value);
  const [handoffMessage, setHandoffMessage] = useState<string | null>(null);
  const [handoffRetry, setHandoffRetry] = useState(false);
  const [serving, setServing] = useState(false);
  const handoffInFlight = useRef(false);
  const [isPickup] = useState(() => !!pickup || !!attempt);
  const [pickupShiftActive, setPickupShiftActive] = useState(false);

  // بيانات العميل والنقاط
  const [phone, setPhone] = useState("");
  const [customer, setCustomer] = useState<LookupCustomer | null>(null);
  const [looked, setLooked] = useState(false);
  const [redeem, setRedeemState] = useState<{ points: number; discount: number }>({ points: 0, discount: 0 });
  const [redeemOpen, setRedeemOpen] = useState(false);
  const [pointsInput, setPointsInput] = useState("");
  const [redeemError, setRedeemError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const targetController=useRef<AbortController|null>(null);
  async function loadTarget() {
    targetController.current?.abort();const controller=new AbortController();targetController.current=controller;setError(null);
    const r = await api<{ target: OrderTarget; loyalty: LoyaltyCalcSettings }>(
      `/api/payments/collect-info?orderId=${orderId}`,{signal:controller.signal,readTimeoutMs:20_000}
    );
    if(controller.signal.aborted)throw new DOMException("تم إلغاء القراءة السابقة","AbortError");
    if (isPickup && needsShift) {
      const params = new URLSearchParams({ branchId: r.target.branchId });
      const active = await api<{ shift: { id: string } | null }>(
        `/api/shifts/active?${params}`, { signal: controller.signal, readTimeoutMs: 20_000 },
      ).catch(() => null);
      if (controller.signal.aborted) throw new DOMException("تم إلغاء القراءة السابقة", "AbortError");
      setPickupShiftActive(!!active?.shift);
    }
    setTarget(r.target);
    setLoyalty(r.loyalty);
    if (isPickup) {
      if (r.target.paymentStatus === "CANCELLED" || r.target.status === "CANCELLED") setError("تم إلغاء هذا الطلب");
      else if (r.target.paymentStatus === "REFUNDED") setError("تم ردّ قيمة هذا الطلب");
      else if (!["READY", "SERVED"].includes(r.target.status)) setError("الطلب لم يعد جاهزًا للاستلام الآن");
    }
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
      .catch((e) => {if(e?.name!=="AbortError")setError(e instanceof Error ? e.message : "فشل التحميل")});
    return ()=>targetController.current?.abort();
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
    const controller=new AbortController();
    timer.current = setTimeout(async () => {
      try {
        const r = await api<{ customer: LookupCustomer | null }>(
          `/api/customers/lookup?phone=${encodeURIComponent(phone)}`,{signal:controller.signal,readTimeoutMs:20_000}
        );
        if(controller.signal.aborted)return;
        setCustomer(r.customer);
        setLooked(true);
      } catch { if(!controller.signal.aborted)setLooked(false); }
    }, 400);
    return () => { controller.abort(); if (timer.current) clearTimeout(timer.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phone, target?.customer]);

  const remaining = target?.remainingAmount ?? 0;
  const settled = isPickup && target ? pickupSettled(target) : remaining <= 0.001;
  const shiftBlocked = needsShift && !(isPickup ? pickupShiftActive : shiftActive);

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

  const servable = !!target && target.status === "READY" && canServe && !served;
  const exactPickupAmount = Number(amount) === requiredToCollect;

  function sendHandoff(id: string) {
    return awaitPickupResponse((signal) => api(`/api/orders/${encodeURIComponent(id)}/status`, { signal, method: "PATCH", body: { status: "SERVED", pickup: true } }));
  }

  // Serving is its own request through the ordinary status route, so the
  // café's payment, stock and custody rules decide it. A refusal after a
  // successful collection leaves the money recorded and says so plainly.
  async function serveNow(afterCollect: boolean) {
    if (!target || handoffInFlight.current) return;
    handoffInFlight.current = true;
    setServing(true);
    try {
      if (isPickup) await sendHandoff(target.orderId);
      else await api(`/api/orders/${target.orderId}/status`, { method: "PATCH", body: { status: "SERVED" } });
      setServed(true);
      setHandoffMessage(null);
      setHandoffRetry(false);
      toast.success(`الطلب #${target.orderNumber} اتقدم ✅`);
    } catch (e) {
      const reason = e instanceof Error ? e.message : "فشل التقديم";
      if (isPickup) {
        const current = await loadTarget().catch(() => null);
        if (current?.status === "SERVED") {
          setServed(true);
          setHandoffMessage(null);
          setHandoffRetry(false);
        } else {
          const stillReady = current?.status === "READY" && pickupSettled(current);
          const awaitingHandoff = stillReady || (!current && (afterCollect || settled || !!receipt));
          setHandoffRetry(stillReady || !current);
          setHandoffMessage(awaitingHandoff ? `${PAID_AWAITING_HANDOFF}. ${reason}` : reason);
        }
      } else toast.error(afterCollect ? `اتحصّل بس متقدمش: ${reason}` : reason);
    } finally {
      setServing(false);
      handoffInFlight.current = false;
      pickup?.onChange();
    }
  }

  async function runPickup(original: PickupCollectionAttempt, retry = false) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setCollectionError(null);
    try {
      // Keep other collection entry points on the same terminal fenced too.
      sessionStorage.setItem(pendingKey, JSON.stringify(original));
      setAttempt(original);
      const outcome = await resolvePickupCollection(original, {
        pay: current => awaitPickupResponse(api("/api/payments", {
          method: "POST", idempotencyKey: current.key,
          body: { ...current.body, pickup: current.handoff ? "COLLECT_AND_HANDOFF" : "COLLECT" },
        })),
        handoff: sendHandoff,
        read: loadTarget,
      });
      try { sessionStorage.removeItem(pendingKey); } catch {}
      setAttempt(null);
      if (outcome.kind === "handed-off") setServed(true);
      if (outcome.kind === "paid-awaiting-handoff" || outcome.kind === "handoff-unconfirmed") {
        const reason = outcome.error instanceof Error ? outcome.error.message : "";
        setHandoffRetry(outcome.kind === "paid-awaiting-handoff" || !outcome.current);
        setHandoffMessage(outcome.kind === "paid-awaiting-handoff"
          ? `${PAID_AWAITING_HANDOFF}${reason ? `. ${reason}` : ""}`
          : "تم تسجيل التحصيل وتعذر تأكيد التسليم. راجع حالة الطلب.");
      } else toast.success(outcome.kind === "handed-off" ? "تم التحصيل وتسليم الطلب" : "تم تحصيل الدفع بنجاح");
      setReceipt({ paymentId: outcome.paymentId, amount: original.body.amount ?? 0, loyaltyDiscount: 0 });
    } catch (e) {
      // Ordinary validation on the first response is final. On replay,
      // authorization/not-found can hide a previously committed response.
      const finalRefusal = e instanceof ApiRequestError && e.status >= 400 && e.status < 500
        && ![408, 409, 425, 429].includes(e.status) && (!retry || ![401, 403, 404].includes(e.status));
      if (finalRefusal) {
        try { sessionStorage.removeItem(pendingKey); } catch {}
        setAttempt(null);
      }
      setCollectionError(e instanceof Error ? e.message : "فشل التحصيل");
      const current = await loadTarget().catch(() => null);
      if (finalRefusal && current) {
        setRedeemState({ points: 0, discount: 0 });
        setAmount(String(current.remainingAmount));
      }
    } finally {
      pickup?.onChange();
      setBusy(false);
      inFlight.current = false;
    }
  }

  async function collect(andServe = false) {
    if (!target || inFlight.current || initialAttempt.error) return;
    const amt = Number(amount) || 0;
    if (amt <= 0 && redeem.points === 0) return toast.error("مبلغ الدفع يجب أن يكون أكبر من صفر");
    if (amt > requiredToCollect + 0.001) return toast.error("مبلغ الدفع أكبر من المطلوب تحصيله");
    if (isPickup) {
      if (attempt || target.status !== "READY" || shiftBlocked || !canKey("pos.collect_payment") || !can("payments:create")) return;
      if (andServe && (!canServe || !exactPickupAmount)) return;
      return runPickup({
        key: clientRequestUuid(),
        handoff: andServe,
        reference: { branchId: target.branchId, orderNumber: target.orderNumber },
        body: {
          orderId: target.orderId, pickupExpectedRemaining: target.remainingAmount.toFixed(2), ...(amt > 0 ? { amount: amt, method } : {}),
          ...(redeem.points > 0 ? { loyaltyPointsToRedeem: redeem.points, ...(!target.customer && customer ? { customerPhone: customer.phone } : {}) } : {}),
        },
      });
    }
    inFlight.current = true;
    setCollectionError(null);
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
      if (andServe) await serveNow(true);
    } catch (e) {
      const message = e instanceof Error ? e.message : "فشل التحصيل";
      setCollectionError(message);
      toast.error(message);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  if (receipt) {
    return <PaymentReceiptPreview
      paymentId={receipt.paymentId}
      scope="order"
      onClose={onDone}
      extraActions={isPickup ? <>
        {handoffMessage && <p role="alert" className="text-sm">{handoffMessage}</p>}
        {handoffRetry && canServe && !served && <Button variant="outline" disabled={serving} onClick={() => void serveNow(false)}>تسليم الطلب</Button>}
      </> : servable ? <Button variant="outline" disabled={serving} onClick={() => serveNow(false)}>🍽️ قدّم الطلب دلوقتي</Button> : undefined}
    />;
  }
  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>
            تحصيل الدفع{target ? ` — طلب #${target.orderNumber}${isPickup ? ` · ${target.branchName}` : ""}` : ""}
          </DialogTitle>
        </DialogHeader>

        {collectionError && <p role="alert" className="text-destructive">{collectionError}{attempt ? " — لازم تأكّد نتيجة نفس المحاولة قبل تحصيل مبلغ جديد." : !isPickup ? " — المبلغ والبيانات محفوظة. إعادة نفس المحاولة لا تسجل دفعة أخرى." : ""}</p>}
        {initialAttempt.error && <p role="alert" className="text-destructive">{initialAttempt.error}</p>}
        {attempt && <p role="status" className="text-sm">في محاولة تحصيل بانتظار التأكيد لهذا الطلب.</p>}
        {handoffMessage && <p role="alert" className="text-sm">{handoffMessage}</p>}
        {busy && <p role="status">جاري تسجيل الدفع…</p>}
        {error ? (
          <div role="alert" className="space-y-3 text-sm text-destructive"><p>{error}</p><Button variant="outline" onClick={()=>void loadTarget().then(t=>setAmount(String(t.remainingAmount))).catch(e=>{if(e?.name!=="AbortError")setError(e instanceof Error?e.message:"فشل التحميل")})}>إعادة المحاولة</Button></div>
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
                        <TouchNumberInput
                          type="number" dir="ltr" min={0} max={cap} placeholder="عدد النقاط"
                          className="h-9"
                          value={pointsInput}
                          onValueChange={touchValue => { setPointsInput(touchValue); setRedeemError(null); }}
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
                        onClick={() => window.open(`/receipts/payment/${p.id}?print=1&reprint=1&scope=order`, "_blank")}
                      >
                        🖨️
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {settled ? (
              <div className="space-y-2">
                <p className="rounded-lg bg-emerald-500/10 px-3 py-2 text-sm font-medium text-emerald-700 dark:text-emerald-400">
                  {isPickup && target.paymentStatus !== "PAID" ? "لا يوجد مبلغ مستحق على الطلب" : "تم تحصيل هذا الحساب بالفعل ✅"}
                </p>
                {servable && !attempt && (
                  <Button variant="outline" className="h-10 w-full" disabled={serving} onClick={() => serveNow(false)}>
                    {isPickup ? "تسليم الطلب" : "🍽️ قدّم الطلب دلوقتي"}
                  </Button>
                )}
              </div>
            ) : shiftBlocked ? (
              <p className="rounded-lg bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-400">
                لا يمكن تحصيل الدفع بدون شيفت مفتوح — افتح الشيفت من أعلى شاشة الكاشير أولًا.
              </p>
            ) : (
              <>
                <div className="space-y-1.5">
                  <Label>مبلغ التحصيل</Label>
                  <TouchNumberInput
                    type="number" min="0" step="0.01" dir="ltr"
                    value={amount}
                    onValueChange={touchValue => setAmount(touchValue)}
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
              {isPickup ? "رجوع" : "رجوع لإنشاء طلب"}
            </Button>
            {attempt && <Button onClick={() => void runPickup(attempt, true)} disabled={busy}>تأكيد نتيجة التحصيل</Button>}
            {!initialAttempt.error && !attempt && target && !settled && !shiftBlocked && (!isPickup || target.status === "READY") && (
              <Button variant={servable ? "outline" : "default"} onClick={() => collect(false)} disabled={busy}>
                {busy ? "جاري التحصيل…" : "تحصيل الدفع"}
              </Button>
            )}
            {!initialAttempt.error && !attempt && target && !settled && !shiftBlocked && servable && (!isPickup || exactPickupAmount) && (
              <Button data-testid="collect-and-serve" onClick={() => collect(true)} disabled={busy}>
                {busy ? "جاري…" : isPickup ? "حصّل وسلّم" : "حصّل وقدّم 🍽️"}
              </Button>
            )}
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
