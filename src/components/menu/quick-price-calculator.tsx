"use client";

import { useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { money } from "@/lib/client";
import { cn } from "@/lib/utils";
import {
  suggestPrice,
  type RoundingMode,
  type MarginTier,
} from "@/lib/menu-pricing";

const TIER_STYLE: Record<MarginTier, string> = {
  high: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  medium: "bg-sky-500/15 text-sky-700 dark:text-sky-400",
  low: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  loss: "bg-destructive/10 text-destructive",
};

const TIER_LABEL: Record<MarginTier, string> = {
  high: "هامش مرتفع (≥ 60٪)",
  medium: "هامش متوازن (40–59٪)",
  low: "هامش منخفض (20–39٪)",
  loss: "هامش حرج (< 20٪)",
};

interface QuickPriceCalculatorProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  cost: number | null;
  currentPrice: number | string;
  currency?: string;
  onApply: (price: number) => void;
}

export function QuickPriceCalculator({
  open,
  onOpenChange,
  title,
  cost,
  currentPrice,
  currency = "EGP",
  onApply,
}: QuickPriceCalculatorProps) {
  const [multiplier, setMultiplier] = useState<number>(2.5);
  const [customCost, setCustomCost] = useState<string>("");
  const [roundingMode, setRoundingMode] = useState<RoundingMode>("NONE");
  const [roundingStep, setRoundingStep] = useState<number>(5);

  const effectiveCost =
    cost !== null && cost > 0
      ? cost
      : customCost && Number(customCost) > 0
        ? Number(customCost)
        : null;

  const result = useMemo(() => {
    if (!effectiveCost || effectiveCost <= 0 || multiplier <= 0) return null;
    try {
      return suggestPrice(effectiveCost, multiplier, roundingMode, roundingStep);
    } catch {
      return null;
    }
  }, [effectiveCost, multiplier, roundingMode, roundingStep]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span>⚡ حاسبة التسعير من التكلفة</span>
          </DialogTitle>
          <p className="text-xs text-muted-foreground">{title}</p>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* Cost display / custom input */}
          <div className="rounded-lg border bg-muted/30 p-3">
            {cost !== null && cost > 0 ? (
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">تكلفة الوصفة المعتمدة:</span>
                <span className="font-semibold tabular-nums text-foreground">
                  {money(cost, currency)}
                </span>
              </div>
            ) : (
              <div className="space-y-2">
                <p className="text-xs text-amber-600 dark:text-amber-400">
                  ⚠️ لا توجد تكلفة وصفة معتمدة. يمكنك إدخال تكلفة تجريبية:
                </p>
                <div className="flex items-center gap-2">
                  <Input
                    type="number"
                    step="0.5"
                    min="0"
                    placeholder="التكلفة التقديرية"
                    value={customCost}
                    onChange={(e) => setCustomCost(e.target.value)}
                  />
                  <span className="text-xs text-muted-foreground">{currency}</span>
                </div>
              </div>
            )}
          </div>

          {/* Multiplier Presets & Input */}
          <div className="space-y-2">
            <Label className="text-xs">معامل الاستثمار (Multiplier):</Label>
            <div className="flex items-center gap-2">
              {[2.0, 2.5, 3.0, 3.5].map((m) => (
                <Button
                  key={m}
                  type="button"
                  size="sm"
                  variant={multiplier === m ? "default" : "outline"}
                  className="flex-1"
                  onClick={() => setMultiplier(m)}
                >
                  ×{m.toFixed(1)}
                </Button>
              ))}
            </div>
            <div className="flex items-center gap-2 pt-1">
              <span className="text-xs text-muted-foreground">معامل مخصص:</span>
              <Input
                type="number"
                step="0.1"
                min="0.1"
                max="100"
                className="h-8 w-24 tabular-nums"
                value={multiplier}
                onChange={(e) => setMultiplier(Number(e.target.value) || 0)}
              />
            </div>
          </div>

          {/* Rounding Mode */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label className="text-xs">وضع التقريب:</Label>
              <Select
                value={roundingMode}
                onValueChange={(v) => setRoundingMode((v ?? "NONE") as RoundingMode)}
              >
                <SelectTrigger className="h-8 w-full">
                  <SelectValue>
                    {roundingMode === "NONE"
                      ? "بدون تقريب (قرشين)"
                      : roundingMode === "NEAREST"
                        ? "لأقرب خطوة (NEAREST)"
                        : "سقف لأعلى (UP)"}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="NONE">بدون تقريب (قرشين)</SelectItem>
                  <SelectItem value="NEAREST">لأقرب خطوة (NEAREST)</SelectItem>
                  <SelectItem value="UP">سقف لأعلى (UP)</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {roundingMode !== "NONE" && (
              <div className="space-y-1">
                <Label className="text-xs">خطوة التقريب:</Label>
                <Select
                  value={String(roundingStep)}
                  onValueChange={(v) => setRoundingStep(Number(v) || 5)}
                >
                  <SelectTrigger className="h-8 w-full">
                    <SelectValue>{`${roundingStep} ${currency}`}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="1">1 {currency}</SelectItem>
                    <SelectItem value="5">5 {currency}</SelectItem>
                    <SelectItem value="10">10 {currency}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>

          {/* Result Calculation Preview */}
          {result && (
            <div className="rounded-lg border border-primary/20 bg-primary/5 p-3 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">السعر المقترح:</span>
                <span className="text-xl font-bold tabular-nums text-primary">
                  {money(result.suggestedPrice.toNumber(), currency)}
                </span>
              </div>

              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>السعر الحالي:</span>
                <span className="tabular-nums">
                  {currentPrice ? money(Number(currentPrice), currency) : "—"}
                </span>
              </div>

              <div className="flex items-center justify-between pt-1 border-t">
                <span className="text-xs text-muted-foreground">الربح المتوقع:</span>
                <span className="text-xs font-semibold tabular-nums">
                  {money(result.profit.toNumber(), currency)}
                </span>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-1">
                <span className="text-xs text-muted-foreground">نسبة الهامش:</span>
                <Badge className={cn("text-xs font-medium", TIER_STYLE[result.tier])} variant="outline">
                  {result.margin.toFixed(1)}٪ — {TIER_LABEL[result.tier]}
                </Badge>
              </div>
            </div>
          )}
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            إلغاء
          </Button>
          <Button
            type="button"
            disabled={!result}
            onClick={() => {
              if (result) {
                onApply(result.suggestedPrice.toNumber());
                onOpenChange(false);
              }
            }}
          >
            تطبيق هذا السعر
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
