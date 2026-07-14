"use client";

import { useState } from "react";
import { money } from "@/lib/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { CustomerCartLine } from "./types";

// The cart line list: quantity controls, remove, per-item note.
export function CustomerCart({
  cart,
  currency,
  onQuantityChange,
  onRemove,
  onNoteChange,
}: {
  cart: CustomerCartLine[];
  currency: string;
  onQuantityChange: (key: string, delta: number) => void;
  onRemove: (key: string) => void;
  onNoteChange: (key: string, note: string) => void;
}) {
  const [notingKey, setNotingKey] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState("");

  if (cart.length === 0) {
    return (
      <p className="py-6 text-center text-sm text-muted-foreground">
        سلة الطلب فاضية — ارجع للمنيو واختار حاجة.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      {cart.map((line) => (
        <div key={line.key} className="rounded-lg border p-2.5">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold">
                {line.product.name}
                {line.variant && (
                  <span className="font-normal text-muted-foreground">
                    {" "}· {line.variant.name}
                  </span>
                )}
              </p>
              {line.addOns.length > 0 && (
                <p className="truncate text-xs text-muted-foreground">
                  + {line.addOns.map((a) => a.name).join("، ")}
                </p>
              )}
            </div>
            <p className="shrink-0 text-sm font-bold tabular-nums">
              {money(line.unitPrice * line.quantity, currency)}
            </p>
          </div>
          <div className="mt-1.5 flex items-center gap-1.5">
            <Button
              variant="outline"
              size="sm"
              className="size-8 p-0 text-base"
              aria-label="قلّل الكمية"
              onClick={() => onQuantityChange(line.key, -1)}
            >
              −
            </Button>
            <span className="w-7 text-center text-sm font-semibold tabular-nums">
              {line.quantity}
            </span>
            <Button
              variant="outline"
              size="sm"
              className="size-8 p-0 text-base"
              aria-label="زوّد الكمية"
              onClick={() => onQuantityChange(line.key, 1)}
            >
              +
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="ms-auto h-8 px-2 text-xs text-muted-foreground"
              onClick={() => {
                setNoteDraft(line.note);
                setNotingKey(line.key);
              }}
            >
              {line.note ? "✎ ملاحظة" : "+ ملاحظة"}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-8 px-2 text-xs text-destructive"
              onClick={() => onRemove(line.key)}
            >
              حذف
            </Button>
          </div>
          {notingKey === line.key ? (
            <Input
              autoFocus
              placeholder="مثلاً: من غير سكر، سخن زيادة"
              className="mt-2 h-8 text-xs"
              value={noteDraft}
              onChange={(e) => setNoteDraft(e.target.value)}
              onBlur={() => {
                setNotingKey(null);
                onNoteChange(line.key, noteDraft.trim());
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  setNotingKey(null);
                  onNoteChange(line.key, noteDraft.trim());
                }
              }}
            />
          ) : (
            line.note && (
              <p className="mt-1.5 rounded bg-amber-500/10 px-2 py-1 text-xs text-amber-700 dark:text-amber-400">
                📝 {line.note}
              </p>
            )
          )}
        </div>
      ))}
    </div>
  );
}
