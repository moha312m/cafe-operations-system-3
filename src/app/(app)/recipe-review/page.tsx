"use client";

// Recipe accuracy board.
//
// It lists what the café actually sells — each size on its own row — because
// that is what stock comes off and what a variance would later be charged
// against. A product row would hide the very thing this screen exists to
// expose: that a large and a small can be in completely different states.
//
// Where something is not ready it says which thing is missing, not "invalid".
// The point is to give whoever configures the menu a next action.

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/client";
import { PageHeader, LoadingState, EmptyState } from "@/components/cafe/ui";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type Status = "VERIFIED" | "INCOMPLETE" | "NOT_APPLICABLE";

type Row = {
  productId: string;
  productName: string;
  category: string | null;
  variantId: string | null;
  variantName: string | null;
  recipeId: string | null;
  defaultRecipeId: string | null;
  status: Status;
  source: string;
  structurallyValid: boolean;
  confirmed: boolean;
  costAvailable: boolean;
  varianceEligible: boolean;
  issues: string[];
};
type AddOnRow = {
  addOnId: string; addOnName: string; recipeId: string | null;
  status: Status; confirmed: boolean; issues: string[];
};
type Payload = {
  rows: Row[];
  addOns: AddOnRow[];
  summary: {
    products: number; sellableConfigurations: number; verified: number;
    incomplete: number; notApplicable: number; varianceEligiblePct: number;
    addOnsTotal: number; addOnsVerified: number;
  };
};

