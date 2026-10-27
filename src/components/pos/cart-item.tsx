"use client";

import { useState } from "react";
import { money } from "@/lib/client";
import { t } from "@/lib/i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { TouchNumberInput } from "./touch-number-input";
import type { CartLine } from "./types";

export function CartItem({
  line,
  currency,
  onQuantityChange,
  onRemove,
  onNoteChange,
}: {
  line: CartLine;
  currency: string;
  onQuantityChange: (key: string, delta: number) => void;
  onRemove: (key: string) => void;
  onNoteChange: (key: string, note: string) => void;
}) {
  const [editingNote, setEditingNote] = useState(false);
  const [noteDraft, setNoteDraft] = useState(line.note);

  function commitNote() {
    setEditingNote(false);
    if (noteDraft.trim() !== line.note) onNoteChange(line.key, noteDraft.trim());
  }

  return (
    <div className="rounded-lg border bg-card p-2.5">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-base font-semibold [overflow-wrap:anywhere]">
            {line.product.name}
            {line.variant && (
              <span className="font-normal text-muted-foreground">
                {" "}· {line.variant.name}
              </span>
            )}
          </p>
          {line.addOns.length > 0 && (
            <p className="text-sm text-muted-foreground [overflow-wrap:anywhere]">
              + {line.addOns.map((a) => a.name).join(", ")}
            </p>
          )}
          <p className="text-xs text-muted-foreground tabular-nums">
            {money(line.unitPrice, currency)} {t.pos.each}
          </p>
        </div>
        <p className="shrink-0 text-sm font-bold tabular-nums">
          {money(line.unitPrice * line.quantity, currency)}
        </p>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          className="min-h-14 min-w-14 p-0 text-xl"
          aria-label={`تقليل كمية ${line.product.name}`}
          disabled={line.quantity <= 1}
          onClick={() => onQuantityChange(line.key, -1)}
        >
          −
        </Button>
        <TouchNumberInput aria-label={`كمية ${line.product.name}`} className="w-36" value={line.quantity} min={1} step={1} integer required
          onValueChange={value => {const quantity=Number(value);if(Number.isSafeInteger(quantity)&&quantity>=1)onQuantityChange(line.key,quantity-line.quantity);}} />
        <Button
          variant="outline"
          size="sm"
          className="min-h-14 min-w-14 p-0 text-xl"
          aria-label={`زيادة كمية ${line.product.name}`}
          onClick={() => onQuantityChange(line.key, 1)}
        >
          +
        </Button>
      </div>
      {line.quantity <= 1 && <p className="mt-1 text-xs text-muted-foreground">أقل كمية 1 — استخدم حذف لإزالة الصنف.</p>}
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t pt-2">
        <Button
          variant="ghost"
          size="sm"
          className="px-3 text-sm text-muted-foreground"
          onClick={() => {
            setNoteDraft(line.note);
            setEditingNote(true);
          }}
        >
          {line.note ? `✎ ${t.pos.note}` : `+ ${t.pos.note}`}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="px-3 text-sm text-destructive"
          aria-label={t.common.remove}
          onClick={() => onRemove(line.key)}
        >
          {t.common.remove}
        </Button>
      </div>

      {editingNote ? (
        <Input
          autoFocus
          placeholder={t.pos.itemNotePlaceholder}
          className="mt-2 h-8 text-xs"
          value={noteDraft}
          onChange={(e) => setNoteDraft(e.target.value)}
          onBlur={commitNote}
          onKeyDown={(e) => e.key === "Enter" && commitNote()}
        />
      ) : (
        line.note && (
          <p className="mt-1.5 rounded bg-amber-500/10 px-2 py-1 text-xs text-amber-700 dark:text-amber-400">
            📝 {line.note}
          </p>
        )
      )}
    </div>
  );
}
