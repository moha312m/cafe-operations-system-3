"use client";

import { Badge } from "@/components/ui/badge";
import { t } from "@/lib/i18n";
import { CartItem } from "./cart-item";
import {
  OrderTypeSelector,
  type CustomerDetails,
} from "./order-type-selector";
import { PaymentSummary, type MixedAmounts } from "./payment-summary";
import type { CartLine, OrderType, PaymentMethod, SplitMethod } from "./types";

export function OrderCart({
  cart,
  currency,
  orderType,
  details,
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
  onTypeChange,
  onDetailsChange,
  onQuantityChange,
  onRemove,
  onNoteChange,
  onDiscountChange,
  onMethodChange,
  onMixedChange,
  onPayNowChange,
  onPlaceOrder,
}: {
  cart: CartLine[];
  currency: string;
  orderType: OrderType;
  details: CustomerDetails;
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
  onTypeChange: (type: OrderType) => void;
  onDetailsChange: (details: CustomerDetails) => void;
  onQuantityChange: (key: string, delta: number) => void;
  onRemove: (key: string) => void;
  onNoteChange: (key: string, note: string) => void;
  onDiscountChange: (value: string) => void;
  onMethodChange: (method: PaymentMethod) => void;
  onMixedChange: (field: SplitMethod, value: string) => void;
  onPayNowChange: (payNow: boolean) => void;
  onPlaceOrder: () => void;
}) {
  const itemCount = cart.reduce((sum, line) => sum + line.quantity, 0);

  return (
    <aside className="flex w-full shrink-0 flex-col rounded-xl border bg-card shadow-sm lg:sticky lg:top-4 lg:h-[calc(100vh-5.5rem)] lg:w-88 xl:w-96">
      <div className="flex items-center justify-between border-b px-4 py-3">
        <h2 className="font-semibold">{t.pos.currentOrder}</h2>
        <Badge variant="secondary" className="tabular-nums">
          {itemCount} {t.pos.items}
        </Badge>
      </div>

      <div className="flex flex-1 flex-col gap-3 overflow-hidden p-3">
        <OrderTypeSelector
          type={orderType}
          details={details}
          onTypeChange={onTypeChange}
          onDetailsChange={onDetailsChange}
        />

        <div className="flex-1 space-y-2 overflow-y-auto">
          {cart.length === 0 ? (
            <div className="flex h-full min-h-32 flex-col items-center justify-center gap-2 text-center">
              <span className="text-4xl">🛒</span>
              <p className="text-sm font-medium">{t.pos.cartEmpty}</p>
              <p className="max-w-48 text-xs text-muted-foreground">
                {t.pos.cartEmptyHint}
              </p>
            </div>
          ) : (
            cart.map((line) => (
              <CartItem
                key={line.key}
                line={line}
                currency={currency}
                onQuantityChange={onQuantityChange}
                onRemove={onRemove}
                onNoteChange={onNoteChange}
              />
            ))
          )}
        </div>

        <PaymentSummary
          currency={currency}
          subtotal={subtotal}
          discountInput={discountInput}
          discountAmount={discountAmount}
          taxRate={taxRate}
          taxAmount={taxAmount}
          total={total}
          method={method}
          mixed={mixed}
          payNow={payNow}
          placeDisabled={placeDisabled}
          disabledReason={disabledReason}
          submitting={submitting}
          onDiscountChange={onDiscountChange}
          onMethodChange={onMethodChange}
          onMixedChange={onMixedChange}
          onPayNowChange={onPayNowChange}
          onPlaceOrder={onPlaceOrder}
        />
      </div>
    </aside>
  );
}
