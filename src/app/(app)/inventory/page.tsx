"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { api, money } from "@/lib/client";
import { useApp } from "@/components/app-shell";
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
  branchId: string;
  branch: { id: string; name: string };
  status: "ok" | "low" | "out";
  stockValue: number;
};
type Summary = { totalItems: number; lowCount: number; outCount: number; totalValue: number };
type Branch = { id: string; name: string };

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
});

// ─────────────────────────── Page ───────────────────────────

export default function InventoryPage() {
  const { cafe, user } = useApp();
  const currency = cafe?.currency ?? "EGP";

  const [items, setItems] = useState<InvItem[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [busy, setBusy] = useState(false);

  // Filters
  const [search, setSearch] = useState("");
  const [branchFilter, setBranchFilter] = useState("all");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");

  // Dialogs
  const [itemForm, setItemForm] = useState<ItemForm | null>(null);
  const [moveFor, setMoveFor] = useState<InvItem | null>(null);
  const [moveType, setMoveType] = useState<(typeof MOVEMENT_TYPES)[number]>("PURCHASE");
  const [moveQty, setMoveQty] = useState("");
  const [moveCost, setMoveCost] = useState("");
  const [moveNote, setMoveNote] = useState("");
  const [transferOpen, setTransferOpen] = useState(false);
  const [tItemId, setTItemId] = useState("");
  const [tToBranch, setTToBranch] = useState("");
  const [tQty, setTQty] = useState("");
  const [tNote, setTNote] = useState("");

  const load = useCallback(async () => {
    try {
      const branchQuery =
        !user.branchId && branchFilter !== "all" ? `?branchId=${branchFilter}` : "";
      const data = await api<{ items: InvItem[]; summary: Summary }>(
        `/api/inventory${branchQuery}`
      );
      setItems(data.items);
      setSummary(data.summary);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "فشل تحميل المخزون");
    }
  }, [branchFilter, user.branchId]);

  useEffect(() => {
    load();
  }, [load]);

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
        (term === "" || i.name.toLowerCase().includes(term))
    );
  }, [items, search, categoryFilter, statusFilter]);

  // ── Save item (add/edit) ──
  async function saveItem() {
    if (!itemForm) return;
    const body = {
      name: itemForm.name,
      category: itemForm.category || undefined,
      branchId: itemForm.branchId,
      unit: itemForm.unit,
      minimumStock: Number(itemForm.minimumStock) || 0,
      costPerUnit: Number(itemForm.costPerUnit) || 0,
      supplierName: itemForm.supplierName || undefined,
      expiryDate: itemForm.expiryDate || undefined,
      ...(itemForm.id ? {} : { currentStock: Number(itemForm.currentStock) || 0 }),
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

  async function saveMovement() {
    if (!moveFor) return;
    const ok = await run(
      () =>
        api(`/api/inventory/${moveFor.id}/movement`, {
          method: "POST",
          body: {
            type: moveType,
            quantity: Number(moveQty),
            unitCost: moveCost ? Number(moveCost) : undefined,
            note: moveNote || undefined,
          },
        }),
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
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">المخزون</h1>
        <div className="flex gap-2">
          {canPickBranch && branches.length > 1 && (
            <Button variant="outline" onClick={() => { setTItemId(""); setTToBranch(""); setTransferOpen(true); }}>
              🔁 تحويل بين الفروع
            </Button>
          )}
          <Button
            onClick={() =>
              setItemForm(emptyForm(user.branchId ?? branches[0]?.id ?? ""))
            }
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
              <TableCell className="tabular-nums">{Number(i.minimumStock)}</TableCell>
              <TableCell className="tabular-nums">{money(i.costPerUnit, currency)}</TableCell>
              <TableCell className="tabular-nums">{money(i.stockValue, currency)}</TableCell>
              <TableCell>
                <span className={cn("rounded-full px-2 py-0.5 text-xs font-medium", STATUS_STYLE[i.status])}>
                  {STOCK_STATUS_LABEL[i.status]}
                </span>
              </TableCell>
              <TableCell className="text-end [&>button]:ms-1">
                <Button
                  size="sm"
                  onClick={() => {
                    setMoveType("PURCHASE");
                    setMoveCost(String(i.costPerUnit));
                    setMoveFor(i);
                  }}
                >
                  حركة مخزون
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
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
                    })
                  }
                >
                  تعديل
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-destructive"
                  disabled={busy}
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
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label>اسم الخامة</Label>
                  <Input value={itemForm.name} onChange={(e) => setItemForm({ ...itemForm, name: e.target.value })} />
                </div>
                <div className="space-y-1.5">
                  <Label>التصنيف</Label>
                  <Input value={itemForm.category} onChange={(e) => setItemForm({ ...itemForm, category: e.target.value })} />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
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
              <div className="grid grid-cols-3 gap-3">
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
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label>المورد (اختياري)</Label>
                  <Input value={itemForm.supplierName} onChange={(e) => setItemForm({ ...itemForm, supplierName: e.target.value })} />
                </div>
                <div className="space-y-1.5">
                  <Label>تاريخ الصلاحية (اختياري)</Label>
                  <Input type="date" dir="ltr" value={itemForm.expiryDate} onChange={(e) => setItemForm({ ...itemForm, expiryDate: e.target.value })} />
                </div>
              </div>
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
                  {MOVEMENT_TYPES.map((t) => (
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
            <Button onClick={saveMovement} disabled={busy || !moveQty}>
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
  );
}
