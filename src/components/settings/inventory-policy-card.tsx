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

  // The saved policy is fetched once, on mount, and the state lands in the
  // promise's callback rather than in the effect body. That is the shape the
  // effect rule asks for — the effect subscribes to an external system and
  // sets state when it answers — and `cancelled` is what keeps a card the
  // owner has already navigated away from from writing into a dead tree.
  useEffect(() => {
    let cancelled = false;

    api<{ mode: InventoryEnforcementMode }>("/api/cafe/inventory-policy")
      .then((r) => {
        if (cancelled) return;
        setSaved(r.mode);
        setChoice(r.mode);
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
      </CardContent>
    </Card>
  );
}
