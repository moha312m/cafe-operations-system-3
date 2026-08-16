"use client";

import { useEffect, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { api, money } from "@/lib/client";
import { useApp } from "@/components/app-shell";
import {
  maxRedeemablePoints,
  pointsValue,
  type LoyaltyCalcSettings,
} from "@/lib/loyalty-calc";

export type LoyaltyRedeem = { points: number; discount: number };

type LookupCustomer = {
  id: string;
  name: string | null;
  phone: string;
  loyaltyPointsBalance: number;
  totalOrders: number;
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
// points-redemption control. Redemption reports {points, discount} up to
// the POS page, which folds the discount into the charge engine.
export function CustomerLoyalty({
  branchId,
  phone,
  customerName,
  orderTotalBeforeLoyalty,
  redeem,
  onPhoneChange,
  onRedeemChange,
}: {
  branchId?: string;
  phone: string;
  customerName: string;
  orderTotalBeforeLoyalty: number;
  redeem: LoyaltyRedeem;
  onPhoneChange: (phone: string) => void;
  onRedeemChange: (redeem: LoyaltyRedeem) => void;
}) {
  const { cafe, canKey } = useApp();
  const currency = cafe?.currency ?? "EGP";
  const canRedeem = canKey("loyalty.redeem_points");

  const [customer, setCustomer] = useState<LookupCustomer | null>(null);
  const [loyalty, setLoyalty] = useState<LoyaltyCalcSettings | null>(null);
  const [looked, setLooked] = useState(false); // a lookup finished for current phone
  const [pointsInput, setPointsInput] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  // Keep the redemption inside the allowed cap when the cart total changes.
  useEffect(() => {
    if (!customer || !loyalty || redeem.points === 0) return;
    const cap = maxRedeemablePoints(customer.loyaltyPointsBalance, orderTotalBeforeLoyalty, loyalty);
    if (redeem.points > cap) {
      const pts = Math.max(cap, 0);
      onRedeemChange({ points: pts, discount: pointsValue(pts, loyalty) });
      setPointsInput(pts > 0 ? String(pts) : "");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderTotalBeforeLoyalty]);

  function applyPoints(raw: string) {
    setPointsInput(raw);
    if (!customer || !loyalty) return;
    const pts = Math.floor(Number(raw) || 0);
    if (pts <= 0) { onRedeemChange({ points: 0, discount: 0 }); return; }
    const cap = maxRedeemablePoints(customer.loyaltyPointsBalance, orderTotalBeforeLoyalty, loyalty);
    const clamped = Math.min(pts, cap);
    onRedeemChange({ points: clamped, discount: pointsValue(clamped, loyalty) });
  }

  const cap = customer && loyalty
    ? maxRedeemablePoints(customer.loyaltyPointsBalance, orderTotalBeforeLoyalty, loyalty)
    : 0;
  const showRedeem =
    !!customer && !!loyalty && loyalty.enabled && canRedeem && customer.isActive &&
    customer.loyaltyPointsBalance > 0 && orderTotalBeforeLoyalty > 0;

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

      {/* Lookup result chip */}
      {looksComplete && looked && (
        customer ? (
          <div className="space-y-1 rounded-lg bg-blue-500/10 px-2.5 py-2 text-[11px] leading-snug text-blue-800 dark:text-blue-300">
            <p className="text-xs font-semibold">
              عميل موجود{customer.name ? `: ${customer.name}` : ""}
              {!customer.isActive && <span className="ms-1 text-red-600"> (معطّل)</span>}
            </p>
            <div className="flex flex-wrap gap-x-3 gap-y-0.5">
              <span>رصيد النقاط: <b className="tabular-nums">{customer.loyaltyPointsBalance}</b></span>
              <span>إجمالي الطلبات: <b className="tabular-nums">{customer.totalOrders}</b></span>
              <span>آخر زيارة: {lastVisitLabel(customer.lastOrderAt)}</span>
            </div>
          </div>
        ) : (
          <p className="rounded-lg bg-emerald-500/10 px-2.5 py-1.5 text-[11px] text-emerald-700 dark:text-emerald-400">
            عميل جديد — هيتسجل تلقائيًا مع الطلب{customerName.trim() ? ` باسم ${customerName.trim()}` : ""}.
          </p>
        )
      )}

      {/* Redemption */}
      {showRedeem && (
        cap > 0 ? (
          <div className="space-y-1.5 rounded-lg border border-amber-500/40 bg-amber-500/5 p-2">
            <p className="text-xs font-semibold">استخدام نقاط الولاء</p>
            <div className="flex items-center gap-1.5">
              <Input
                type="number"
                dir="ltr"
                min={0}
                max={cap}
                placeholder="0"
                className="h-9"
                value={pointsInput}
                onChange={(e) => applyPoints(e.target.value)}
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-9 shrink-0 px-2 text-xs"
                onClick={() => applyPoints(String(cap))}
              >
                الأقصى ({cap})
              </Button>
            </div>
            {redeem.points > 0 ? (
              <p className="text-[11px] text-amber-700 dark:text-amber-400">
                النقاط المستخدمة: <b className="tabular-nums">{redeem.points}</b> · خصم النقاط:{" "}
                <b className="tabular-nums">{money(redeem.discount, currency)}</b>
              </p>
            ) : (
              <p className="text-[11px] text-muted-foreground">
                قيمة الخصم المتاحة: {money(pointsValue(cap, loyalty!), currency)}
              </p>
            )}
          </div>
        ) : (
          <p className="text-[11px] text-muted-foreground">
            {customer!.loyaltyPointsBalance < (loyalty!.minPointsToRedeem ?? 0)
              ? `أقل عدد نقاط للاستخدام هو ${loyalty!.minPointsToRedeem} نقطة`
              : "لا يوجد رصيد نقاط كافي"}
          </p>
        )
      )}
    </div>
  );
}
