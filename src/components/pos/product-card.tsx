"use client";

import { money } from "@/lib/client";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";
import { categoryIcon, type Product } from "./types";

export function ProductCard({
  product,
  currency,
  onSelect,
}: {
  product: Product;
  currency: string;
  onSelect: (product: Product) => void;
}) {
  const disabled = !product.isActive || product.isAvailable === false;
  const hasOptions =
    product.variants.some((v) => v.isActive) ||
    product.addOns.some((a) => a.addOn.isActive);

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onSelect(product)}
      className={cn(
        "group flex flex-col overflow-hidden rounded-xl border bg-card text-start shadow-sm transition-all",
        disabled
          ? "cursor-not-allowed opacity-45"
          : "hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md active:translate-y-0 active:scale-[0.98] active:shadow-sm"
      )}
    >
      {/* Image placeholder tile */}
      <div className="flex h-20 items-center justify-center bg-muted/60 text-3xl transition-colors group-hover:bg-muted">
        {categoryIcon(product.category.name)}
      </div>
      <div className="flex flex-1 flex-col gap-0.5 p-3">
        <p className="text-sm font-semibold leading-tight">{product.name}</p>
        <p className="text-xs text-muted-foreground">{product.category.name}</p>
        <p className="mt-auto pt-1.5 text-sm font-bold tabular-nums">
          {money(product.basePrice, currency)}
          {hasOptions && (
            <span className="ms-1 text-xs font-normal text-muted-foreground">
              {t.pos.plusOptions}
            </span>
          )}
        </p>
        {disabled && (
          <p className="text-xs font-medium text-destructive">{t.pos.unavailable}</p>
        )}
      </div>
    </button>
  );
}
