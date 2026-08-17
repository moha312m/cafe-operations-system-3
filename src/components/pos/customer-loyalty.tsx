"use client";

import { useEffect, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { api, money } from "@/lib/client";
import { useApp } from "@/components/app-shell";
import {
  maxRedeemablePoints,
  pointsValue,
  type LoyaltyCalcSettings,
} from "@/lib/loyalty-calc";
import type { CollectionMode } from "./types";

export type LoyaltyRedeem = { points: number; discount: number };

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

function lastVisitLabel(v: string | null): string {
  if (!v) return "لا يوجد";
  const days = Math.floor((Date.now() - new Date(v).getTime()) / 86_400_000);
  if (days <= 0) return "اليوم";
  if (days === 1) return "أمس";
  return `منذ ${days} يوم`;
}

// POS customer block: phone field + live lookup (عميل موجود/جديد) + the
// "نقاط الولاء" section with a modal redemption flow. Redemption reports
// {points, discount} up to the POS page, which folds the discount into
// the charge engine. Points can only be redeemed with تحصيل الآن (MVP
// rule — no pending-reservation edge cases).
export function CustomerLoyalty({
  branchId,
  phone,
  customerName,
  orderTotalBeforeLoyalty,
  previewTotalAfterDiscount,
  collectionMode,
  redeem,
  onPhoneChange,
  onRedeemChange,
}: {
  branchId?: string;
  phone: string;
  customerName: string;
  orderTotalBeforeLoyalty: number;
  // Exact post-discount total from the charge engine (loyalty discount
  // applies pre-tax, so total − discount would be wrong).
  previewTotalAfterDiscount: (loyaltyDiscount: number) => number;
  collectionMode: CollectionMode;
  redeem: LoyaltyRedeem;
  onPhoneChange: (phone: string) => void;
  onRedeemChange: (redeem: LoyaltyRedeem) => void;
}) {
  const { cafe, canKey } = useApp();
  const currency = cafe?.currency ?? "EGP";
  const canRedeem = canKey("loyalty.redeem_points");
  const collectNow = collectionMode === "NOW";

  const [customer, setCustomer] = useState<LookupCustomer | null>(null);
  const [loyalty, setLoyalty] = useState<LoyaltyCalcSettings | null>(null);
  const [looked, setLooked] = useState(false); // a lookup finished for current phone
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Redemption modal
  const [modalOpen, setModalOpen] = useState(false);
  const [pointsInput, setPointsInput] = useState("");
  const [modalError, setModalError] = useState<string | null>(null);

  const digits = phone.replace(/\D/g, "");
  const looksComplete = digits.length >= 10;

  // Debounced lookup once the phone looks complete.
  useEffect(() => {
    setLooked(false);
    setCustomer(null);
    if (redeem.points > 0) onRedeemChange({ points: 0, discount: 0 });
    setPointsInput("");
    if (!looksComplete || !branchId) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      try {
        const r = await api<{ customer: LookupCustomer | null; loyalty: LoyaltyCalcSettings }>(
          `/api/customers/lookup?phone=${encodeURIComponent(phone)}`
        );
        setCustomer(r.customer);
        setLoyalty(r.loyalty);
        setLooked(true);
      } catch {
        setLooked(false); // invalid number or no permission — stay quiet
      }
    }, 400);
    return () => { if (timer.current) clearTimeout(timer.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phone, branchId]);

  const cap = customer && loyalty
    ? maxRedeemablePoints(customer.loyaltyPointsBalance, orderTotalBeforeLoyalty, loyalty)
    : 0;

  // Applied redemption must stay valid as the cart or collection mode change.
  useEffect(() => {
    if (redeem.points === 0) return;
    if (!collectNow) {
      onRedeemChange({ points: 0, discount: 0 });
      setPointsInput("");
      return;
    }
    if (loyalty && redeem.points > cap) {
      const pts = Math.max(cap, 0);
      onRedeemChange({ points: pts, discount: pointsValue(pts, loyalty) });
      setPointsInput(pts > 0 ? String(pts) : "");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderTotalBeforeLoyalty, collectNow]);

  function applyFromModal() {
    if (!customer || !loyalty) return;
    const pts = Math.floor(Number(pointsInput) || 0);
    if (pts <= 0) return setModalError("اكتب عدد النقاط المستخدمة");
    if (pts > customer.loyaltyPointsBalance)
      return setModalError("لا يمكن استخدام نقاط أكثر من رصيد العميل");
    if (pts < loyalty.minPointsToRedeem)
      return setModalError(`أقل عدد نقاط للاستخدام هو ${loyalty.minPointsToRedeem} نقطة`);
    if (pts > cap)
      return setModalError(`لا يمكن أن يتجاوز خصم النقاط ${loyalty.maxRedeemPercentageOfOrder}٪ من قيمة الطلب`);
    setModalError(null);
    onRedeemChange({ points: pts, discount: pointsValue(pts, loyalty) });
    setModalOpen(false);
  }

  const modalPts = Math.floor(Number(pointsInput) || 0);
  const modalDiscount = loyalty ? pointsValue(Math.max(modalPts, 0), loyalty) : 0;

  const showLoyaltySection =
    !!customer && !!loyalty && loyalty.enabled && canRedeem && customer.isActive;

  return (
    <div className="space-y-2">
      <p className="text-xs font-medium text-muted-foreground">رقم الموبايل (لبرنامج الولاء)</p>
      <Input
        dir="ltr"
        inputMode="tel"
        placeholder="01xx xxx xxxx"
        value={phone}
        onChange={(e) => onPhoneChange(e.target.value)}
      />

      {/* Lookup result */}
      {looksComplete && looked && (
        customer ? (
          <div className="space-y-1 rounded-lg bg-blue-500/10 px-2.5 py-2 text-[11px] leading-snug text-blue-800 dark:text-blue-300">
            <p className="text-xs font-semibold">
              عميل موجود{customer.name ? `: ${customer.name}` : ""}
              {!customer.isActive && <span className="ms-1 text-red-600"> (معطّل)</span>}
            </p>
            <div className="flex flex-wrap gap-x-3 gap-y-0.5">
              <span>رصيد النقاط: <b className="tabular-nums">{customer.loyaltyPointsBalance}</b> نقطة</span>
              <span>إجمالي الطلبات: <b className="tabular-nums">{customer.totalOrders}</b></span>
              <span>آخر زيارة: {lastVisitLabel(customer.lastOrderAt)}</span>
            </div>
          </div>
        ) : (
          <p className="rounded-lg bg-emerald-500/10 px-2.5 py-1.5 text-[11px] text-emerald-700 dark:text-emerald-400">
            عميل جديد — سيتم إنشاء حساب له بعد تسجيل الطلب
            {customerName.trim() ? ` باسم ${customerName.trim()}` : ""}.
          </p>
        )
      )}

      {/* ── نقاط الولاء ── */}
      {showLoyaltySection && (
        <div className="space-y-1.5 rounded-lg border border-amber-500/40 bg-amber-500/5 p-2">
          <p className="text-xs font-semibold">نقاط الولاء</p>
          <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
            <span>رصيد النقاط الحالي: <b className="tabular-nums text-foreground">{customer!.loyaltyPointsBalance}</b></span>
            <span>قيمة الخصم المتاحة: <b className="tabular-nums text-foreground">{money(pointsValue(cap, loyalty!), currency)}</b></span>
          </div>

          {redeem.points > 0 ? (
            <div className="flex items-center justify-between rounded-md bg-emerald-500/10 px-2 py-1.5 text-xs text-emerald-700 dark:text-emerald-400">
              <span>
                النقاط المستخدمة: <b className="tabular-nums">{redeem.points}</b> · خصم النقاط:{" "}
                <b className="tabular-nums">{money(redeem.discount, currency)}</b>
              </span>
              <button
                type="button"
                className="text-[11px] font-medium text-red-600 underline"
                onClick={() => { onRedeemChange({ points: 0, discount: 0 }); setPointsInput(""); }}
              >
                إلغاء
              </button>
            </div>
          ) : !collectNow ? (
            <p className="text-[11px] text-amber-700 dark:text-amber-400">
              يمكن استخدام النقاط عند التحصيل الآن فقط
            </p>
          ) : customer!.loyaltyPointsBalance <= 0 ? (
            <Button size="sm" variant="outline" className="h-8 w-full text-xs" disabled>
              استخدام نقاط الولاء — لا يوجد رصيد نقاط
            </Button>
          ) : customer!.loyaltyPointsBalance < loyalty!.minPointsToRedeem ? (
            <p className="text-[11px] text-muted-foreground">
              أقل عدد نقاط للاستخدام هو {loyalty!.minPointsToRedeem} نقطة
            </p>
          ) : cap <= 0 ? (
            <p className="text-[11px] text-muted-foreground">لا يوجد رصيد نقاط كافي</p>
          ) : (
            <Button
              size="sm"
              variant="outline"
              className="h-8 w-full border-amber-500/60 text-xs font-semibold"
              onClick={() => {
                if (!phone.trim()) return; // guarded by section visibility anyway
                setPointsInput(String(cap));
                setModalError(null);
                setModalOpen(true);
              }}
            >
              ⭐ استخدام نقاط الولاء
            </Button>
          )}
        </div>
      )}

      {/* ── Redemption modal ── */}
      <Dialog open={modalOpen} onOpenChange={(o) => !o && setModalOpen(false)}>
        <DialogContent className="max-w-xs">
          <DialogHeader>
            <DialogTitle>استخدام نقاط الولاء</DialogTitle>
          </DialogHeader>
          {customer && loyalty && (
            <div className="space-y-3 text-sm">
              <div className="space-y-1 rounded-lg bg-muted/40 p-2.5 text-xs">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">رصيد العميل</span>
                  <span className="tabular-nums font-semibold">{customer.loyaltyPointsBalance} نقطة</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">قيمة النقطة</span>
                  <span className="tabular-nums">1 نقطة = {money(loyalty.pointValueAmount, currency)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">إجمالي الفاتورة</span>
                  <span className="tabular-nums">{money(orderTotalBeforeLoyalty, currency)}</span>
                </div>
              </div>
              <div className="space-y-1.5">
                <Label>عدد النقاط المستخدمة (الأقصى {cap})</Label>
                <Input
                  type="number" dir="ltr" min={0} max={cap}
                  value={pointsInput}
                  onChange={(e) => { setPointsInput(e.target.value); setModalError(null); }}
                />
              </div>
              <div className="space-y-1 text-xs">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">قيمة الخصم</span>
                  <span className="tabular-nums font-semibold text-emerald-600">
                    −{money(modalDiscount, currency)}
                  </span>
                </div>
                <div className="flex justify-between font-semibold">
                  <span>المتبقي بعد الخصم</span>
                  <span className="tabular-nums">
                    {money(Math.max(previewTotalAfterDiscount(modalDiscount), 0), currency)}
                  </span>
                </div>
              </div>
              {modalError && <p className="text-xs text-destructive">{modalError}</p>}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setModalOpen(false)}>إلغاء</Button>
            <Button onClick={applyFromModal}>تطبيق الخصم</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
