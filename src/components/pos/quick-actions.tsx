"use client";

// Two shortcuts above the product grid:
//   • the branch's best sellers around this hour, one tap each;
//   • "repeat last order" once the customer's phone is typed.
// Both only fill the cart — pricing, availability and payment stay with the
// ordinary order flow and the server.

import { useEffect, useState } from "react";
import { api } from "@/lib/client";
import type { Product } from "@/components/pos/types";

export type RepeatItem = {
  productId: string;
  variantId: string | null;
  productName: string;
  variantName: string | null;
  quantity: number;
  notes: string | null;
  addOnIds: string[];
};

type LastOrder = { orderNumber: number; customerName: string | null; items: RepeatItem[] };

export function QuickActions({
  branchId,
  products,
  customerPhone,
  showPicks,
  onSelect,
  onRepeat,
}: {
  branchId: string;
  products: Product[];
  customerPhone: string;
  showPicks: boolean;
  onSelect: (product: Product) => void;
  onRepeat: (items: RepeatItem[]) => void;
}) {
  const [pickIds, setPickIds] = useState<string[]>([]);
  const [pickWindow, setPickWindow] = useState<"HOUR" | "ALL_DAY">("HOUR");
  const [last, setLast] = useState<LastOrder | null>(null);

  useEffect(() => {
    if (!branchId) return;
    let cancelled = false;
    const load = () =>
      api<{ window: "HOUR" | "ALL_DAY"; products: { productId: string }[] }>(
        `/api/pos/quick-picks?branchId=${branchId}`
      )
        .then((r) => {
          if (cancelled) return;
          setPickIds(r.products.map((p) => p.productId));
          setPickWindow(r.window);
        })
        .catch(() => {});
    load();
    const timer = setInterval(load, 15 * 60_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [branchId]);

  const digits = customerPhone.replace(/\D/g, "");
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      if (digits.length < 10) {
        if (!cancelled) setLast(null);
        return;
      }
      api<{ order: LastOrder | null }>(`/api/customers/last-order?phone=${encodeURIComponent(digits)}`)
        .then((r) => {
          if (!cancelled) setLast(r.order);
        })
        .catch(() => {
          if (!cancelled) setLast(null);
        });
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [digits]);

  const picks = pickIds
    .map((id) => products.find((p) => p.id === id))
    .filter((p): p is Product => !!p && p.isActive && p.isAvailable !== false);

  if ((!showPicks || picks.length === 0) && !last) return null;

  return (
    <div className="flex shrink-0 flex-col gap-2">
      {last && (
        <div
          data-testid="repeat-last-order"
          className="flex flex-wrap items-center gap-2 rounded-xl border border-violet-400/50 bg-violet-500/10 px-3 py-2 text-sm"
        >
          <span className="font-semibold text-violet-800 dark:text-violet-300">
            🔁 آخر طلب{last.customerName ? ` لـ ${last.customerName}` : ""}:
          </span>
          <span className="min-w-0 flex-1 truncate text-xs text-violet-900 dark:text-violet-200">
            {last.items
              .map((i) => `${i.quantity}× ${i.productName}${i.variantName ? ` (${i.variantName})` : ""}`)
              .join("، ")}
          </span>
          <button
            type="button"
            className="rounded-md bg-violet-600 px-3 py-1 text-xs font-semibold text-white"
            onClick={() => onRepeat(last.items)}
          >
            كرر الطلب
          </button>
        </div>
      )}
      {showPicks && picks.length > 0 && (
        <div data-testid="quick-picks" className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs font-medium text-muted-foreground">
            ⚡ {pickWindow === "HOUR" ? "الأكثر طلبًا الساعة دي" : "الأكثر طلبًا"}:
          </span>
          {picks.map((p) => (
            <button
              key={p.id}
              type="button"
              className="rounded-full border bg-card px-3 py-1 text-xs font-medium hover:border-primary/50 hover:bg-primary/5"
              onClick={() => onSelect(p)}
            >
              {p.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
