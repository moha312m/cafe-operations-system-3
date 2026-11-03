"use client";

import { useState } from "react";
import { decimal, money, sumMoney, validCurrencyInput, type Decimal } from "@/lib/money";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { TONE_SURFACE } from "@/components/ui/tone";

export const CASH_DENOMINATIONS = [200, 100, 50, 20, 10, 5, 1] as const;
export type CashDenomination = (typeof CASH_DENOMINATIONS)[number];

// A distinct, non-glaring paper tone per note so the cashier finds a row by colour.
// The small notes share the neutral tone: the palette has only four hues.
const DENOMINATION_CARD: Record<CashDenomination, string> = {
  200: TONE_SURFACE.caramel,
  100: TONE_SURFACE.sage,
  50: TONE_SURFACE.clay,
  20: TONE_SURFACE.tide,
  10: "border-input bg-muted text-foreground",
  5: "border-input bg-muted text-foreground",
  1: "border-input bg-muted text-foreground",
};

export function computeDenominationTotal(
  counts: Partial<Record<CashDenomination, string>>,
  coins: string
): { total: string; valid: boolean } {
  const parts: Decimal[] = [];
  for (const denom of CASH_DENOMINATIONS) {
    const raw = counts[denom]?.trim() ?? "";
    if (!raw) continue;
    if (!/^\d+$/.test(raw)) return { total: "0.00", valid: false };
    try {
      const count = decimal(raw);
      if (count.lt(0) || count.gt(100000)) return { total: "0.00", valid: false };
      parts.push(count.times(denom));
    } catch {
      return { total: "0.00", valid: false };
    }
  }
  const coinRaw = coins.trim();
  if (coinRaw) {
    if (!validCurrencyInput(coinRaw)) return { total: "0.00", valid: false };
    try {
      const coinVal = decimal(coinRaw);
      if (coinVal.lt(0)) return { total: "0.00", valid: false };
      parts.push(coinVal);
    } catch {
      return { total: "0.00", valid: false };
    }
  }
  const sum = money(sumMoney(parts));
  return { total: sum.toFixed(2), valid: true };
}

export function CashDenominationCalculator({
  onApply,
}: {
  onApply: (touchValue: string) => void;
}) {
  const [counts, setCounts] = useState<Partial<Record<CashDenomination, string>>>({});
  const [coins, setCoins] = useState("");
  const result = computeDenominationTotal(counts, coins);

  return (
    <details
      className="rounded-2xl border border-input bg-card p-3 text-sm"
      data-testid="cash-denomination-calculator"
    >
      <summary className="cursor-pointer font-medium">
        حاسبة فئات النقدية المساعدة (200 · 100 · 50 · 20 · 10 · 5 · 1 ج.م + الفكة)
      </summary>
      <div className="mt-3 space-y-3">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {CASH_DENOMINATIONS.map((denom) => {
            const raw = counts[denom] ?? "";
            const sub = /^\d+$/.test(raw.trim())
              ? money(decimal(raw.trim()).times(denom)).toFixed(2)
              : "0.00";
            return (
              <label key={denom} className={`space-y-1 rounded-xl border p-2 text-xs ${DENOMINATION_CARD[denom]}`}>
                <span className="flex items-center justify-between font-medium">
                  <span>فئة {denom} ج.م</span>
                  <span className="tabular-nums opacity-80" dir="ltr">
                    {sub}
                  </span>
                </span>
                <Input
                  inputMode="numeric"
                  dir="ltr"
                  placeholder="0"
                  value={raw}
                  aria-label={`عدد أوراق فئة ${denom}`}
                  data-testid={`denom-input-${denom}`}
                  onChange={(e) =>
                    setCounts((prev) => ({ ...prev, [denom]: e.target.value }))
                  }
                />
              </label>
            );
          })}
          <label className={`space-y-1 rounded-xl border p-2 text-xs ${TONE_SURFACE.caramel}`}>
            <span className="flex items-center justify-between font-medium">
              <span>الفكة (عملات)</span>
              <span className="tabular-nums opacity-80" dir="ltr">
                {coins.trim() && validCurrencyInput(coins.trim())
                  ? money(coins.trim()).toFixed(2)
                  : "0.00"}
              </span>
            </span>
            <Input
              inputMode="decimal"
              dir="ltr"
              placeholder="0.00"
              value={coins}
              aria-label="مبلغ الفكة"
              data-testid="denom-input-coins"
              onChange={(e) => setCoins(e.target.value)}
            />
          </label>
        </div>
        <div className="surface-espresso flex flex-wrap items-center justify-between gap-2 rounded-xl p-3.5" data-testid="denom-total-bar">
          <p className="text-xs font-medium">
            إجمالي الفئات المحسوب:{" "}
            <span
              className="tabular-nums text-base font-bold text-emerald-200"
              dir="ltr"
              data-testid="denom-total"
            >
              {result.valid ? result.total : "غير صالح"}
            </span>
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              data-testid="denom-reset"
              onClick={() => {
                setCounts({});
                setCoins("");
              }}
            >
              تصفير الحاسبة
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={!result.valid}
              data-testid="denom-apply"
              onClick={() => onApply(result.total)}
            >
              تطبيق المجموع في خانة النقدية
            </Button>
          </div>
        </div>
      </div>
    </details>
  );
}
