"use client";

// Inventory & recipe enforcement, as the owner sets it.
//
// Three modes rather than a switch, because the two risks are not the same
// one. Selling past a balance we can COMPUTE is a priced decision; selling
// against a recipe nobody has written is an unknown draw on the shelf. The
// middle option exists so an owner can accept the first without the second,
// and the card says as much rather than leaving them to infer it.
//
// The last option is the one that can quietly corrupt a stock count, so it
// carries an explicit warning before it is saved — not a confirm dialog,
// which people click through, but the consequence stated where the choice is
// made.

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  ENFORCEMENT_MODE_DESCRIPTION,
  ENFORCEMENT_MODE_LABEL,
  INVENTORY_ENFORCEMENT_MODES,
  OVERRIDE_ALL_WARNING,
  type InventoryEnforcementMode,
} from "@/lib/inventory-policy";

export function InventoryPolicyCard() {
  const [saved, setSaved] = useState<InventoryEnforcementMode | null>(null);
  const [choice, setChoice] = useState<InventoryEnforcementMode | null>(null);
  const [busy, setBusy] = useState(false);
  const [savedPercent, setSavedPercent] = useState<number | null>(null);
  const [percentInput, setPercentInput] = useState("");
  const [percentBusy, setPercentBusy] = useState(false);

  // The saved policy is fetched once, on mount, and the state lands in the
  // promise's callback rather than in the effect body. That is the shape the
  // effect rule asks for — the effect subscribes to an external system and
  // sets state when it answers — and `cancelled` is what keeps a card the
  // owner has already navigated away from from writing into a dead tree.
  useEffect(() => {
    let cancelled = false;

    api<{ mode: InventoryEnforcementMode; lowStockAlertPercent: number }>("/api/cafe/inventory-policy")
      .then((r) => {
        if (cancelled) return;
        setSaved(r.mode);
        setChoice(r.mode);
        setSavedPercent(r.lowStockAlertPercent);
        setPercentInput(String(r.lowStockAlertPercent));
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        toast.error(
          e instanceof Error ? e.message : "فشل تحميل سياسة المخزون"
        );
      });

    return () => {
      cancelled = true;
    };
  }, []);

  async function save() {
    if (!choice || choice === saved) return;

    setBusy(true);

    try {
      const r = await api<{ mode: InventoryEnforcementMode }>(
        "/api/cafe/inventory-policy",
        {
          method: "PATCH",
          body: { mode: choice },
        }
      );

      setSaved(r.mode);
      setChoice(r.mode);
      toast.success("تم تحديث سياسة المخزون");
    } catch (e) {
      toast.error(
        e instanceof Error ? e.message : "فشل حفظ سياسة المخزون"
      );
      setChoice(saved);
    } finally {
      setBusy(false);
    }
  }

  const percentValue = Number(percentInput);
  const percentValid =
    percentInput.trim() !== "" && Number.isInteger(percentValue) && percentValue >= 0 && percentValue <= 90;

  async function savePercent() {
    if (!percentValid || percentValue === savedPercent) return;
    setPercentBusy(true);
    try {
      const r = await api<{ lowStockAlertPercent: number }>("/api/cafe/inventory-policy", {
        method: "PATCH",
        body: { lowStockAlertPercent: percentValue },
      });
      setSavedPercent(r.lowStockAlertPercent);
      setPercentInput(String(r.lowStockAlertPercent));
      toast.success("تم حفظ نسبة تنبيه المخزون");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "فشل حفظ نسبة التنبيه");
    } finally {
      setPercentBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">
          📦 سياسة المخزون والوصفات
        </CardTitle>
      </CardHeader>

      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          بتحدد الكاشير يعمل إيه لما الخامة تكون ناقصة أو الوصفة مش مضبوطة.
        </p>

        <div className="space-y-2">
          {INVENTORY_ENFORCEMENT_MODES.map((mode) => {
            const active = choice === mode;

            return (
              <button
                key={mode}
                type="button"
                disabled={busy || choice === null}
                onClick={() => setChoice(mode)}
                className={
                  "w-full rounded-lg border-2 p-3 text-start transition-colors disabled:opacity-50 " +
                  (active
                    ? "border-primary bg-primary/5"
                    : "border-border bg-card hover:border-primary/40")
                }
              >
                <div className="flex items-center gap-2">
                  <span
                    className={
                      "size-4 shrink-0 rounded-full border-2 " +
                      (active
                        ? "border-primary bg-primary"
                        : "border-muted-foreground/40")
                    }
                  />

                  <span className="text-sm font-semibold">
                    {ENFORCEMENT_MODE_LABEL[mode]}
                  </span>

                  {saved === mode && (
                    <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                      الحالي
                    </span>
                  )}
                </div>

                <p className="mt-1 text-xs text-muted-foreground">
                  {ENFORCEMENT_MODE_DESCRIPTION[mode]}
                </p>
              </button>
            );
          })}
        </div>

        {choice === "OVERRIDE_ALL" && (
          <p className="rounded-lg border-2 border-amber-400/60 bg-amber-50 p-3 text-xs leading-relaxed text-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
            {OVERRIDE_ALL_WARNING}
          </p>
        )}

        <div className="flex items-center gap-2">
          <Button
            onClick={save}
            disabled={busy || !choice || choice === saved}
          >
            حفظ
          </Button>

          {choice !== saved && !busy && (
            <span className="text-xs text-muted-foreground">
              فيه تغيير لسه متحفظش
            </span>
          )}
        </div>

        <div className="space-y-2 border-t pt-4">
          <p className="text-sm font-semibold">🔔 التنبيه قبل ما الخامة تخلص</p>
          <p className="text-xs text-muted-foreground">
            نبهني لما الخامة يفضل منها النسبة دي من آخر كمية اتوردت. لو الخامة ليها
            حد أدنى أكبر، هيتنبه عليه هو. الخامة اللي مفيش لها توريد مسجل هتتنبه
            بس على الحد الأدنى بتاعها أو لما تخلص. اكتب 0 لإيقاف التنبيه بالنسبة.
          </p>
          <div className="flex items-center gap-2">
            <Input
              type="number"
              dir="ltr"
              min={0}
              max={90}
              step={1}
              className="w-24"
              aria-label="نسبة التنبيه"
              value={percentInput}
              disabled={percentBusy || savedPercent === null}
              onChange={(e) => setPercentInput(e.target.value)}
            />
            <span className="text-sm text-muted-foreground">%</span>
            <Button
              variant="outline"
              onClick={savePercent}
              disabled={percentBusy || !percentValid || percentValue === savedPercent}
            >
              حفظ النسبة
            </Button>
          </div>
          {!percentValid && percentInput.trim() !== "" && (
            <p className="text-xs text-red-600">النسبة لازم تكون رقم صحيح من 0 لـ 90</p>
          )}
          {percentValid && percentValue > 0 && (
            <p className="text-xs text-muted-foreground">
              مثال: لو آخر توريد لبن كان 10 لتر، هيتنبه لما يفضل {(10 * percentValue) / 100} لتر.
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
