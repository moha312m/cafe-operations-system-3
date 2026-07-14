"use client";

import { money } from "@/lib/client";
import { t } from "@/lib/i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import type { PaymentMethod, SplitMethod } from "./types";

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

export type MixedAmounts = { CASH: string; CARD: string; WALLET: string };

export function PaymentSummary({
  currency,
  subtotal,
  discountInput,
  discountAmount,
  taxRate,
  taxAmount,
  total,
  method,
  mixed,
  payNow,
  placeDisabled,
  disabledReason,
  submitting,
  onDiscountChange,
  onMethodChange,
  onMixedChange,
  onPayNowChange,
  onPlaceOrder,
}: {
  currency: string;
  subtotal: number;
  discountInput: string;
  discountAmount: number;
  taxRate: number;
  taxAmount: number;
  total: number;
  method: PaymentMethod;
  mixed: MixedAmounts;
  payNow: boolean;
  placeDisabled: boolean;
  disabledReason: string | null;
  submitting: boolean;
  onDiscountChange: (value: string) => void;
  onMethodChange: (method: PaymentMethod) => void;
  onMixedChange: (field: SplitMethod, value: string) => void;
  onPayNowChange: (payNow: boolean) => void;
  onPlaceOrder: () => void;
}) {
  const mixedSum =
    (Number(mixed.CASH) || 0) + (Number(mixed.CARD) || 0) + (Number(mixed.WALLET) || 0);
  const mixedMismatch =
    payNow && method === "MIXED" && Math.abs(mixedSum - total) > 0.01;

  return (
    <div className="space-y-3 border-t pt-3">
      {/* Payment method — only relevant when charging now */}
      {payNow && (
        <>
          <div className="grid grid-cols-4 gap-1.5">
            {METHODS.map((m) => (
              <button
                key={m.value}
                type="button"
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

          {method === "MIXED" && (
            <div className="space-y-1.5 rounded-lg border bg-muted/30 p-2">
              {SPLIT_FIELDS.map((f) => (
                <div key={f.key} className="flex items-center justify-between gap-2">
                  <span className="text-xs text-muted-foreground">{f.label}</span>
                  <Input
                    type="number"
                    min="0"
                    step="0.01"
                    placeholder="0.00"
                    dir="ltr"
                    className="h-7 w-28 text-end text-sm"
                    value={mixed[f.key]}
                    onChange={(e) => onMixedChange(f.key, e.target.value)}
                  />
                </div>
              ))}
              <div
                className={cn(
                  "flex items-center justify-between border-t pt-1 text-xs font-semibold",
                  mixedMismatch ? "text-destructive" : "text-emerald-600"
                )}
              >
                <span>الإجمالي المُدخل</span>
                <span className="tabular-nums">{money(mixedSum, currency)}</span>
              </div>
            </div>
          )}
        </>
      )}

      <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
        <input
          type="checkbox"
          checked={payNow}
          onChange={(e) => onPayNowChange(e.target.checked)}
          className="size-3.5 accent-primary"
        />
        {t.pos.payNow}
      </label>

      {/* Totals */}
      <div className="space-y-1 text-sm">
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">{t.pos.subtotal}</span>
          <span className="tabular-nums">{money(subtotal, currency)}</span>
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="text-muted-foreground">{t.pos.discount}</span>
          <Input
            type="number"
            min="0"
            step="0.01"
            placeholder="0.00"
            dir="ltr"
            className="h-7 w-24 text-end text-sm"
            value={discountInput}
            onChange={(e) => onDiscountChange(e.target.value)}
          />
        </div>
        {discountAmount > 0 && (
          <div className="flex items-center justify-between text-emerald-600">
            <span>{t.pos.discountApplied}</span>
            <span className="tabular-nums">−{money(discountAmount, currency)}</span>
          </div>
        )}
        {taxRate > 0 && (
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">
              {t.pos.tax} ({taxRate}٪)
            </span>
            <span className="tabular-nums">{money(taxAmount, currency)}</span>
          </div>
        )}
        <Separator className="my-1.5" />
        <div className="flex items-center justify-between text-lg font-bold">
          <span>{t.pos.total}</span>
          <span className="tabular-nums">{money(total, currency)}</span>
        </div>
      </div>

      <Button
        size="lg"
        className="h-12 w-full text-base font-semibold"
        disabled={placeDisabled || submitting || mixedMismatch}
        onClick={onPlaceOrder}
      >
        {submitting
          ? t.pos.placing
          : payNow
            ? `${t.pos.charge} ${money(total, currency)}`
            : `${t.pos.placeOrder} · ${money(total, currency)}`}
      </Button>
      {mixedMismatch && (
        <p className="text-center text-xs text-destructive">
          مبلغ الدفع لا يساوي إجمالي الطلب
        </p>
      )}
      {placeDisabled && disabledReason && (
        <p className="text-center text-xs text-muted-foreground">{disabledReason}</p>
      )}
    </div>
  );
}
