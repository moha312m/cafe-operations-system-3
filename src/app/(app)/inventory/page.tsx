"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { api, money } from "@/lib/client";
import { useApp } from "@/components/app-shell";
import { FeatureGate } from "@/components/feature-gate";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { UNIT_LABEL, STOCK_STATUS_LABEL, TXN_LABEL } from "@/lib/inventory";
import { QuickPriceCalculator } from "@/components/menu/quick-price-calculator";

// ─────────────────────────── Types ───────────────────────────

type InvItem = {
  id: string;
  name: string;
  category: string | null;
  unit: keyof typeof UNIT_LABEL;
  currentStock: string;
  minimumStock: string;
  costPerUnit: string;
  supplierName: string | null;
  expiryDate: string | null;
  isActive: boolean;
  isCritical?: boolean;
  branchId: string;
  branch: { id: string; name: string };
  status: "ok" | "low" | "out";
  alertThreshold: number;
  stockValue: number;
};
type ReturnLine = { orderItemId: string; orderNumber: number; productName: string; eligibleQuantity: number; receipts: { receiptId: string; quantity: number; status: string; valuation: string; totalCost: string | null }[] };
type ReturnOptions = { linked: boolean; lines: ReturnLine[] };
type Summary = { totalItems: number; lowCount: number; outCount: number; totalValue: number };
type Branch = { id: string; name: string };

export type LinkedRecipe = {
  id: string;
  recipeId?: string;
  name: string;
  category: string;
  quantity: number;
  unit: string;
  sellingPrice: number;
};

const UNITS = Object.keys(UNIT_LABEL) as (keyof typeof UNIT_LABEL)[];
const MOVEMENT_TYPES = ["PURCHASE", "USAGE", "WASTE", "ADJUSTMENT", "RETURN"] as const;

const STATUS_STYLE: Record<InvItem["status"], string> = {
  ok: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  low: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  out: "bg-destructive/10 text-destructive",
};

type ItemForm = {
  id: string | null;
  name: string;
  category: string;
  branchId: string;
  unit: keyof typeof UNIT_LABEL;
  currentStock: string;
  minimumStock: string;
  costPerUnit: string;
  supplierName: string;
  expiryDate: string;
  isCritical: boolean;
  isSoldDirectly: boolean;
  portionSize: string;
  sellingPrice: string;
  menuCategoryId: string;
};

const emptyForm = (branchId = ""): ItemForm => ({
  id: null,
  name: "",
  category: "",
  branchId,
  unit: "PIECE",
  currentStock: "0",
  minimumStock: "0",
  costPerUnit: "0",
  supplierName: "",
  expiryDate: "",
  isCritical: false,
  isSoldDirectly: false,
  portionSize: "1",
  sellingPrice: "",
  menuCategoryId: "",
});

// ─────────────────────────── Page ───────────────────────────

