"use client";

// Payment & serving policy, as the owner sets it.
//
// The café answer is the one that matters for most places, so it comes first
// and is always shown. A branch override is an exception, not a step: a
// single-branch café never sees it, and a multi-branch café gets it behind a
// "use the café setting" checkbox that stays ticked until someone means to
// diverge. What is actually in force is spelled out either way, because the
// owner should never have to work out an inheritance rule in their head.

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/client";
import { t } from "@/lib/i18n";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

type Policy = "ALLOW_BEFORE_PAYMENT" | "REQUIRE_PAYMENT_FIRST";
type Effective = {
  dineIn: Policy;
  takeaway: Policy;
  dineInInherited: boolean;
  takeawayInherited: boolean;
};

function Choice({
  value, onChange, options, disabled,
}: {
  value: Policy;
  onChange: (v: Policy) => void;
  options: { value: Policy; label: string }[];
  disabled?: boolean;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          disabled={disabled}
          onClick={() => onChange(o.value)}
          className={
            "rounded-lg border-2 px-3 py-2 text-sm font-medium transition-colors disabled:opacity-50 " +
            (value === o.value
              ? "border-primary bg-primary text-primary-foreground"
              : "border-border bg-card hover:border-primary/40")
          }
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function ServingPolicyCard({
  branchId,
  showBranchOverride,
}: {
  branchId: string;
  showBranchOverride: boolean;
}) {
  const [cafe, setCafe] = useState<{ dineIn: Policy; takeaway: Policy } | null>(null);
  const [effective, setEffective] = useState<Effective | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [c, b] = await Promise.all([
        api<{ policy: { dineIn: Policy; takeaway: Policy } }>("/api/cafe/serving-policy"),
        branchId
          ? api<{ policy: Effective }>(`/api/branches/${branchId}/serving-policy`)
          : Promise.resolve(null),
      ]);
      setCafe(c.policy);
      if (b) setEffective(b.policy);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "فشل تحميل سياسة الدفع");
    }
  }, [branchId]);

  useEffect(() => { load(); }, [load]);

  async function saveCafe(next: { dineIn: Policy; takeaway: Policy }) {
    setBusy(true);
    try {
      await api("/api/cafe/serving-policy", {
        method: "PATCH",
        body: { dineInServingPolicy: next.dineIn, takeawayServingPolicy: next.takeaway },
      });
      setCafe(next);
      await load();
      toast.success(t.servingPolicy.saved);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "فشل الحفظ");
    } finally {
      setBusy(false);
    }
  }

  async function saveBranch(body: {
    dineInServingPolicyOverride?: Policy | null;
    takeawayServingPolicyOverride?: Policy | null;
  }) {
    setBusy(true);
    try {
      const r = await api<{ policy: Effective }>(`/api/branches/${branchId}/serving-policy`, {
        method: "PATCH",
        body,
      });
      setEffective(r.policy);
      toast.success(t.servingPolicy.saved);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "فشل الحفظ");
    } finally {
      setBusy(false);
    }
  }

  if (!cafe) return null;

  const inheritingBoth =
    !!effective && effective.dineInInherited && effective.takeawayInherited;

  const dineInOptions = [
    { value: "ALLOW_BEFORE_PAYMENT" as const, label: t.servingPolicy.allowBefore },
    { value: "REQUIRE_PAYMENT_FIRST" as const, label: t.servingPolicy.requireFirst },
  ];
  const takeawayOptions = [
    { value: "REQUIRE_PAYMENT_FIRST" as const, label: t.servingPolicy.requireFirstTakeaway },
    { value: "ALLOW_BEFORE_PAYMENT" as const, label: t.servingPolicy.allowBeforeTakeaway },
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t.servingPolicy.title}</CardTitle>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          {t.servingPolicy.hint}
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1.5">
          <p className="text-sm font-medium">{t.servingPolicy.dineIn}</p>
          <Choice
            value={cafe.dineIn}
            disabled={busy}
            options={dineInOptions}
            onChange={(v) => saveCafe({ ...cafe, dineIn: v })}
          />
        </div>

        <div className="space-y-1.5">
          <p className="text-sm font-medium">{t.servingPolicy.takeaway}</p>
          <Choice
            value={cafe.takeaway}
            disabled={busy}
            options={takeawayOptions}
            onChange={(v) => saveCafe({ ...cafe, takeaway: v })}
          />
        </div>

        {showBranchOverride && effective && (
          <div className="space-y-3 border-t pt-3">
            <p className="text-sm font-medium">{t.servingPolicy.branchSection}</p>

            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="size-4"
                checked={inheritingBoth}
                disabled={busy}
                onChange={(e) =>
                  saveBranch(
                    e.target.checked
                      ? { dineInServingPolicyOverride: null, takeawayServingPolicyOverride: null }
                      : {
                          dineInServingPolicyOverride: effective.dineIn,
                          takeawayServingPolicyOverride: effective.takeaway,
                        }
                  )
                }
              />
              {t.servingPolicy.useCafeDefault}
            </label>

            {inheritingBoth ? (
              // Nothing to configure — just say plainly what applies here.
              <p className="rounded-lg bg-muted/40 px-2.5 py-2 text-xs text-muted-foreground">
                {t.servingPolicy.effectiveNow}: {t.servingPolicy.dineIn}{" "}
                <span className="font-semibold">
                  {effective.dineIn === "ALLOW_BEFORE_PAYMENT"
                    ? t.servingPolicy.allowBefore
                    : t.servingPolicy.requireFirst}
                </span>{" "}
                · {t.servingPolicy.takeaway}{" "}
                <span className="font-semibold">
                  {effective.takeaway === "ALLOW_BEFORE_PAYMENT"
                    ? t.servingPolicy.allowBeforeTakeaway
                    : t.servingPolicy.requireFirstTakeaway}
                </span>{" "}
                ({t.servingPolicy.inherited})
              </p>
            ) : (
              <div className="space-y-3">
                <div className="space-y-1.5">
                  <p className="text-xs text-muted-foreground">{t.servingPolicy.dineIn}</p>
                  <Choice
                    value={effective.dineIn}
                    disabled={busy}
                    options={dineInOptions}
                    onChange={(v) => saveBranch({ dineInServingPolicyOverride: v })}
                  />
                </div>
                <div className="space-y-1.5">
                  <p className="text-xs text-muted-foreground">{t.servingPolicy.takeaway}</p>
                  <Choice
                    value={effective.takeaway}
                    disabled={busy}
                    options={takeawayOptions}
                    onChange={(v) => saveBranch({ takeawayServingPolicyOverride: v })}
                  />
                </div>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