const STATUS_META: Record<Status, { label: string; cls: string }> = {
  VERIFIED: { label: "متأكدة", cls: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400" },
  INCOMPLETE: { label: "ناقصة", cls: "bg-amber-500/15 text-amber-700 dark:text-amber-400" },
  NOT_APPLICABLE: { label: "لا تنطبق", cls: "bg-foreground/8 text-muted-foreground" },
};

// Say the actual problem. "Invalid" tells nobody what to do next.
const ISSUE_LABELS: Record<string, string> = {
  MISSING_RECIPE: "لا توجد وصفة",
  MISSING_VARIANT_RECIPE: "وصفة الحجم ناقصة",
  MISSING_ADDON_RECIPE: "وصفة الإضافة ناقصة",
  INCOMPATIBLE_UNIT: "وحدة قياس غير متوافقة",
  INVALID_QUANTITY: "كمية غير صالحة",
  MISSING_COST: "تكلفة الخامة غير معروفة",
  INACTIVE_INGREDIENT: "خامة غير مفعّلة",
  NO_INGREDIENTS: "الوصفة بدون خامات",
  NOT_CONFIRMED: "محتاجة تأكيد",
  STALE_CONFIRMATION: "اتعدّلت بعد التأكيد",
};

export default function RecipeReviewPage() {
  const [data, setData] = useState<Payload | null>(null);
  const [filter, setFilter] = useState<"ALL" | Status | "NEEDS_CONFIRMATION">("ALL");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await api<Payload>("/api/recipes/review"));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "فشل التحميل");
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  async function confirm(recipeId: string) {
    setBusy(true);
    try {
      await api(`/api/recipes/${recipeId}/verify`, { method: "POST", body: {} });
      toast.success("تم تأكيد الوصفة");
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "فشل التأكيد");
    } finally { setBusy(false); }
  }

  async function copyToVariants(productId: string, variantIds: string[]) {
    setBusy(true);
    try {
      await api("/api/recipes/copy-to-variants", {
        method: "POST", body: { productId, variantIds },
      });
      // Deliberately not "done": the copies are starting points that still
      // need real quantities and a confirmation each.
      toast.success("اتنسخت كمسودة — راجع الكميات وأكّد كل حجم");
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "فشل النسخ");
    } finally { setBusy(false); }
  }

  if (!data) return <LoadingState />;

  const shown = data.rows.filter((r) =>
    filter === "ALL" ? true
      : filter === "NEEDS_CONFIRMATION" ? r.structurallyValid && !r.confirmed && r.status !== "NOT_APPLICABLE"
        : r.status === filter
  );

  const s = data.summary;
  const byProduct = new Map<string, Row[]>();
  for (const r of shown) {
    const arr = byProduct.get(r.productId) ?? [];
    arr.push(r);
    byProduct.set(r.productId, arr);
  }

  return (
    <>
      <PageHeader title="دقة الوصفات" subtitle="كل صنف بيتباع — بحجمه — وحالة وصفته">
        <Button size="sm" variant="outline" onClick={load} disabled={busy}>↻ تحديث</Button>
      </PageHeader>

      <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {[
          ["الأصناف المتباعة", String(s.sellableConfigurations)],
          ["متأكدة", String(s.verified)],
          ["ناقصة", String(s.incomplete)],
          ["مؤهّل لحساب الفروقات", `${s.varianceEligiblePct}%`],
        ].map(([k, v]) => (
          <div key={k} className="rounded-xl border bg-card p-3">
            <p className="text-xs text-muted-foreground">{k}</p>
            <p className="mt-0.5 font-heading text-xl font-bold tabular-nums">{v}</p>
          </div>
        ))}
      </div>

      <div className="mb-4 flex flex-wrap gap-1.5 text-sm">
        {([
          ["ALL", "الكل"], ["VERIFIED", "متأكدة"], ["INCOMPLETE", "ناقصة"],
          ["NOT_APPLICABLE", "لا تنطبق"], ["NEEDS_CONFIRMATION", "محتاجة تأكيد"],
        ] as const).map(([k, lbl]) => (
          <button key={k} onClick={() => setFilter(k)}
            className={cn(
              "rounded-lg px-3 py-1.5 font-medium transition-colors",
              filter === k ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground"
            )}>
            {lbl}
          </button>
        ))}
      </div>

      {shown.length === 0 ? (
        <EmptyState message="لا توجد أصناف في هذه الحالة" icon="📋" />
      ) : (
        <div className="space-y-3">
          {[...byProduct.entries()].map(([productId, rows]) => {
            const variantRows = rows.filter((r) => r.variantId);
            const canCopy = variantRows.length > 0 && rows[0].defaultRecipeId;
            return (
              <div key={productId} className="rounded-xl border bg-card">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2.5">
                  <div>
                    <p className="font-semibold">{rows[0].productName}</p>
                    {rows[0].category && (
                      <p className="text-xs text-muted-foreground">{rows[0].category}</p>
                    )}
                  </div>
                  {canCopy && (
                    <Button
                      size="sm" variant="outline" disabled={busy}
                      onClick={() => copyToVariants(productId, variantRows.map((r) => r.variantId!))}
                    >
                      نسخ الوصفة الأساسية للأحجام (كمسودة)
                    </Button>
                  )}
                </div>
                <div className="divide-y">
                  {rows.map((r) => (
                    <div key={`${r.productId}-${r.variantId ?? "base"}`}
                      className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5">
                      <div className="min-w-0">
                        <p className="text-sm font-medium">
                          {r.variantName ?? "بدون أحجام"}
                        </p>
                        {r.issues.length > 0 && (
                          <p className="mt-0.5 text-xs text-amber-700 dark:text-amber-400">
                            {r.issues.map((i) => ISSUE_LABELS[i] ?? i).join(" · ")}
                          </p>
                        )}
                      </div>
                      <div className="flex items-center gap-2">
                        {r.varianceEligible && (
                          <span className="rounded-full bg-sky-500/12 px-2 py-0.5 text-[10px] font-medium text-sky-700 dark:text-sky-400">
                            مؤهّل للفروقات
                          </span>
                        )}
                        <span className={cn("rounded-full px-2.5 py-0.5 text-xs font-medium", STATUS_META[r.status].cls)}>
                          {STATUS_META[r.status].label}
                        </span>
                        {/* Confirmation is offered only where the structure is
                            already sound — a signature cannot fix a broken recipe. */}
                        {r.structurallyValid && !r.confirmed && r.recipeId && (
                          <Button size="sm" disabled={busy} onClick={() => confirm(r.recipeId!)}>
                            تأكيد
                          </Button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="mt-6">
        <h2 className="mb-2 font-heading text-lg font-semibold">
          الإضافات ({data.summary.addOnsVerified}/{data.summary.addOnsTotal} متأكدة)
        </h2>
        <div className="rounded-xl border bg-card divide-y">
          {data.addOns.map((a) => (
            <div key={a.addOnId} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5">
              <div>
                <p className="text-sm font-medium">{a.addOnName}</p>
                {a.issues.length > 0 && (
                  <p className="mt-0.5 text-xs text-amber-700 dark:text-amber-400">
                    {a.issues.map((i) => ISSUE_LABELS[i] ?? i).join(" · ")}
                  </p>
                )}
              </div>
              <span className={cn("rounded-full px-2.5 py-0.5 text-xs font-medium", STATUS_META[a.status].cls)}>
                {STATUS_META[a.status].label}
              </span>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
