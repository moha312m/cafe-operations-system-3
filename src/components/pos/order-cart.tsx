"use client";
import type {ReactNode, Ref} from 'react';

import { Badge } from "@/components/ui/badge";
import { t } from "@/lib/i18n";
import { CartItem } from "./cart-item";
import {
  OrderTypeSelector,
  type CustomerDetails,
} from "./order-type-selector";
import { PaymentSummary, type MixedAmounts } from "./payment-summary";
import { CustomerLoyalty, type LoyaltyRedeem } from "./customer-loyalty";
import type { CartLine, CollectionMode, OrderType, PaymentMethod, SplitMethod } from "./types";

export function OrderCart({
  id,
  headingId,
  headingRef,
  discountControls,
  cart,
  currency,
  orderType,
  details,
  branchId,
  tableReloadKey,
  totalBeforeLoyalty,
  previewTotalAfterDiscount,
  redeem,
  onRedeemChange,
  subtotal,
  discountInput,
  discountError = null,
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
  onTypeChange,
  onDetailsChange,
  onQuantityChange,
  onRemove,
  onNoteChange,
  onDiscountChange,
  onCollectionModeChange,
  onPaidChange,
  onMethodChange,
  onMixedChange,
  onPlaceOrder,
}: {
  id?: string;
  headingId?: string;
  headingRef?: Ref<HTMLHeadingElement>;
  discountControls?:ReactNode;
  cart: CartLine[];
  currency: string;
  orderType: OrderType;
  details: CustomerDetails;
  branchId?: string;
  tableReloadKey?: number;
  totalBeforeLoyalty: number;
  previewTotalAfterDiscount: (loyaltyDiscount: number) => number;
  redeem: LoyaltyRedeem;
  onRedeemChange: (redeem: LoyaltyRedeem) => void;
  subtotal: number;
  discountInput: string;
  discountError?: string | null;
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
  onTypeChange: (type: OrderType) => void;
  onDetailsChange: (details: CustomerDetails) => void;
  onQuantityChange: (key: string, delta: number) => void;
  onRemove: (key: string) => void;
  onNoteChange: (key: string, note: string) => void;
  onDiscountChange: (value: string) => void;
  onCollectionModeChange: (mode: CollectionMode) => void;
  onPaidChange: (value: string) => void;
  onMethodChange: (method: PaymentMethod) => void;
  onMixedChange: (field: SplitMethod, value: string) => void;
  onPlaceOrder: () => void;
}) {
  const itemCount = cart.reduce((sum, line) => sum + line.quantity, 0);

  return (
    <aside id={id} className="cashier-cart flex w-full min-w-0 flex-col overflow-hidden rounded-xl border bg-card shadow-sm" aria-label="الطلب الحالي" aria-labelledby={headingId}>
      {/* Header (fixed) */}
      <div className="flex shrink-0 items-center justify-between border-b px-4 py-3">
        <h2 id={headingId} ref={headingRef} tabIndex={-1} className="rounded font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary">{t.pos.currentOrder}</h2>
        <Badge variant="secondary" className="tabular-nums">
          {itemCount} {t.pos.items}
        </Badge>
      </div>

      {/* Scroll region: order type + table + customer + cart items */}
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
        <OrderTypeSelector
          type={orderType}
          details={details}
          branchId={branchId}
          tableReloadKey={tableReloadKey}
          onTypeChange={onTypeChange}
          onDetailsChange={onDetailsChange}
        />

        {/* Customer profile + loyalty (phone lookup, points redemption) */}
        <div className="border-t pt-3">
          <CustomerLoyalty
            branchId={branchId}
            phone={details.customerPhone}
            customerName={details.customerName}
            orderTotalBeforeLoyalty={totalBeforeLoyalty}
            previewTotalAfterDiscount={previewTotalAfterDiscount}
            collectionMode={collectionMode}
            redeem={redeem}
            onPhoneChange={(customerPhone) => onDetailsChange({ ...details, customerPhone })}
            onRedeemChange={onRedeemChange}
          />
        </div>

        <div className="space-y-2 border-t pt-3">
          {discountControls}
          {cart.length === 0 ? (
            <div className="flex min-h-40 flex-col items-center justify-center gap-2 text-center">
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
      <div className="border-t pt-3">
        <PaymentSummary
          currency={currency}
          subtotal={subtotal}
          discountInput={discountInput}
          discountError={discountError}
          discountAmount={discountAmount}
          loyaltyPoints={redeem.points}
          loyaltyDiscount={redeem.discount}
          serviceCharge={serviceCharge}
          taxRate={taxRate}
          taxAmount={taxAmount}
          total={total}
          collectionMode={collectionMode}
          paidInput={paidInput}
          method={method}
          mixed={mixed}
          placeDisabled={placeDisabled}
          disabledReason={disabledReason}
          submitting={submitting}
          onDiscountChange={onDiscountChange}
          onCollectionModeChange={onCollectionModeChange}
          onPaidChange={onPaidChange}
          onMethodChange={onMethodChange}
          onMixedChange={onMixedChange}
          onPlaceOrder={onPlaceOrder}
        />
      </div>
      </div>
      <div className="shrink-0 border-t bg-card p-3">
        <PaymentSummary checkoutOnly currency={currency} subtotal={subtotal} discountInput={discountInput} discountAmount={discountAmount}
          serviceCharge={serviceCharge} taxRate={taxRate} taxAmount={taxAmount} total={total} collectionMode={collectionMode}
          paidInput={paidInput} method={method} mixed={mixed} placeDisabled={placeDisabled} disabledReason={disabledReason} submitting={submitting}
          onDiscountChange={onDiscountChange} onCollectionModeChange={onCollectionModeChange} onPaidChange={onPaidChange}
          onMethodChange={onMethodChange} onMixedChange={onMixedChange} onPlaceOrder={onPlaceOrder} />
      </div>
    </aside>
  );
}
