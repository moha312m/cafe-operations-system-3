"use client";
import { useId } from "react";
import { TouchNumberInput } from "@/components/pos/touch-number-input";

import { money } from "@/lib/client";
import { t } from "@/lib/i18n";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import type { CollectionMode, PaymentMethod, SplitMethod } from "./types";
import { useApp } from "@/components/app-shell";

const METHODS: { value: PaymentMethod; label: string; icon: string }[] = [
  { value: "CASH", label: t.paymentMethods.CASH, icon: "💵" },
  { value: "CARD", label: t.paymentMethods.CARD, icon: "💳" },
  { value: "WALLET", label: t.paymentMethods.WALLET, icon: "📱" },
  { value: "MIXED", label: t.paymentMethods.MIXED, icon: "🔀" },
];

const SPLIT_FIELDS: { key: SplitMethod; label: string }[] = [
  { key: "CASH", label: "مبلغ كاش" },
  { key: "CARD", label: "مبلغ فيزا" },
  { key: "WALLET", label: "مبلغ محفظة" },
];

const COLLECTION: { value: CollectionMode; label: string; icon: string }[] = [
  { value: "NOW", label: t.collection.now, icon: "💰" },
  { value: "PENDING", label: t.collection.pending, icon: "⏳" },
  { value: "PARTIAL", label: t.collection.partial, icon: "➗" },
];

export type MixedAmounts = { CASH: string; CARD: string; WALLET: string };

