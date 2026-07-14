"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { api, money } from "@/lib/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { UNIT_LABEL } from "@/lib/inventory";
import {
  ingredientCost,
  unitsCompatible,
  profitFor,
  PROFIT_LABEL,
  round2,
  type Profitability,
} from "@/lib/costing";
import type { InventoryUnit } from "@prisma/client";

type InvItem = {
  id: string;
  name: string;
  unit: InventoryUnit;
  costPerUnit: string;
};
type Row = {
  inventoryItemId: string;
  quantity: string;
  unit: InventoryUnit;
  wastePercentage: string;
};

const UNITS = Object.keys(UNIT_LABEL) as InventoryUnit[];

const TIER_STYLE: Record<Profitability, string> = {
  high: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  medium: "bg-sky-500/15 text-sky-700 dark:text-sky-400",
  low: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  loss: "bg-destructive/10 text-destructive",
  "no-recipe": "bg-muted text-muted-foreground",
};

// وصفة والتكلفة — recipe editor + live cost/profit for one product.
export function RecipeEditor({
  productId,
  sellingPrice,
  currency = "EGP",
}: {
  productId: string;
  sellingPrice: number;
  currency?: string;
}) {
  const [inventory, setInventory] = useState<InvItem[]>([]);
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [inv, rec] = await Promise.all([
        api<{ items: InvItem[] }>("/api/inventory"),
        api<{ recipe: { inventoryItemId: string; quantity: string; unit: InventoryUnit; wastePercentage: string }[] }>(
          `/api/products/${productId}/recipe`
        ),
      ]);
      // Unique inventory items by name (recipes reference cafe-level items;
      // any branch copy is fine for cost — pick the first per name).
      const byName = new Map<string, InvItem>();
      for (const it of inv.items) if (!byName.has(it.name)) byName.set(it.name, it);
      setInventory([...byName.values()]);
      setRows(
        rec.recipe.map((r) => ({
          inventoryItemId: r.inventoryItemId,
          quantity: String(r.quantity),
          unit: r.unit,
          wastePercentage: String(r.wastePercentage ?? 0),
        }))
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "فشل تحميل الوصفة");
    } finally {
      setLoading(false);
    }
  }, [productId]);

  useEffect(() => {
    load();
  }, [load]);

  const invById = new Map(inventory.map((i) => [i.id, i]));

  function rowCost(r: Row): number | null {
    const inv = invById.get(r.inventoryItemId);
    if (!inv || !r.quantity) return null;
    if (!unitsCompatible(r.unit, inv.unit)) return null;
    return ingredientCost({
      quantity: Number(r.quantity),
      recipeUnit: r.unit,
      itemUnit: inv.unit,
      costPerUnit: Number(inv.costPerUnit),
      wastePercentage: Number(r.wastePercentage) || 0,
    });
  }

  const total = round2(rows.reduce((s, r) => s + (rowCost(r) ?? 0), 0));
  const hasRows = rows.length > 0;
  const profit = profitFor(sellingPrice, total, hasRows);

  function addRow() {
    const firstUnused = inventory.find(
      (i) => !rows.some((r) => r.inventoryItemId === i.id)
    );
    if (!firstUnused) {
      toast.info("مفيش خامات تانية تضيفها");
      return;
    }
    setRows([
      ...rows,
      { inventoryItemId: firstUnused.id, quantity: "", unit: firstUnused.unit, wastePercentage: "0" },
    ]);
  }

  async function save() {
    // Client-side unit-compat guard mirrors the server.
    for (const r of rows) {
      const inv = invById.get(r.inventoryItemId);
      if (inv && !unitsCompatible(r.unit, inv.unit)) {
        toast.error("وحدة القياس غير متوافقة مع الخامة");
        return;
      }
    }
    setBusy(true);
    try {
      await api(`/api/products/${productId}/recipe`, {
        method: "PUT",
        body: {
          items: rows
            .filter((r) => r.quantity && Number(r.quantity) > 0)
            .map((r) => ({
              inventoryItemId: r.inventoryItemId,
              quantity: Number(r.quantity),
              unit: r.unit,
              wastePercentage: Number(r.wastePercentage) || 0,
            })),
        },
      });
      toast.success("اتحفظت الوصفة");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "فشل حفظ الوصفة");
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return <p className="text-sm text-muted-foreground">جاري تحميل الوصفة…</p>;
  }
  if (inventory.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        مفيش خامات في المخزون — ضيف خامات في صفحة المخزون الأول عشان تعمل وصفة.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <Label>مكونات المنتج</Label>
        <Button size="sm" variant="outline" onClick={addRow}>
          إضافة خامة للوصفة
        </Button>
      </div>

      {rows.length === 0 && (
        <p className="rounded-md border border-dashed p-3 text-center text-xs text-muted-foreground">
          لا توجد وصفة — ضيف الخامات المستخدمة في تحضير المنتج.
        </p>
      )}

      {rows.map((r, i) => {
        const inv = invById.get(r.inventoryItemId);
        const cost = rowCost(r);
        const incompatible = inv && !unitsCompatible(r.unit, inv.unit);
        return (
          <div key={i} className="flex flex-wrap items-end gap-2 rounded-md border p-2">
            <div className="min-w-32 flex-1 space-y-1">
              <Label className="text-xs">الخامة</Label>
              <Select
                value={r.inventoryItemId}
                onValueChange={(v) => {
                  const next = [...rows];
                  const chosen = invById.get(v ?? "");
                  next[i] = { ...r, inventoryItemId: v ?? "", unit: chosen?.unit ?? r.unit };
                  setRows(next);
                }}
              >
                <SelectTrigger className="w-full">
                  <SelectValue>{inv?.name}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {inventory.map((it) => (
                    <SelectItem key={it.id} value={it.id}>
                      {it.name} ({UNIT_LABEL[it.unit]})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="w-20 space-y-1">
              <Label className="text-xs">الكمية</Label>
              <Input
                type="number"
                dir="ltr"
                className="h-9"
                value={r.quantity}
                onChange={(e) => {
                  const next = [...rows];
                  next[i] = { ...r, quantity: e.target.value };
                  setRows(next);
                }}
              />
            </div>
            <div className="w-24 space-y-1">
              <Label className="text-xs">الوحدة</Label>
              <Select
                value={r.unit}
                onValueChange={(v) => {
                  const next = [...rows];
                  next[i] = { ...r, unit: (v ?? r.unit) as InventoryUnit };
                  setRows(next);
                }}
              >
                <SelectTrigger className="w-full">
                  <SelectValue>{UNIT_LABEL[r.unit]}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {UNITS.map((u) => (
                    <SelectItem key={u} value={u}>{UNIT_LABEL[u]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="w-16 space-y-1">
              <Label className="text-xs">هالك %</Label>
              <Input
                type="number"
                dir="ltr"
                className="h-9"
                value={r.wastePercentage}
                onChange={(e) => {
                  const next = [...rows];
                  next[i] = { ...r, wastePercentage: e.target.value };
                  setRows(next);
                }}
              />
            </div>
            <div className="w-20 space-y-1">
              <Label className="text-xs">تكلفة الكمية</Label>
              <p className="h-9 pt-2 text-sm font-medium tabular-nums">
                {incompatible ? "—" : cost !== null ? money(cost, currency) : "—"}
              </p>
            </div>
            <Button
              size="sm"
              variant="ghost"
              className="text-destructive"
              onClick={() => setRows(rows.filter((_, j) => j !== i))}
            >
              ✕
            </Button>
            {incompatible && (
              <p className="w-full text-xs text-destructive">
                وحدة القياس غير متوافقة مع الخامة ({UNIT_LABEL[inv!.unit]})
              </p>
            )}
          </div>
        );
      })}

      <Separator />

      {/* Cost & profit summary */}
      <div className="grid grid-cols-2 gap-2 rounded-lg border p-3 text-sm sm:grid-cols-4">
        <div>
          <p className="text-xs text-muted-foreground">إجمالي تكلفة المنتج</p>
          <p className="font-bold tabular-nums">{money(total, currency)}</p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">سعر البيع</p>
          <p className="font-bold tabular-nums">{money(sellingPrice, currency)}</p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">الربح المتوقع</p>
          <p className="font-bold tabular-nums">{hasRows ? money(profit.profit, currency) : "—"}</p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">هامش الربح</p>
          <p className="flex items-center gap-1 font-bold tabular-nums">
            {hasRows ? `${profit.margin}٪` : "—"}
            {hasRows && (
              <Badge className={TIER_STYLE[profit.tier]}>{PROFIT_LABEL[profit.tier]}</Badge>
            )}
          </p>
        </div>
      </div>

      <Button onClick={save} disabled={busy} className="w-full">
        {busy ? "جاري الحفظ…" : "حفظ الوصفة"}
      </Button>
    </div>
  );
}
