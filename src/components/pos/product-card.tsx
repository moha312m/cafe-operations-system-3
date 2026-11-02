"use client";

import { Coffee, Plus, SlidersHorizontal } from "lucide-react";
import { money } from "@/lib/client";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";
import type { Product } from "./types";

export function ProductCard({ product, currency, onSelect }: { product: Product; currency: string; onSelect: (product: Product) => void }) {
  const disabled = !product.isActive || product.isAvailable === false;
  const hasOptions = product.variants.some(v => v.isActive) || product.addOns.some(a => a.addOn.isActive);
  return <button type="button" disabled={disabled} onClick={() => onSelect(product)} className={cn(
    "cashier-product group flex min-h-40 flex-col gap-3 rounded-2xl border border-border/70 bg-card p-4 text-start shadow-sm transition-colors",
    disabled ? "cursor-not-allowed bg-muted/40" : "hover:border-primary hover:bg-primary/5 active:bg-primary/10"
  )}>
    <div className="flex w-full items-center justify-between gap-2">
      <span className="flex size-9 items-center justify-center rounded-xl bg-primary/8 text-primary"><Coffee aria-hidden="true" className="size-5" /></span>
      <span className="min-w-0 text-xs text-muted-foreground">{product.category.name}</span>
      {hasOptions ? <SlidersHorizontal aria-hidden="true" className="size-4 shrink-0 text-primary" /> : <Plus aria-hidden="true" className="size-4 shrink-0 text-primary" />}
    </div>
    <div className="min-w-0 flex-1">
      <p className="text-base font-semibold leading-relaxed [overflow-wrap:anywhere]">{product.name}</p>
      {product.sku && <p className="mt-1 break-all text-xs text-muted-foreground"><bdi dir="ltr">SKU {product.sku}</bdi></p>}
    </div>
    <div className="flex w-full flex-wrap items-end justify-between gap-1">
      <span className="text-lg font-bold tabular-nums">{money(product.basePrice, currency)}</span>
      {hasOptions && <span className="text-xs text-muted-foreground">{t.pos.plusOptions}</span>}
    </div>
    {disabled && <p className="text-sm font-medium text-destructive">{t.pos.unavailable} — {!product.isActive ? "الصنف موقوف" : "غير متاح للبيع حاليًا"}</p>}
  </button>;
}