export function PaymentSummary({
  checkoutOnly = false,
  currency,
  subtotal,
  discountInput,
  discountError = null,
  discountAmount,
  loyaltyPoints = 0,
  loyaltyDiscount = 0,
  serviceCharge,
  taxRate,
  taxAmount,
  total,
  collectionMode,
  paidInput,
  method,
  mixed,
  placeDisabled,
  disabledReason,
  submitting,
  onDiscountChange,
  onCollectionModeChange,
  onPaidChange,
  onMethodChange,
  onMixedChange,
  onPlaceOrder,
}: {
  checkoutOnly?: boolean;
  currency: string;
  subtotal: number;
  discountInput: string;
  /** Set only when the invoice discount itself is the cause of the error; line-level errors leave it null. */
  discountError?: string | null;
  discountAmount: number;
  loyaltyPoints?: number;
  loyaltyDiscount?: number;
  serviceCharge: number;
  taxRate: number;
  taxAmount: number;
  total: number;
  collectionMode: CollectionMode;
  paidInput: string;
  method: PaymentMethod;
  mixed: MixedAmounts;
  placeDisabled: boolean;
  disabledReason: string | null;
  submitting: boolean;
  onDiscountChange: (value: string) => void;
  onCollectionModeChange: (mode: CollectionMode) => void;
  onPaidChange: (value: string) => void;
  onMethodChange: (method: PaymentMethod) => void;
  onMixedChange: (field: SplitMethod, value: string) => void;
  onPlaceOrder: () => void;
}) {
  const validationId = useId();
  const { canKey } = useApp();
  const canDiscount = canKey("pos.apply_discount");
  const discountInvalid = canDiscount && !!discountError;
  const mixedSum =
    (Number(mixed.CASH) || 0) + (Number(mixed.CARD) || 0) + (Number(mixed.WALLET) || 0);
  const collectNow = collectionMode === "NOW";
  const partial = collectionMode === "PARTIAL";
  const mixedMismatch = collectNow && method === "MIXED" && Math.abs(mixedSum - total) > 0.01;

  const paid = partial ? Math.min(Math.max(Number(paidInput) || 0, 0), total) : collectNow ? total : 0;
  const remaining = Math.max(total - paid, 0);
  const partialInvalid = partial && (!Number.isFinite(Number(paidInput)) || Number(paidInput) <= 0 || Number(paidInput) > total + 0.001);

  if (checkoutOnly) return <div className="space-y-2" data-testid="cashier-checkout">
    <div className="flex items-center justify-between gap-2 text-lg font-bold"><span>{t.finance.finalTotal}</span><span>{money(total,currency)}</span></div>
    <Button className="min-h-14 w-full text-base" disabled={placeDisabled || submitting || mixedMismatch || partialInvalid} onClick={onPlaceOrder}>
      {submitting ? t.pos.placing : collectNow ? `${t.pos.charge} ${money(total,currency)}` : partial ? `${t.collection.collectPayment} ${money(paid,currency)}` : `${t.pos.placeOrder} · ${money(total,currency)}`}
    </Button>
    {placeDisabled && disabledReason && <p className="text-sm text-muted-foreground">{disabledReason}</p>}
    {mixedMismatch && <p role="alert" className="text-sm text-destructive">مبلغ الدفع لا يساوي إجمالي الطلب</p>}
    {partialInvalid && <p role="alert" className="text-sm text-destructive">أدخل مبلغًا أكبر من صفر ولا يتجاوز الإجمالي.</p>}
  </div>;

  return (
    <div className="space-y-3">
      {/* Collection mode selector */}
      <div className="space-y-1.5">
        <p className="text-xs font-medium text-muted-foreground">{t.collection.title}</p>
        <div className="grid grid-cols-3 gap-1.5">
          {COLLECTION.map((c) => (
            <button
              key={c.value}
              type="button"
              aria-pressed={collectionMode === c.value}
              onClick={() => onCollectionModeChange(c.value)}
              className={cn(
                "flex flex-col items-center gap-0.5 rounded-lg border py-2 text-xs font-medium transition-colors",
                collectionMode === c.value
                  ? "border-primary bg-primary text-primary-foreground"
                  : "bg-card hover:bg-accent"
              )}
            >
              <span className="text-base">{c.icon}</span>
              {c.label}
            </button>
          ))}
        </div>
      </div>

      {/* Payment method (collect now / partial) */}
      {(collectNow || partial) && (
        <div className={cn("grid gap-1.5", partial ? "grid-cols-3" : "grid-cols-4")}>
          {METHODS.filter((m) => !partial || m.value !== "MIXED").map((m) => (
            <button
              key={m.value}
              type="button"
              aria-pressed={method === m.value}
              onClick={() => onMethodChange(m.value)}
              className={cn(
                "flex items-center justify-center gap-1 rounded-lg border py-1.5 text-xs font-medium transition-colors",
                method === m.value
                  ? "border-primary bg-primary text-primary-foreground"
                  : "bg-card hover:bg-accent"
              )}
            >
              <span>{m.icon}</span>
              {m.label}
            </button>
          ))}
        </div>
      )}

      {/* Partial amount */}
      {partial && (
        <div className="flex items-center justify-between gap-2 rounded-lg border bg-muted/30 p-2">
          <span className="text-xs text-muted-foreground">{t.collection.collectAmount}</span>
          <TouchNumberInput
            aria-label={t.collection.collectAmount}
            aria-invalid={partialInvalid}
            aria-describedby={partialInvalid ? `${validationId}-partial` : undefined}
            type="number" min="0" step="0.01" placeholder="0.00" dir="ltr"
            className="min-h-7 w-28 text-end text-sm"
            value={paidInput}
            onValueChange={touchValue => onPaidChange(touchValue)}
          />
        </div>
      )}

      {/* Mixed split (collect now) */}
      {collectNow && method === "MIXED" && (
        <div className="space-y-1.5 rounded-lg border bg-muted/30 p-2">
          {SPLIT_FIELDS.map((f) => (
            <div key={f.key} className="flex items-center justify-between gap-2">
              <span className="text-xs text-muted-foreground">{f.label}</span>
              <TouchNumberInput
                aria-label={f.label}
                aria-invalid={mixedMismatch}
                aria-describedby={mixedMismatch ? `${validationId}-mixed` : undefined}
                type="number" min="0" step="0.01" placeholder="0.00" dir="ltr"
                className="min-h-7 w-28 text-end text-sm"
                value={mixed[f.key]}
                onValueChange={touchValue => onMixedChange(f.key, touchValue)}
              />
            </div>
          ))}
          <div className={cn("flex items-center justify-between border-t pt-1 text-xs font-semibold", mixedMismatch ? "text-destructive" : "text-emerald-600")}>
            <span>الإجمالي المُدخل</span>
            <span className="tabular-nums">{money(mixedSum, currency)}</span>
          </div>
        </div>
      )}

      {/* Totals */}
      <div className="space-y-1 text-sm">
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">{t.pos.subtotal}</span>
          <span className="tabular-nums">{money(subtotal, currency)}</span>
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="text-muted-foreground">{t.pos.discount}</span>
          <TouchNumberInput
            type="number" min="0" step="0.01" placeholder="0.00" dir="ltr"
            className="min-h-7 w-24 text-end text-sm"
            value={discountInput}
            disabled={!canDiscount}
            aria-label={t.pos.discount}
            aria-invalid={discountInvalid}
            aria-describedby={discountInvalid ? `${validationId}-discount` : undefined}
            onValueChange={touchValue => onDiscountChange(touchValue)}
          />
        </div>
        {discountAmount > 0 && (
          <div className="flex items-center justify-between text-emerald-600">
            <span>{t.pos.discountApplied}</span>
            <span className="tabular-nums">−{money(discountAmount, currency)}</span>
          </div>
        )}
        {loyaltyDiscount > 0 && (
          <div className="flex items-center justify-between text-amber-600 dark:text-amber-400">
            <span>⭐ خصم النقاط ({loyaltyPoints} نقطة)</span>
            <span className="tabular-nums">−{money(loyaltyDiscount, currency)}</span>
          </div>
        )}
        {serviceCharge > 0 && (
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">{t.finance.service}</span>
            <span className="tabular-nums">{money(serviceCharge, currency)}</span>
          </div>
        )}
        {taxAmount > 0 && (
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">
              {t.finance.tax}{taxRate > 0 ? ` (${taxRate}٪)` : ""}
            </span>
            <span className="tabular-nums">{money(taxAmount, currency)}</span>
          </div>
        )}
        <Separator className="my-1.5" />
        <div className="flex items-center justify-between text-lg font-bold">
          <span>{t.finance.finalTotal}</span>
          <span className="tabular-nums">{money(total, currency)}</span>
        </div>
        {partial && (
          <>
            <div className="flex items-center justify-between text-emerald-600">
              <span>{t.collection.paid}</span>
              <span className="tabular-nums">{money(paid, currency)}</span>
            </div>
            <div className="flex items-center justify-between text-amber-600">
              <span>{t.collection.remaining}</span>
              <span className="tabular-nums">{money(remaining, currency)}</span>
            </div>
          </>
        )}
      </div>


      {mixedMismatch && (
        <p id={`${validationId}-mixed`} className="text-center text-xs text-destructive">مبلغ الدفع لا يساوي إجمالي الطلب</p>
      )}
      {partialInvalid && (
        <p id={`${validationId}-partial`} className="text-center text-xs text-destructive">أدخل مبلغًا أكبر من صفر ولا يتجاوز الإجمالي.</p>
      )}
      {discountInvalid && (
        <p id={`${validationId}-discount`} className="text-center text-xs text-destructive">{discountError}</p>
      )}
      {placeDisabled && disabledReason && !(discountInvalid && disabledReason === discountError) && (
        <p className="text-center text-xs text-muted-foreground">{disabledReason}</p>
      )}
    </div>
  );
}