export default function InventoryPage() {
  const { cafe, user, features, can, canKey } = useApp();
  const canManage = can("inventory:manage");
  const canMove = canKey("inventory.transactions");
  const canReturn = canKey("inventory.finished_returns");
  const currency = cafe?.currency ?? "EGP";

  const [items, setItems] = useState<InvItem[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [busy, setBusy] = useState(false);
  const [hasFinishedHistory, setHasFinishedHistory] = useState(false);
  const [showArchived, setShowArchived] = useState(false);

  // Filters
  const [search, setSearch] = useState("");
  const [branchFilter, setBranchFilter] = useState("all");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [shiftCountFilter, setShiftCountFilter] = useState<"all" | "every_shift" | "eod_only">("all");

  // Dialogs
  const [itemForm, setItemForm] = useState<ItemForm | null>(null);
  const [moveFor, setMoveFor] = useState<InvItem | null>(null);
  const [moveType, setMoveType] = useState<(typeof MOVEMENT_TYPES)[number]>("PURCHASE");
  const [moveQty, setMoveQty] = useState("");
  const [moveCost, setMoveCost] = useState("");
  const [moveNote, setMoveNote] = useState("");
  const [returnOptions, setReturnOptions] = useState<ReturnOptions | null>(null);
  const [returnLineId, setReturnLineId] = useState("");
  const [returnOrderSearch, setReturnOrderSearch] = useState("");
  const [transferOpen, setTransferOpen] = useState(false);
  const [tItemId, setTItemId] = useState("");
  const [tToBranch, setTToBranch] = useState("");
  const [tQty, setTQty] = useState("");
  const [tNote, setTNote] = useState("");
  const [menuCategories, setMenuCategories] = useState<{ id: string; name: string }[]>([]);
  const [linkedRecipes, setLinkedRecipes] = useState<LinkedRecipe[]>([]);
  const [quickCalcOpen, setQuickCalcOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const query = new URLSearchParams();
      if (!user.branchId && branchFilter !== "all") query.set("branchId", branchFilter);
      if (showArchived) query.set("includeArchived", "1");
      const data = await api<{ items: InvItem[]; summary: Summary; hasFinishedHistory: boolean }>(
        `/api/inventory?${query}`
      );
      setItems(data.items);
      setSummary(data.summary);
      setHasFinishedHistory(data.hasFinishedHistory);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "فشل تحميل المخزون");
    }
  }, [branchFilter, user.branchId, showArchived]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    api<{ categories: { id: string; name: string }[] }>("/api/categories")
      .then((c) => setMenuCategories(c.categories))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!user.branchId) {
      api<{ branches: Branch[] }>("/api/branches")
        .then((b) => setBranches(b.branches))
        .catch(() => {});
    }
  }, [user.branchId]);

  async function run(action: () => Promise<unknown>, success: string) {
    setBusy(true);
    try {
      await action();
      toast.success(success);
      await load();
      return true;
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "حصل خطأ");
      return false;
    } finally {
      setBusy(false);
    }
  }

  const categories = useMemo(
    () => [...new Set(items.map((i) => i.category).filter(Boolean))] as string[],
    [items]
  );

  const visible = useMemo(() => {
    const term = search.trim().toLowerCase();
    return items.filter(
      (i) =>
        (categoryFilter === "all" || i.category === categoryFilter) &&
        (statusFilter === "all" || i.status === statusFilter) &&
        (shiftCountFilter === "all" || (shiftCountFilter === "every_shift" ? !!i.isCritical : !i.isCritical)) &&
        (term === "" || i.name.toLowerCase().includes(term))
    );
  }, [items, search, categoryFilter, statusFilter, shiftCountFilter]);

  // ── Save item (add/edit) ──
  async function saveItem() {
    if (!itemForm) return;

    if (itemForm.isSoldDirectly) {
      const price = Number(itemForm.sellingPrice);
      if (itemForm.sellingPrice === "" || isNaN(price) || price < 0) {
        toast.error("يجب تحديد سعر بيع صالح للمنتج");
        return;
      }
      if (itemForm.unit === "GRAM" || itemForm.unit === "ML") {
        const portion = Number(itemForm.portionSize);
        if (itemForm.portionSize === "" || isNaN(portion) || portion <= 0) {
          toast.error("يجب تحديد حجم الحصة المباعة إذا كانت وحدة القياس بالجرام أو المليلتر");
          return;
        }
      }
    }

    const body = {
      name: itemForm.name,
      category: itemForm.category || undefined,
      branchId: itemForm.branchId,
      unit: itemForm.unit,
      minimumStock: Number(itemForm.minimumStock) || 0,
      costPerUnit: Number(itemForm.costPerUnit) || 0,
      supplierName: itemForm.supplierName || undefined,
      expiryDate: itemForm.expiryDate || undefined,
      isCritical: itemForm.isCritical,
      ...(itemForm.id ? {} : { currentStock: Number(itemForm.currentStock) || 0 }),
      isSoldDirectly: itemForm.isSoldDirectly,
      sellingPrice: itemForm.isSoldDirectly ? Number(itemForm.sellingPrice) : undefined,
      portionSize:
        itemForm.isSoldDirectly && (itemForm.unit === "GRAM" || itemForm.unit === "ML")
          ? Number(itemForm.portionSize)
          : undefined,
      menuCategoryId: itemForm.isSoldDirectly && itemForm.menuCategoryId ? itemForm.menuCategoryId : undefined,
    };
    const ok = await run(
      () =>
        itemForm.id
          ? api(`/api/inventory/${itemForm.id}`, { method: "PATCH", body })
          : api("/api/inventory", { method: "POST", body }),
      itemForm.id ? "اتعدّلت الخامة" : "اتضافت الخامة"
    );
    if (ok) setItemForm(null);
  }

  useEffect(() => {
    if (!moveFor) return;
    let active = true;
    api<ReturnOptions>(`/api/inventory/${moveFor.id}/movement`).then(data => { if (active) setReturnOptions(data); }).catch(e => { if (active) toast.error(e.message); });
    return () => { active = false; };
  }, [moveFor]);

  async function searchReturnOrder() {
    if (!moveFor) return;
    try { setReturnOptions(await api<ReturnOptions>(`/api/inventory/${moveFor.id}/movement?orderNumber=${encodeURIComponent(returnOrderSearch)}`)); setReturnLineId(""); }
    catch (e) { toast.error(e instanceof Error ? e.message : "تعذر البحث"); }
  }

  async function saveMovement() {
    if (!moveFor) return;
    const ok = await run(
      async () => {
        const response = await api<{ receipt?: { receiptId: string; status: string; valuation: string; replayed: boolean } }>(`/api/inventory/${moveFor.id}/movement`, {
          method: "POST",
          body: {
            type: moveType,
            ...(moveType === "RETURN" && returnOptions?.linked ? { orderItemId: returnLineId } : {}),
            quantity: Number(moveQty),
            unitCost: moveType === "PURCHASE" && moveCost ? Number(moveCost) : undefined,
            note: moveNote || undefined,
          },
        });
        if (response.receipt) {
          const r = response.receipt;
          toast.info(`${r.replayed ? "طلب مكرر — الإيصال السابق" : "إيصال مرتجع"} ${r.receiptId}: ${r.status === "PENDING" ? "معلّق — احفظ القطع منفصلة خارج الجرد والبيع" : "تمت الإضافة"}${r.valuation === "UNVALUED" ? " — تكلفة الاستهلاك الأصلي غير مسجلة" : r.valuation === "PENDING" ? " — التقييم معلّق" : " — بالتكلفة الأصلية"}`, { duration: 10000 });
        }
        return response;
      },
      "اتسجلت حركة المخزون"
    );
    if (ok) {
      setMoveFor(null);
      setMoveQty("");
      setMoveCost("");
      setMoveNote("");
    }
  }

  async function saveTransfer() {
    const ok = await run(
      () =>
        api("/api/inventory/transfer", {
          method: "POST",
          body: {
            inventoryItemId: tItemId,
            toBranchId: tToBranch,
            quantity: Number(tQty),
            note: tNote || undefined,
          },
        }),
      "تم التحويل بين الفروع"
    );
    if (ok) {
      setTransferOpen(false);
      setTItemId("");
      setTToBranch("");
      setTQty("");
      setTNote("");
    }
  }

  const canPickBranch = !user.branchId;
  const cards = [
    { label: "إجمالي الخامات", value: summary?.totalItems ?? 0, tone: "" },
    { label: "خامات قاربت على النفاد", value: summary?.lowCount ?? 0, tone: "text-amber-600" },
    { label: "خامات نفدت", value: summary?.outCount ?? 0, tone: "text-destructive" },
    {
      label: "قيمة المخزون التقريبية",
      value: money(summary?.totalValue ?? 0, currency),
      tone: "",
    },
  ];

  return (
    <FeatureGate enabled={features?.inventoryEnabled !== false || hasFinishedHistory}>
    <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={showArchived} onChange={e => setShowArchived(e.target.checked)} />إظهار المؤرشف للوصول لمرتجعات الطلبات الأصلية</label>
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">المخزون</h1>
        <div className="flex flex-wrap gap-2">
          {canManage && canPickBranch && branches.length > 1 && (
            <Button variant="outline" onClick={() => { setTItemId(""); setTToBranch(""); setTransferOpen(true); }}>
              🔁 تحويل بين الفروع
            </Button>
          )}
          <Button
            disabled={!canManage}
            onClick={() => {
              setLinkedRecipes([]);
              setItemForm(emptyForm(user.branchId ?? branches[0]?.id ?? ""));
            }}
          >
            إضافة خامة
          </Button>
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {cards.map((c) => (
          <Card key={c.label}>
            <CardHeader className="pb-1">
              <CardTitle className="text-sm font-normal text-muted-foreground">
                {c.label}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className={cn("text-2xl font-semibold tabular-nums", c.tone)}>
                {c.value}
              </p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Low stock alert banner */}
      {summary && (summary.lowCount > 0 || summary.outCount > 0) && (
        <div className="rounded-lg border border-amber-400/50 bg-amber-500/5 px-4 py-2 text-sm">
          ⚠️ تنبيهات المخزون:{" "}
          {summary.outCount > 0 && (
            <span className="font-medium text-destructive">
              {summary.outCount} خامة نفدت
            </span>
          )}
          {summary.outCount > 0 && summary.lowCount > 0 && " · "}
          {summary.lowCount > 0 && (
            <span className="font-medium text-amber-700 dark:text-amber-400">
              {summary.lowCount} خامة قاربت على النفاد
            </span>
          )}
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        <Input
          placeholder="ابحث عن خامة..."
          className="w-52"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        {canPickBranch && branches.length > 1 && (
          <Select value={branchFilter} onValueChange={(v) => setBranchFilter(v ?? "all")}>
            <SelectTrigger className="w-40">
              <SelectValue>
                {branchFilter === "all"
                  ? "كل الفروع"
                  : branches.find((b) => b.id === branchFilter)?.name}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">كل الفروع</SelectItem>
              {branches.map((b) => (
                <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <Select value={categoryFilter} onValueChange={(v) => setCategoryFilter(v ?? "all")}>
          <SelectTrigger className="w-40">
            <SelectValue>{categoryFilter === "all" ? "كل التصنيفات" : categoryFilter}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">كل التصنيفات</SelectItem>
            {categories.map((c) => (
              <SelectItem key={c} value={c}>{c}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v ?? "all")}>
          <SelectTrigger className="w-36">
            <SelectValue>
              {statusFilter === "all" ? "كل الحالات" : STOCK_STATUS_LABEL[statusFilter as InvItem["status"]]}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">كل الحالات</SelectItem>
            <SelectItem value="ok">متوفر</SelectItem>
            <SelectItem value="low">منخفض</SelectItem>
            <SelectItem value="out">نفد</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Shift & End-of-Day Count Quick Banner */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-primary/25 bg-primary/5 px-4 py-3 text-sm">
        <div className="space-y-0.5">
          <p className="font-semibold text-foreground">
            📋 نظام جرد الشيفتات ونهاية اليوم: <span className="text-primary">{items.filter((x) => x.isCritical).length} خامة</span> تُجرد في كل شيفت · و<span className="text-primary">{items.length} خامة (المخزون بالكامل)</span> تُجرد جرداً كلياً في آخر شيفت باليوم
          </p>
          <p className="text-xs text-muted-foreground">
            اضغط على زر «🔄 كل شيفت» أو «🌙 آخر اليوم فقط» أمام أي خامة في الجدول لتحديد الأصناف التي تُجرد كل شيفت.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex rounded-lg border bg-background p-0.5 text-xs">
            <button type="button" onClick={() => setShiftCountFilter("all")} className={cn("rounded-md px-2.5 py-1 font-medium transition-colors", shiftCountFilter === "all" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground")}>الكل ({items.length})</button>
            <button type="button" onClick={() => setShiftCountFilter("every_shift")} className={cn("rounded-md px-2.5 py-1 font-medium transition-colors", shiftCountFilter === "every_shift" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground")}>🔄 كل شيفت ({items.filter((x) => x.isCritical).length})</button>
            <button type="button" onClick={() => setShiftCountFilter("eod_only")} className={cn("rounded-md px-2.5 py-1 font-medium transition-colors", shiftCountFilter === "eod_only" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground")}>🌙 آخر اليوم فقط ({items.filter((x) => !x.isCritical).length})</button>
          </div>
          {canManage && (
            <Button
              size="sm"
              disabled={busy}
              onClick={() => {
                const targetBranchId = user.branchId ?? (branchFilter !== "all" ? branchFilter : branches[0]?.id ?? items[0]?.branchId);
                if (!targetBranchId) return;
                const selectedIds = items.filter((x) => x.branchId === targetBranchId && x.isCritical).map((x) => x.id);
                if (selectedIds.length === 0) {
                  toast.error("حدّد خامة واحدة على الأقل كـ «كل شيفت» من الجدول أولاً");
                  return;
                }
                void run(
                  () =>
                    api(`/api/branches/${targetBranchId}/handover-config`, {
                      method: "PATCH",
                      body: {
                        enabled: true,
                        mode: "SELECTED",
                        selectedItemIds: selectedIds,
                        schedule: "DAILY_LAST_HANDOVER",
                        weekday: null,
                        materials: { cadence: "EVERY_SHIFT", weekday: null, cutoff: null },
                      },
                    }),
                  `تم حفظ وتفعيل جرد (${selectedIds.length} خامة) كل شيفت + جرد كلي للمخزون في آخر شيفت باليوم`
                );
              }}
            >
              ⚡ حفظ وتفعيل: المحدد كل شيفت + كلي آخر اليوم
            </Button>
          )}
        </div>
      </div>

      {/* Items table */}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>اسم الخامة</TableHead>
            {canPickBranch && <TableHead>الفرع</TableHead>}
            <TableHead>التصنيف</TableHead>
            <TableHead>الكمية الحالية</TableHead>
            <TableHead>وحدة القياس</TableHead>
            <TableHead>الحد الأدنى</TableHead>
            <TableHead>تكلفة الوحدة</TableHead>
            <TableHead>القيمة التقريبية</TableHead>
            <TableHead>الحالة</TableHead>
            <TableHead>نوع الجرد</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {visible.map((i) => (
            <TableRow key={i.id}>
              <TableCell className="font-medium">
                {i.name}
                {i.supplierName && (
                  <span className="block text-xs text-muted-foreground">
                    المورد: {i.supplierName}
                  </span>
                )}
              </TableCell>
              {canPickBranch && (
                <TableCell className="text-sm text-muted-foreground">{i.branch.name}</TableCell>
              )}
              <TableCell className="text-sm text-muted-foreground">{i.category ?? "—"}</TableCell>
              <TableCell className="font-semibold tabular-nums">{Number(i.currentStock)}</TableCell>
              <TableCell className="text-sm">{UNIT_LABEL[i.unit]}</TableCell>
              <TableCell className="tabular-nums">
                {Number(i.minimumStock)}
                {i.alertThreshold > Number(i.minimumStock) && (
                  <span className="block text-xs text-muted-foreground">التنبيه عند {i.alertThreshold}</span>
                )}
              </TableCell>
              <TableCell className="tabular-nums">{money(i.costPerUnit, currency)}</TableCell>
              <TableCell className="tabular-nums">{money(i.stockValue, currency)}</TableCell>
              <TableCell>
                <span className={cn("rounded-full px-2 py-0.5 text-xs font-medium", STATUS_STYLE[i.status])}>
                  {STOCK_STATUS_LABEL[i.status]}
                </span>
              </TableCell>
              <TableCell>
                <button
                  type="button"
                  disabled={busy || !canManage}
                  onClick={() =>
                    void run(
                      () => api(`/api/inventory/${i.id}`, { method: "PATCH", body: { isCritical: !i.isCritical } }),
                      !i.isCritical ? `تم تحديد «${i.name}» للجرد في كل شيفت` : `تم تحويل «${i.name}» لجرد آخر اليوم فقط`
                    )
                  }
                  className={cn(
                    "whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors",
                    i.isCritical
                      ? "border-emerald-500/40 bg-emerald-500/15 text-emerald-800 hover:bg-emerald-500/25 dark:text-emerald-300"
                      : "border-border bg-muted/40 text-muted-foreground hover:bg-muted"
                  )}
                >
                  {i.isCritical ? "🔄 كل شيفت" : "🌙 آخر اليوم فقط"}
                </button>
              </TableCell>
              <TableCell className="text-end [&>button]:ms-1">
                <Button
                  size="sm"
                  disabled={!canMove && !canReturn}
                  onClick={() => {
                    setReturnOptions(null);
                    setReturnLineId("");
                    setReturnOrderSearch("");
                    setMoveType(canMove ? "PURCHASE" : "RETURN");
                    setMoveCost(String(i.costPerUnit));
                    setMoveFor(i);
                  }}
                >
                  حركة مخزون
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!canManage}
                  onClick={async () => {
                    setItemForm({
                      id: i.id,
                      name: i.name,
                      category: i.category ?? "",
                      branchId: i.branchId,
                      unit: i.unit,
                      currentStock: String(i.currentStock),
                      minimumStock: String(i.minimumStock),
                      costPerUnit: String(i.costPerUnit),
                      supplierName: i.supplierName ?? "",
                      expiryDate: i.expiryDate ? i.expiryDate.slice(0, 10) : "",
                      isCritical: !!i.isCritical,
                      isSoldDirectly: !!i.isSoldDirectly,
                      portionSize: i.unit === "GRAM" || i.unit === "ML" ? "80" : "1",
                      sellingPrice: "",
                      menuCategoryId: "",
                    });
                    setLinkedRecipes([]);
                    try {
                      const res = await api<{
                        isSoldDirectly: boolean;
                        sellingPrice: number | null;
                        portionSize: number | null;
                        menuCategoryId: string | null;
                        linkedRecipes: LinkedRecipe[];
                      }>(`/api/inventory/${i.id}`);
                      setItemForm((prev) =>
                        prev && prev.id === i.id
                          ? {
                              ...prev,
                              isSoldDirectly: res.isSoldDirectly ?? false,
                              sellingPrice:
                                res.sellingPrice !== null && res.sellingPrice !== undefined
                                  ? String(res.sellingPrice)
                                  : "",
                              portionSize:
                                res.portionSize !== null && res.portionSize !== undefined
                                  ? String(res.portionSize)
                                  : prev.portionSize,
                              menuCategoryId: res.menuCategoryId ?? "",
                            }
                          : prev
                      );
                      setLinkedRecipes(res.linkedRecipes ?? []);
                    } catch {
                      // Silently retain initial row state
                    }
                  }}
                >
                  تعديل
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-destructive"
                  disabled={busy || !canManage}
                  onClick={() =>
                    confirm(`أرشفة خامة «${i.name}»؟`) &&
                    run(() => api(`/api/inventory/${i.id}`, { method: "DELETE" }), "اتأرشفت الخامة")
                  }
                >
                  أرشفة
                </Button>
              </TableCell>
            </TableRow>
          ))}
          {visible.length === 0 && (
            <TableRow>
              <TableCell colSpan={canPickBranch ? 10 : 9} className="py-8 text-center text-muted-foreground">
                مفيش خامات مطابقة.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>

      {/* ── Add/Edit item dialog ── */}
      <Dialog open={itemForm !== null} onOpenChange={(o) => !o && setItemForm(null)}>
        <DialogContent className="max-h-[88vh] max-w-lg overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{itemForm?.id ? "تعديل بيانات الخامة" : "إضافة خامة جديدة"}</DialogTitle>
          </DialogHeader>
          {itemForm && (
            <div className="space-y-3">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label>اسم الخامة</Label>
                  <Input value={itemForm.name} onChange={(e) => setItemForm({ ...itemForm, name: e.target.value })} />
                </div>
                <div className="space-y-1.5">
                  <Label>التصنيف</Label>
                  <Input value={itemForm.category} onChange={(e) => setItemForm({ ...itemForm, category: e.target.value })} />
                </div>
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {canPickBranch && !itemForm.id && (
                  <div className="space-y-1.5">
                    <Label>الفرع</Label>
                    <Select value={itemForm.branchId} onValueChange={(v) => setItemForm({ ...itemForm, branchId: v ?? "" })}>
                      <SelectTrigger className="w-full">
                        <SelectValue placeholder="اختار">
                          {branches.find((b) => b.id === itemForm.branchId)?.name}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        {branches.map((b) => (
                          <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
                <div className="space-y-1.5">
                  <Label>وحدة القياس</Label>
                  <Select value={itemForm.unit} onValueChange={(v) => setItemForm({ ...itemForm, unit: (v ?? "PIECE") as keyof typeof UNIT_LABEL })}>
                    <SelectTrigger className="w-full">
                      <SelectValue>{UNIT_LABEL[itemForm.unit]}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {UNITS.map((u) => (
                        <SelectItem key={u} value={u}>{UNIT_LABEL[u]}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                {!itemForm.id && (
                  <div className="space-y-1.5">
                    <Label>الكمية الحالية</Label>
                    <Input type="number" dir="ltr" value={itemForm.currentStock} onChange={(e) => setItemForm({ ...itemForm, currentStock: e.target.value })} />
                  </div>
                )}
                <div className="space-y-1.5">
                  <Label>الحد الأدنى للتنبيه</Label>
                  <Input type="number" dir="ltr" value={itemForm.minimumStock} onChange={(e) => setItemForm({ ...itemForm, minimumStock: e.target.value })} />
                </div>
                <div className="space-y-1.5">
                  <Label>تكلفة الوحدة</Label>
                  <Input type="number" dir="ltr" value={itemForm.costPerUnit} onChange={(e) => setItemForm({ ...itemForm, costPerUnit: e.target.value })} />
                </div>
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label>المورد (اختياري)</Label>
                  <Input value={itemForm.supplierName} onChange={(e) => setItemForm({ ...itemForm, supplierName: e.target.value })} />
                </div>
                <div className="space-y-1.5">
                  <Label>تاريخ الصلاحية (اختياري)</Label>
                  <Input type="date" dir="ltr" value={itemForm.expiryDate} onChange={(e) => setItemForm({ ...itemForm, expiryDate: e.target.value })} />
                </div>
              </div>
              <label className="flex items-start gap-2.5 rounded-lg border border-border bg-muted/20 p-3 text-sm cursor-pointer">
                <input
                  type="checkbox"
                  className="mt-0.5 h-4 w-4 rounded border-gray-300"
                  checked={itemForm.isCritical}
                  onChange={(e) => setItemForm({ ...itemForm, isCritical: e.target.checked })}
                />
                <div className="space-y-0.5">
                  <span className="font-medium block">🔄 جرد هذه الخامة في كل شيفت</span>
                  <span className="text-xs text-muted-foreground block">
                    عند التحديد تُجرد الخامة عند نهاية كل شيفت، أما غير المحدد فيُجرد في الجرد الكلي آخر اليوم فقط.
                  </span>
                </div>
              </label>
              {/* ── Finished Good / Menu Linkage Toggle ── */}
              <div className="rounded-lg border border-border bg-card p-3 space-y-3">
                <label className="flex items-start gap-2.5 cursor-pointer">
                  <input
                    type="checkbox"
                    className="mt-0.5 h-4 w-4 rounded border-gray-300 accent-primary"
                    checked={itemForm.isSoldDirectly}
                    onChange={(e) => {
                      const checked = e.target.checked;
                      setItemForm({
                        ...itemForm,
                        isSoldDirectly: checked,
                        portionSize:
                          itemForm.unit === "GRAM" || itemForm.unit === "ML"
                            ? itemForm.portionSize || "80"
                            : "1",
                      });
                    }}
                  />
                  <div className="space-y-0.5">
                    <span className="font-medium text-sm block">
                      هذا الصنف يُباع كمنتج مباشر في المنيو (بضاعة جاهزة / Finished Good)
                    </span>
                    <span className="text-xs text-muted-foreground block">
                      ربط تلقائي بالمنيو ونظام الكاشير (POS) للبيع المباشر والخصم الفوري من المخزون.
                    </span>
                  </div>
                </label>

                {itemForm.isSoldDirectly && (
                  <div className="space-y-3 pt-2 border-t">
                    {/* Portion Size for GRAM / ML */}
                    {(itemForm.unit === "GRAM" || itemForm.unit === "ML") && (
                      <div className="space-y-1.5">
                        <Label className="text-xs font-semibold">
                          حجم الحصة المباعة في الطلب ({UNIT_LABEL[itemForm.unit]})
                        </Label>
                        <div className="flex items-center gap-2">
                          <Input
                            type="number"
                            dir="ltr"
                            placeholder="مثال: 80"
                            value={itemForm.portionSize}
                            onChange={(e) =>
                              setItemForm({ ...itemForm, portionSize: e.target.value })
                            }
                            className="w-32"
                          />
                          <span className="text-xs text-muted-foreground">
                            {itemForm.unit === "GRAM"
                              ? "جرام (مثلاً بولة آيس كريم 80 جم)"
                              : "مل (حجم الحصة)"}
                          </span>
                        </div>
                      </div>
                    )}

                    {/* Menu Category Selection */}
                    <div className="space-y-1.5">
                      <Label className="text-xs font-semibold">تصنيف المنيو</Label>
                      {menuCategories.length > 0 ? (
                        <Select
                          value={itemForm.menuCategoryId}
                          onValueChange={(v) =>
                            setItemForm({ ...itemForm, menuCategoryId: v ?? "" })
                          }
                        >
                          <SelectTrigger className="w-full">
                            <SelectValue placeholder="اختر تصنيف المنيو">
                              {menuCategories.find((c) => c.id === itemForm.menuCategoryId)?.name}
                            </SelectValue>
                          </SelectTrigger>
                          <SelectContent>
                            {menuCategories.map((c) => (
                              <SelectItem key={c.id} value={c.id}>
                                {c.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      ) : (
                        <p className="text-xs text-muted-foreground">
                          سيتم تعيين التصنيف تلقائياً باسم تصنيف الخامة أو «عام».
                        </p>
                      )}
                    </div>

                    {/* Selling Price and Quick Price Calculator */}
                    <div className="space-y-1.5">
                      <Label className="text-xs font-semibold">سعر البيع المقترح ({currency})</Label>
                      <div className="flex flex-wrap items-center gap-2">
                        <Input
                          type="number"
                          dir="ltr"
                          step="0.5"
                          placeholder="0.00"
                          className="min-w-32 flex-1"
                          value={itemForm.sellingPrice}
                          onChange={(e) =>
                            setItemForm({ ...itemForm, sellingPrice: e.target.value })
                          }
                        />
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="whitespace-nowrap gap-1 border-primary/30 text-primary hover:bg-primary/5"
                          onClick={() => setQuickCalcOpen(true)}
                        >
                          ⚡ احسب من التكلفة
                        </Button>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        التكلفة المحسوبة للحصة:{" "}
                        <span className="font-semibold tabular-nums text-foreground">
                          {money(
                            (Number(itemForm.costPerUnit) || 0) *
                              (itemForm.unit === "GRAM" || itemForm.unit === "ML"
                                ? Number(itemForm.portionSize) || 1
                                : 1),
                            currency
                          )}
                        </span>
                      </p>
                    </div>
                  </div>
                )}
              </div>

              {/* ── Linked Menu Recipes Section ── */}
              {itemForm.id && (
                <div className="rounded-lg border border-border bg-muted/15 p-3 space-y-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-xs font-semibold text-muted-foreground">
                      الأصناف والوصفات المرتبطة بهذه الخامة (Linked Menu Recipes)
                    </span>
                    {linkedRecipes.length > 0 && (
                      <Badge variant="secondary" className="text-xs">
                        {linkedRecipes.length} صنف
                      </Badge>
                    )}
                  </div>

                  {linkedRecipes.length > 0 ? (
                    <div className="space-y-2 max-h-48 overflow-y-auto">
                      {linkedRecipes.map((r) => (
                        <div
                          key={r.id + (r.recipeId ?? "")}
                          className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-card p-2 text-xs"
                        >
                          <div className="space-y-0.5">
                            <div className="flex items-center gap-1.5">
                              <span className="font-semibold text-foreground">{r.name}</span>
                              {r.category && (
                                <Badge variant="outline" className="text-[10px] px-1 py-0">
                                  {r.category}
                                </Badge>
                              )}
                            </div>
                            <p className="text-[11px] text-muted-foreground">
                              يستهلك {r.quantity}{" "}
                              {UNIT_LABEL[r.unit as keyof typeof UNIT_LABEL] ?? r.unit} — سعر البيع:{" "}
                              <span className="tabular-nums font-medium text-foreground">
                                {money(r.sellingPrice, currency)}
                              </span>
                            </p>
                          </div>
                          <a
                            href="/menu"
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 text-primary hover:underline font-medium text-xs whitespace-nowrap px-2 py-1 rounded hover:bg-primary/5"
                          >
                            تسعير في المنيو ↗
                          </a>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      لا توجد وصفات منيو معتمدة تستهلك هذه الخامة حالياً.
                    </p>
                  )}
                </div>
              )}

              {itemForm.id && (
                <p className="text-xs text-muted-foreground">
                  الكمية بتتعدّل من زرار «حركة مخزون» عشان يتسجل كل تغيير.
                </p>
              )}
            </div>
          )}
          <DialogFooter>
            <Button onClick={saveItem} disabled={busy || !itemForm?.name || !itemForm?.branchId}>
              {busy ? "جاري الحفظ…" : "حفظ"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Quick Price Calculator Dialog ── */}
      {itemForm && (
        <QuickPriceCalculator
          open={quickCalcOpen}
          onOpenChange={setQuickCalcOpen}
          title={`تسعير: ${itemForm.name || "خامة جديدة"}`}
          cost={
            (Number(itemForm.costPerUnit) || 0) *
            (itemForm.unit === "GRAM" || itemForm.unit === "ML"
              ? Number(itemForm.portionSize) || 1
              : 1)
          }
          currentPrice={itemForm.sellingPrice}
          currency={currency}
          onApply={(suggested) => {
            setItemForm({ ...itemForm, sellingPrice: String(suggested) });
          }}
        />
      )}

      {/* ── Movement dialog ── */}
      <Dialog open={moveFor !== null} onOpenChange={(o) => !o && setMoveFor(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>حركة مخزون — {moveFor?.name}</DialogTitle>
          </DialogHeader>
          {moveFor && (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                الكمية الحالية: <span className="font-semibold">{Number(moveFor.currentStock)} {UNIT_LABEL[moveFor.unit]}</span>
              </p>
              <div className="space-y-1.5">
                <Label>نوع الحركة</Label>
                <div className="flex flex-wrap gap-1.5">
                  {MOVEMENT_TYPES.filter(t => canMove || (canReturn && t === "RETURN")).map((t) => (
                    <Button
                      key={t}
                      size="sm"
                      variant={moveType === t ? "default" : "outline"}
                      onClick={() => setMoveType(t)}
                    >
                      {TXN_LABEL[t]}
                    </Button>
                  ))}
                </div>
              </div>
              <div className="space-y-1.5">
                {moveType === "RETURN" && <div className="space-y-2 rounded border p-3 text-sm">
                  <p>رد الأموال لا يعيد المخزون. سجل فقط القطع السليمة التي رجعت فعلياً. أثناء التجميد: احفظها منفصلة، خارج البيع والجرد حتى تتم الإضافة.</p>
                  {returnOptions?.linked && <>
                    <div className="flex gap-2"><Input aria-label="رقم الطلب الأصلي" value={returnOrderSearch} onChange={e => setReturnOrderSearch(e.target.value)} placeholder="رقم الطلب الأصلي" /><Button onClick={searchReturnOrder} variant="outline">بحث</Button></div>
                    <select aria-label="صنف الطلب الأصلي للمرتجع" className="w-full rounded border p-2" value={returnLineId} onChange={e => setReturnLineId(e.target.value)}>
                      <option value="">اختار صنف الطلب الأصلي</option>{returnOptions.lines.map(line => <option key={line.orderItemId} value={line.orderItemId}>#{line.orderNumber} — {line.productName} — متبقي {line.eligibleQuantity} قطعة</option>)}
                    </select>
                    {returnOptions.lines.find(line => line.orderItemId === returnLineId)?.receipts.map(r => <p key={r.receiptId}>{r.receiptId}: {r.quantity} قطعة — {r.status === "PENDING" ? "معلّق ومنفصل عن الجرد والبيع" : "تمت الإضافة"} — {r.valuation === "UNVALUED" ? "بدون تقييم؛ التكلفة الأصلية غير مسجلة" : r.valuation === "PENDING" ? "التقييم معلّق" : `القيمة الأصلية ${r.totalCost}`}</p>)}
                  </>}
                  <p>قيمة المخزون تقدير بالتكلفة المرجعية الحالية؛ قيمة المرتجع بالتكلفة الأصلية وقد تختلف القيمتان.</p>
                </div>}
                <Label>الكمية {moveType === "ADJUSTMENT" && "(موجب زيادة / سالب نقص)"}</Label>
                <Input type="number" dir="ltr" value={moveQty} onChange={(e) => setMoveQty(e.target.value)} placeholder="0" />
              </div>
              {moveType === "PURCHASE" && (
                <div className="space-y-1.5">
                  <Label>تكلفة الوحدة</Label>
                  <Input type="number" dir="ltr" value={moveCost} onChange={(e) => setMoveCost(e.target.value)} />
                </div>
              )}
              <div className="space-y-1.5">
                <Label>ملاحظة (اختياري)</Label>
                <Textarea rows={2} value={moveNote} onChange={(e) => setMoveNote(e.target.value)} />
              </div>
            </div>
          )}
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setMoveFor(null)}>إلغاء</Button>
            <Button onClick={saveMovement} disabled={busy || !moveQty || (moveType === "RETURN" && (!returnOptions || (returnOptions.linked && (!returnLineId || moveNote.trim().length < 3))))}>
              {busy ? "جاري الحفظ…" : "حفظ الحركة"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Transfer dialog ── */}
      <Dialog open={transferOpen} onOpenChange={setTransferOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>تحويل بين الفروع</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>الخامة (الفرع المصدر)</Label>
              <Select value={tItemId} onValueChange={(v) => setTItemId(v ?? "")}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="اختار الخامة">
                    {(() => {
                      const it = items.find((i) => i.id === tItemId);
                      return it ? `${it.name} — ${it.branch.name} (${Number(it.currentStock)} ${UNIT_LABEL[it.unit]})` : "";
                    })()}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {items.filter((i) => Number(i.currentStock) > 0).map((i) => (
                    <SelectItem key={i.id} value={i.id}>
                      {i.name} — {i.branch.name} ({Number(i.currentStock)} {UNIT_LABEL[i.unit]})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>الفرع المستلم</Label>
              <Select value={tToBranch} onValueChange={(v) => setTToBranch(v ?? "")}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="اختار الفرع">
                    {branches.find((b) => b.id === tToBranch)?.name}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {branches
                    .filter((b) => b.id !== items.find((i) => i.id === tItemId)?.branchId)
                    .map((b) => (
                      <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>الكمية المحولة</Label>
              <Input type="number" dir="ltr" value={tQty} onChange={(e) => setTQty(e.target.value)} placeholder="0" />
            </div>
            <div className="space-y-1.5">
              <Label>ملاحظة (اختياري)</Label>
              <Textarea rows={2} value={tNote} onChange={(e) => setTNote(e.target.value)} />
            </div>
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setTransferOpen(false)}>إلغاء</Button>
            <Button onClick={saveTransfer} disabled={busy || !tItemId || !tToBranch || !tQty}>
              {busy ? "جاري التحويل…" : "تأكيد التحويل"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
    </FeatureGate>
  );
}
