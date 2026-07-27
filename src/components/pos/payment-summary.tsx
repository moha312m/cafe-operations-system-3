"use client";

import { money } from "@/lib/client";
import { t } from "@/lib/i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import type { CollectionMode, PaymentMethod, SplitMethod } from "./types";

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
  currency,
  subtotal,
  discountInput,
  discountAmount,
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
  currency: string;
  subtotal: number;
  discountInput: string;
  discountAmount: number;
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
  const mixedSum =
    (Number(mixed.CASH) || 0) + (Number(mixed.CARD) || 0) + (Number(mixed.WALLET) || 0);
  const collectNow = collectionMode === "NOW";
  const partial = collectionMode === "PARTIAL";
  const mixedMismatch = collectNow && method === "MIXED" && Math.abs(mixedSum - total) > 0.01;

  const paid = partial ? Math.min(Math.max(Number(paidInput) || 0, 0), total) : collectNow ? total : 0;
  const remaining = Math.max(total - paid, 0);
  const partialInvalid = partial && (paid <= 0 || paid > total + 0.001);

  return (
    <div className="space-y-3 border-t pt-3">
      {/* Collection mode selector */}
      <div className="space-y-1.5">
        <p className="text-xs font-medium text-muted-foreground">{t.collection.title}</p>
        <div className="grid grid-cols-3 gap-1.5">
          {COLLECTION.map((c) => (
            <button
              key={c.value}
              type="button"
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
          <Input
            type="number" min="0" step="0.01" placeholder="0.00" dir="ltr"
            className="h-7 w-28 text-end text-sm"
            value={paidInput}
            onChange={(e) => onPaidChange(e.target.value)}
          />
        </div>
      )}

      {/* Mixed split (collect now) */}
      {collectNow && method === "MIXED" && (
        <div className="space-y-1.5 rounded-lg border bg-muted/30 p-2">
          {SPLIT_FIELDS.map((f) => (
            <div key={f.key} className="flex items-center justify-between gap-2">
              <span className="text-xs text-muted-foreground">{f.label}</span>
              <Input
                type="number" min="0" step="0.01" placeholder="0.00" dir="ltr"
                className="h-7 w-28 text-end text-sm"
                value={mixed[f.key]}
                onChange={(e) => onMixedChange(f.key, e.target.value)}
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
          <Input
            type="number" min="0" step="0.01" placeholder="0.00" dir="ltr"
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

      <Button
        size="lg"
        className="h-12 w-full text-base font-semibold"
        disabled={placeDisabled || submitting || mixedMismatch || partialInvalid}
        onClick={onPlaceOrder}
      >
        {submitting
          ? t.pos.placing
          : collectNow
            ? `${t.pos.charge} ${money(total, currency)}`
            : partial
              ? `${t.collection.collectPayment} ${money(paid, currency)}`
              : `${t.pos.placeOrder} · ${money(total, currency)}`}
      </Button>
      {mixedMismatch && (
        <p className="text-center text-xs text-destructive">مبلغ الدفع لا يساوي إجمالي الطلب</p>
      )}
      {placeDisabled && disabledReason && (
        <p className="text-center text-xs text-muted-foreground">{disabledReason}</p>
      )}
    </div>
  );
}
