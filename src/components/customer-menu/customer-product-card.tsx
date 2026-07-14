"use client";

/* eslint-disable @next/next/no-img-element */

import { money } from "@/lib/client";
import { cn } from "@/lib/utils";
import { menuCategoryIcon, type MenuProduct } from "./types";

// Mobile-first list row: image (or emoji tile), name, description,
// price, add button. Unavailable products render dimmed with a badge.
export function CustomerProductCard({
  product,
  currency,
  onAdd,
}: {
  product: MenuProduct;
  currency: string;
  onAdd: (product: MenuProduct) => void;
}) {
  const unavailable = !product.isAvailable;

  return (
    <button
      type="button"
      disabled={unavailable}
      onClick={() => onAdd(product)}
      className={cn(
        "flex w-full items-center gap-3 rounded-xl border bg-card p-3 text-start shadow-sm transition-all",
        unavailable
          ? "cursor-not-allowed opacity-50"
          : "active:scale-[0.99] hover:border-primary/40 hover:shadow-md"
      )}
    >
      <div className="flex size-16 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-muted text-3xl">
        {product.imageUrl ? (
          <img
            src={product.imageUrl}
            alt={product.name}
            className="size-full object-cover"
          />
        ) : (
          menuCategoryIcon(product.category.name)
        )}
      </div>
      <div className="min-w-0 flex-1">
        <p className="font-semibold leading-tight">{product.name}</p>
        {product.description && (
          <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
            {product.description}
          </p>
        )}
        <p className="mt-1 text-sm font-bold tabular-nums">
          {product.variants.length > 0
            ? money(Math.min(...product.variants.map((v) => Number(v.price))), currency)
            : money(product.basePrice, currency)}
          {product.variants.length > 0 && (
            <span className="ms-1 text-xs font-normal text-muted-foreground">
              حسب الحجم
            </span>
          )}
        </p>
      </div>
      <span
        className={cn(
          "shrink-0 rounded-full px-3 py-1.5 text-xs font-semibold",
          unavailable
            ? "bg-muted text-muted-foreground"
            : "bg-primary text-primary-foreground"
        )}
      >
        {unavailable ? "غير متاح" : "أضف للطلب"}
      </span>
    </button>
  );
}
