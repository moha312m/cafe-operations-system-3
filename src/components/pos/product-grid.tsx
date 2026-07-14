"use client";

import { t } from "@/lib/i18n";
import { ProductCard } from "./product-card";
import type { Product } from "./types";

export function ProductGrid({
  products,
  currency,
  onSelect,
}: {
  products: Product[];
  currency: string;
  onSelect: (product: Product) => void;
}) {
  if (products.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center rounded-xl border border-dashed">
        <p className="text-sm text-muted-foreground">{t.pos.noProducts}</p>
      </div>
    );
  }
  return (
    <div className="grid flex-1 auto-rows-min grid-cols-2 gap-3 overflow-y-auto pb-4 pe-1 sm:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
      {products.map((product) => (
        <ProductCard
          key={product.id}
          product={product}
          currency={currency}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}
