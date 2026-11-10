"use client";

import { useMemo, useState, useEffect } from "react";
import { Coffee, ChevronDown, ChevronUp, Flame, X, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export type PrepSummaryItem = {
  key: string;
  name: string;
  variantName: string | null;
  totalQuantity: number;
  inNewCount: number;
  inPrepCount: number;
  orderNumbers: number[];
};

export type OrderWithItems = {
  id: string;
  orderNumber: number;
  status: string;
  items: {
    id: string;
    productName: string;
    variantName: string | null;
    quantity: number;
    addOns?: { id: string; addOnName: string }[];
  }[];
};

/**
 * Pure aggregation function for KDS All-Day Prep Summary.
 * Scans active orders (CONFIRMED and PREPARING) and calculates total batch quantities per item.
 */
export function aggregatePrepItems(orders: OrderWithItems[]): PrepSummaryItem[] {
  const map = new Map<string, PrepSummaryItem>();

  for (const order of orders) {
    if (order.status !== "CONFIRMED" && order.status !== "PREPARING") {
      continue;
    }

    const isNew = order.status === "CONFIRMED";

    for (const item of order.items) {
      const key = `${item.productName.trim()}${item.variantName ? `__${item.variantName.trim()}` : ""}`;
      const qty = Number(item.quantity) || 0;
      if (qty <= 0) continue;

      const existing = map.get(key);
      if (existing) {
        existing.totalQuantity += qty;
        if (isNew) existing.inNewCount += qty;
        else existing.inPrepCount += qty;
        if (!existing.orderNumbers.includes(order.orderNumber)) {
          existing.orderNumbers.push(order.orderNumber);
        }
      } else {
        map.set(key, {
          key,
          name: item.productName.trim(),
          variantName: item.variantName ? item.variantName.trim() : null,
          totalQuantity: qty,
          inNewCount: isNew ? qty : 0,
          inPrepCount: isNew ? 0 : qty,
          orderNumbers: [order.orderNumber],
        });
      }
    }
  }

  return Array.from(map.values()).sort((a, b) => {
    // Highest quantity first, then alphabetically by name
    return b.totalQuantity - a.totalQuantity || a.name.localeCompare(b.name);
  });
}

export function KdsPrepSummary({
  orders,
  selectedItemKey,
  onSelectItemKey,
}: {
  orders: OrderWithItems[];
  selectedItemKey: string | null;
  onSelectItemKey: (key: string | null) => void;
}) {
  const [isOpen, setIsOpen] = useState(true);

  // Persist collapse/expand state
  useEffect(() => {
    try {
      const saved = localStorage.getItem("kds-prep-summary-open");
      if (saved !== null) {
        setIsOpen(saved === "1");
      }
    } catch {
      // Ignore storage errors
    }
  }, []);

  function toggleOpen() {
    const next = !isOpen;
    setIsOpen(next);
    try {
      localStorage.setItem("kds-prep-summary-open", next ? "1" : "0");
    } catch {
      // Ignore
    }
  }

  const summaryItems = useMemo(() => aggregatePrepItems(orders), [orders]);

  const totalUnits = useMemo(
    () => summaryItems.reduce((acc, curr) => acc + curr.totalQuantity, 0),
    [summaryItems]
  );

  const activeOrdersCount = useMemo(() => {
    const set = new Set<number>();
    summaryItems.forEach((item) => item.orderNumbers.forEach((n) => set.add(n)));
    return set.size;
  }, [summaryItems]);

  if (summaryItems.length === 0) {
    return null;
  }

  return (
    <div
      data-testid="kds-prep-summary"
      className="rounded-xl border border-amber-500/30 bg-gradient-to-r from-amber-500/5 via-card to-amber-500/5 p-3 shadow-sm transition-all dark:border-amber-400/20"
    >
      {/* ── Summary Header ── */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="flex size-7 items-center justify-center rounded-lg bg-amber-500/15 text-amber-700 dark:text-amber-400">
            <Flame className="size-4 animate-pulse" />
          </span>
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-bold text-foreground">
              أصناف مطلوب تجهيزها (All-Day Prep Summary)
            </h3>
            <Badge variant="secondary" className="text-xs font-semibold tabular-nums">
              {totalUnits} وحدة ({activeOrdersCount} طلب)
            </Badge>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {selectedItemKey && (
            <button
              type="button"
              onClick={() => onSelectItemKey(null)}
              className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-muted/80 hover:text-foreground"
            >
              <X className="size-3" />
              <span>إلغاء التحديد</span>
            </button>
          )}

          <button
            type="button"
            onClick={toggleOpen}
            className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs font-medium hover:bg-muted"
            title={isOpen ? "طي الشريط" : "توسيع الشريط"}
          >
            <span>{isOpen ? "طي" : "عرض الأصناف"}</span>
            {isOpen ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
          </button>
        </div>
      </div>

      {/* ── Aggregated Chips Ribbon ── */}
      {isOpen && (
        <div className="mt-2.5 flex flex-wrap gap-2 pt-1 border-t border-border/50">
          {summaryItems.map((item) => {
            const isSelected = selectedItemKey === item.key;

            return (
              <button
                key={item.key}
                type="button"
                onClick={() => onSelectItemKey(isSelected ? null : item.key)}
                className={cn(
                  "group flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs font-medium transition-all shadow-xs",
                  isSelected
                    ? "border-amber-500 bg-amber-500/20 text-amber-950 ring-2 ring-amber-500/30 dark:bg-amber-950/50 dark:text-amber-100"
                    : "border-border bg-card hover:border-amber-500/50 hover:bg-amber-500/10 text-foreground"
                )}
                title={`انقر لتظليل الطلبات (${item.orderNumbers.map((n) => `#${n}`).join(", ")})`}
              >
                {/* Quantity Pill */}
                <span className="flex min-w-6 h-5 items-center justify-center rounded-md bg-amber-600 px-1.5 text-[11px] font-black text-white shadow-xs tabular-nums">
                  {item.totalQuantity}×
                </span>

                {/* Name & Variant */}
                <span className="font-bold text-foreground">
                  {item.name}
                  {item.variantName && (
                    <span className="text-muted-foreground font-normal">
                      {" "}({item.variantName})
                    </span>
                  )}
                </span>

                {/* Status sub-indicator if mixed */}
                {(item.inNewCount > 0 || item.inPrepCount > 0) && (
                  <span className="text-[10px] text-muted-foreground ms-0.5">
                    ({item.inNewCount > 0 ? `${item.inNewCount} جديد` : ""}
                    {item.inNewCount > 0 && item.inPrepCount > 0 ? " · " : ""}
                    {item.inPrepCount > 0 ? `${item.inPrepCount} تحضير` : ""})
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
