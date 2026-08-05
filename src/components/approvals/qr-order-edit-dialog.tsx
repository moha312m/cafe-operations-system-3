"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { api, money } from "@/lib/client";
import { useApp } from "@/components/app-shell";
import { computeCharges, type ChargeSettings } from "@/lib/charges";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";

type AddOn = { id: string; name: string; price: number };
type Variant = { id: string; name: string; price: number; isActive: boolean };
type Product = {
  id: string; name: string; basePrice: number; isActive: boolean; isAvailable: boolean;
  category: { id: string; name: string } | null;
  variants: Variant[];
  addOns: { addOn: AddOn }[];
  branchPrices: { branchId: string; price: number }[];
};

type OrderDetail = {
  id: string; orderNumber: number; type: "DINE_IN" | "TAKEAWAY" | "DELIVERY";
  tableNumber: string | null; customerName: string | null; notes: string | null;
  discountAmount: number; createdAt: string;
  branch: { id: string; name: string };
  items: { id: string; productName: string; variantName: string | null; unitPrice: number; quantity: number; notes: string | null; addOns: { addOnName: string; price: number }[] }[];
};

// A locally-edited existing line.
type ExistingEdit = { quantity: number; notes: string };
// A newly-added line (priced on save).
type NewLine = { tempId: string; productId: string; variantId: string | null; name: string; variantName: string | null; unitPrice: number; addOnIds: string[]; addOnsLabel: string; addOnsTotal: number; quantity: number; notes: string };

function branchUnitPrice(p: Product, variant: Variant | null, branchId: string): number {
  const bp = p.branchPrices.find((x) => x.branchId === branchId)?.price;
  const base = bp ?? p.basePrice;
  const shift = bp != null ? bp - p.basePrice : 0;
  return Math.round((variant ? variant.price + shift : base) * 100) / 100;
}

export function QrOrderEditDialog({
  orderId, canApprove, onClose, onSaved,
}: {
  orderId: string; canApprove: boolean; onClose: () => void; onSaved: () => void;
}) {
  const { cafe } = useApp();
  const currency = cafe?.currency ?? "EGP";
  const fmt = (v: number) => money(v, currency);

  const [order, setOrder] = useState<OrderDetail | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [finSettings, setFinSettings] = useState<ChargeSettings | null>(null);
  const [busy, setBusy] = useState(false);

  // edits
  const [existing, setExisting] = useState<Record<string, ExistingEdit>>({});
  const [added, setAdded] = useState<NewLine[]>([]);
  const [tableNumber, setTableNumber] = useState("");
  const [notes, setNotes] = useState("");

  // add-item picker
  const [q, setQ] = useState("");
  const [cat, setCat] = useState<string>("ALL");
  const [config, setConfig] = useState<{ product: Product; variantId: string | null; addOnIds: string[]; qty: number; note: string } | null>(null);

  const load = useCallback(async () => {
    try {
      // Prisma Decimals arrive as strings/objects — coerce to numbers.
      const num = (v: unknown) => Number(v);
      const [rawOrder, prodRes] = await Promise.all([
        api<{ order: Record<string, unknown> & { items: Record<string, unknown>[]; branch: { id: string; name: string } } }>(`/api/orders/${orderId}`),
        api<{ products: Record<string, unknown>[] }>("/api/products"),
      ]);
      const o = rawOrder.order;
      const order: OrderDetail = {
        id: o.id as string, orderNumber: o.orderNumber as number, type: o.type as OrderDetail["type"],
        tableNumber: (o.tableNumber as string) ?? null, customerName: (o.customerName as string) ?? null,
        notes: (o.notes as string) ?? null, discountAmount: num(o.discountAmount), createdAt: o.createdAt as string,
        branch: o.branch,
        items: o.items.map((i) => ({
          id: i.id as string, productName: i.productName as string, variantName: (i.variantName as string) ?? null,
          unitPrice: num(i.unitPrice), quantity: i.quantity as number, notes: (i.notes as string) ?? null,
          addOns: ((i.addOns as Record<string, unknown>[]) ?? []).map((a) => ({ addOnName: a.addOnName as string, price: num(a.price) })),
        })),
      };
      const products: Product[] = prodRes.products
        .filter((p) => p.isActive)
        .map((p) => ({
          id: p.id as string, name: p.name as string, basePrice: num(p.basePrice),
          isActive: p.isActive as boolean, isAvailable: p.isAvailable as boolean,
          category: (p.category as Product["category"]) ?? null,
          variants: ((p.variants as Record<string, unknown>[]) ?? []).map((v) => ({ id: v.id as string, name: v.name as string, price: num(v.price), isActive: v.isActive as boolean })),
          addOns: ((p.addOns as { addOn: Record<string, unknown> }[]) ?? []).map((pa) => ({ addOn: { id: pa.addOn.id as string, name: pa.addOn.name as string, price: num(pa.addOn.price) } })),
          branchPrices: ((p.branchPrices as Record<string, unknown>[]) ?? []).map((bp) => ({ branchId: bp.branchId as string, price: num(bp.price) })),
        }));
      setOrder(order);
      setProducts(products);
      setExisting(Object.fromEntries(order.items.map((i) => [i.id, { quantity: i.quantity, notes: i.notes ?? "" }])));
      setTableNumber(order.tableNumber ?? "");
      setNotes(order.notes ?? "");
      const fin = await api<{ settings: ChargeSettings }>(`/api/branches/${order.branch.id}/financial-settings`);
      setFinSettings(fin.settings);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "فشل تحميل الطلب");
    }
  }, [orderId]);

  useEffect(() => { load(); }, [load]);

  const categories = useMemo(() => {
    const seen = new Map<string, string>();
    for (const p of products) if (p.category) seen.set(p.category.id, p.category.name);
    return [...seen.entries()];
  }, [products]);

  const filteredProducts = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return products.filter((p) => {
      if (cat !== "ALL" && p.category?.id !== cat) return false;
      if (needle && !p.name.toLowerCase().includes(needle)) return false;
      return true;
    });
  }, [products, q, cat]);

  // ── Totals (client preview; server is authoritative) ──
  const subtotal = useMemo(() => {
    if (!order) return 0;
    let s = 0;
    for (const it of order.items) {
      const st = existing[it.id];
      const qty = st?.quantity ?? it.quantity;
      if (qty <= 0) continue;
      const perUnit = it.unitPrice + it.addOns.reduce((a, x) => a + x.price, 0);
      s += perUnit * qty;
    }
    for (const n of added) s += (n.unitPrice + n.addOnsTotal) * n.quantity;
    return Math.round(s * 100) / 100;
  }, [order, existing, added]);

  const charges = useMemo(() => {
    if (!order || !finSettings) return null;
    return computeCharges({ subtotal, discount: order.discountAmount, orderType: order.type, settings: finSettings });
  }, [order, finSettings, subtotal]);

  const remainingCount = useMemo(() => {
    if (!order) return 0;
    const kept = order.items.filter((i) => (existing[i.id]?.quantity ?? i.quantity) > 0).length;
    return kept + added.length;
  }, [order, existing, added]);

  function addConfigured() {
    if (!config || !order) return;
    const p = config.product;
    const hasVariants = p.variants.some((v) => v.isActive);
    if (hasVariants && !config.variantId) return toast.error("اختار الحجم");
    const variant = p.variants.find((v) => v.id === config.variantId) ?? null;
    const unit = branchUnitPrice(p, variant, order.branch.id);
    const chosenAddOns = p.addOns.map((pa) => pa.addOn).filter((a) => config.addOnIds.includes(a.id));
    const addOnsTotal = chosenAddOns.reduce((s, a) => s + a.price, 0);
    setAdded((prev) => [...prev, {
      tempId: `${p.id}-${prev.length}-${config.variantId ?? ""}`,
      productId: p.id, variantId: config.variantId, name: p.name,
      variantName: variant?.name ?? null, unitPrice: unit,
      addOnIds: config.addOnIds, addOnsLabel: chosenAddOns.map((a) => a.name).join("، "), addOnsTotal,
      quantity: config.qty, notes: config.note.trim(),
    }]);
    setConfig(null);
  }

  async function save(confirmAfter: boolean) {
    if (!order) return;
    if (remainingCount === 0) return toast.error("لازم يفضل صنف واحد على الأقل");
    setBusy(true);
    try {
      const items = order.items.map((i) => ({ id: i.id, quantity: existing[i.id]?.quantity ?? i.quantity, notes: existing[i.id]?.notes ?? i.notes ?? null }));
      const newItems = added.map((n) => ({ productId: n.productId, variantId: n.variantId, addOnIds: n.addOnIds, quantity: n.quantity, notes: n.notes || undefined }));
      await api(`/api/orders/${order.id}`, {
        method: "PATCH",
        body: { items, newItems, tableNumber: tableNumber.trim() || null, notes: notes.trim() || null },
      });
      if (confirmAfter) {
        await api(`/api/orders/${order.id}/approve`, { method: "POST" });
        toast.success("تم حفظ التعديلات وتأكيد الطلب");
      } else {
        toast.success("تم حفظ التعديلات");
      }
      onSaved();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "فشل الحفظ");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="max-h-[92vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>تعديل الطلب{order ? ` #${order.orderNumber}` : ""} قبل التأكيد</DialogTitle>
        </DialogHeader>

        {!order ? (
          <p className="text-sm text-muted-foreground">جاري التحميل…</p>
        ) : (
          <div className="space-y-4">
            {/* Order info */}
            <div className="flex flex-wrap gap-x-5 gap-y-1 rounded-lg bg-muted/40 p-2.5 text-xs text-muted-foreground">
              <span>المصدر: منيو QR</span>
              {order.customerName && <span>العميل: {order.customerName}</span>}
              <span>الوقت: {new Date(order.createdAt).toLocaleTimeString("ar-EG", { hour: "2-digit", minute: "2-digit" })}</span>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              {/* Current items */}
              <div className="space-y-2">
                <p className="text-sm font-semibold">الأصناف الحالية</p>
                {order.items.map((it) => {
                  const st = existing[it.id] ?? { quantity: it.quantity, notes: it.notes ?? "" };
                  const removed = st.quantity <= 0;
                  return (
                    <div key={it.id} className={cn("rounded-lg border p-2", removed && "opacity-40")}>
                      <div className="flex items-center justify-between gap-2">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium">{it.productName}{it.variantName && <span className="text-muted-foreground"> · {it.variantName}</span>}</p>
                          <p className="text-xs tabular-nums text-muted-foreground">{fmt(it.unitPrice)}{it.addOns.length > 0 && ` + ${it.addOns.map((a) => a.addOnName).join("، ")}`}</p>
                        </div>
                        <div className="flex items-center gap-1">
                          <Button variant="outline" size="sm" className="size-7 p-0" onClick={() => setExisting({ ...existing, [it.id]: { ...st, quantity: Math.max(0, st.quantity - 1) } })}>−</Button>
                          <span className="w-6 text-center text-sm tabular-nums">{st.quantity}</span>
                          <Button variant="outline" size="sm" className="size-7 p-0" onClick={() => setExisting({ ...existing, [it.id]: { ...st, quantity: st.quantity + 1 } })}>+</Button>
                          <Button variant="ghost" size="sm" className="size-7 p-0 text-destructive" title="حذف" onClick={() => setExisting({ ...existing, [it.id]: { ...st, quantity: 0 } })}>✕</Button>
                        </div>
                      </div>
                      {!removed && (
                        <Input className="mt-1.5 h-7 text-xs" placeholder="ملاحظات" value={st.notes}
                          onChange={(e) => setExisting({ ...existing, [it.id]: { ...st, notes: e.target.value } })} />
                      )}
                    </div>
                  );
                })}

                {added.map((n) => (
                  <div key={n.tempId} className="rounded-lg border border-emerald-500/40 bg-emerald-500/5 p-2">
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{n.name}{n.variantName && <span className="text-muted-foreground"> · {n.variantName}</span>} <span className="text-[10px] text-emerald-700 dark:text-emerald-400">جديد</span></p>
                        <p className="text-xs tabular-nums text-muted-foreground">{fmt(n.unitPrice)}{n.addOnsLabel && ` + ${n.addOnsLabel}`}</p>
                      </div>
                      <div className="flex items-center gap-1">
                        <Button variant="outline" size="sm" className="size-7 p-0" onClick={() => setAdded(added.map((x) => x.tempId === n.tempId ? { ...x, quantity: Math.max(1, x.quantity - 1) } : x))}>−</Button>
                        <span className="w-6 text-center text-sm tabular-nums">{n.quantity}</span>
                        <Button variant="outline" size="sm" className="size-7 p-0" onClick={() => setAdded(added.map((x) => x.tempId === n.tempId ? { ...x, quantity: x.quantity + 1 } : x))}>+</Button>
                        <Button variant="ghost" size="sm" className="size-7 p-0 text-destructive" onClick={() => setAdded(added.filter((x) => x.tempId !== n.tempId))}>✕</Button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              {/* Add item */}
              <div className="space-y-2">
                <p className="text-sm font-semibold">إضافة صنف</p>
                {config ? (
                  <div className="space-y-2 rounded-lg border p-2.5">
                    <p className="text-sm font-medium">{config.product.name}</p>
                    {config.product.variants.some((v) => v.isActive) && (
                      <div className="flex flex-wrap gap-1">
                        {config.product.variants.filter((v) => v.isActive).map((v) => (
                          <button key={v.id} onClick={() => setConfig({ ...config, variantId: v.id })}
                            className={cn("rounded-lg border px-2 py-1 text-xs", config.variantId === v.id ? "border-primary bg-primary text-primary-foreground" : "border-border")}>
                            {v.name} · {fmt(branchUnitPrice(config.product, v, order.branch.id))}
                          </button>
                        ))}
                      </div>
                    )}
                    {config.product.addOns.length > 0 && (
                      <div className="flex flex-wrap gap-1">
                        {config.product.addOns.map((pa) => pa.addOn).filter((a) => a).map((a) => {
                          const on = config.addOnIds.includes(a.id);
                          return (
                            <button key={a.id} onClick={() => setConfig({ ...config, addOnIds: on ? config.addOnIds.filter((x) => x !== a.id) : [...config.addOnIds, a.id] })}
                              className={cn("rounded-full border px-2 py-0.5 text-[11px]", on ? "border-emerald-500 bg-emerald-500/15 text-emerald-700 dark:text-emerald-400" : "border-border")}>
                              + {a.name} ({fmt(a.price)})
                            </button>
                          );
                        })}
                      </div>
                    )}
                    <div className="flex items-center gap-2">
                      <Label className="text-xs">الكمية</Label>
                      <Button variant="outline" size="sm" className="size-7 p-0" onClick={() => setConfig({ ...config, qty: Math.max(1, config.qty - 1) })}>−</Button>
                      <span className="w-6 text-center text-sm tabular-nums">{config.qty}</span>
                      <Button variant="outline" size="sm" className="size-7 p-0" onClick={() => setConfig({ ...config, qty: config.qty + 1 })}>+</Button>
                    </div>
                    <Input className="h-8 text-xs" placeholder="ملاحظات" value={config.note} onChange={(e) => setConfig({ ...config, note: e.target.value })} />
                    <div className="flex gap-2">
                      <Button size="sm" variant="outline" onClick={() => setConfig(null)}>إلغاء</Button>
                      <Button size="sm" onClick={addConfigured}>إضافة للطلب</Button>
                    </div>
                  </div>
                ) : (
                  <>
                    <Input placeholder="ابحث عن منتج…" className="h-8" value={q} onChange={(e) => setQ(e.target.value)} />
                    <div className="flex flex-wrap gap-1">
                      <button onClick={() => setCat("ALL")} className={cn("rounded-full border px-2 py-0.5 text-[11px]", cat === "ALL" ? "border-foreground bg-foreground text-background" : "border-border")}>الكل</button>
                      {categories.map(([id, name]) => (
                        <button key={id} onClick={() => setCat(id)} className={cn("rounded-full border px-2 py-0.5 text-[11px]", cat === id ? "border-foreground bg-foreground text-background" : "border-border")}>{name}</button>
                      ))}
                    </div>
                    <div className="max-h-52 space-y-1 overflow-y-auto pe-0.5">
                      {filteredProducts.map((p) => (
                        <button key={p.id} disabled={!p.isAvailable}
                          onClick={() => setConfig({ product: p, variantId: p.variants.find((v) => v.isActive)?.id ?? null, addOnIds: [], qty: 1, note: "" })}
                          className={cn("flex w-full items-center justify-between rounded-lg border px-2.5 py-1.5 text-start text-sm hover:bg-accent", !p.isAvailable && "opacity-40")}>
                          <span>{p.name}{!p.isAvailable && <span className="text-[10px] text-red-600"> (غير متاح)</span>}</span>
                          <span className="text-xs tabular-nums text-muted-foreground">{fmt(branchUnitPrice(p, p.variants.find((v) => v.isActive) ?? null, order.branch.id))}</span>
                        </button>
                      ))}
                      {filteredProducts.length === 0 && <p className="py-4 text-center text-xs text-muted-foreground">لا توجد منتجات</p>}
                    </div>
                  </>
                )}
              </div>
            </div>

            {/* Table + order notes */}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label className="text-xs">رقم الترابيزة</Label>
                <Input dir="ltr" value={tableNumber} onChange={(e) => setTableNumber(e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">ملاحظات الطلب</Label>
                <Input value={notes} onChange={(e) => setNotes(e.target.value)} />
              </div>
            </div>

            {/* Totals */}
            {charges && (
              <div className="ms-auto w-full max-w-xs space-y-1 text-sm">
                <Row label="الإجمالي قبل الخصم" value={fmt(charges.subtotal)} />
                {charges.discountAmount > 0 && <Row label="الخصم" value={`- ${fmt(charges.discountAmount)}`} />}
                {charges.serviceChargeAmount > 0 && <Row label="السيرفيس" value={fmt(charges.serviceChargeAmount)} />}
                {charges.taxAmount > 0 && <Row label="الضريبة" value={fmt(charges.taxAmount)} />}
                <Row label="الإجمالي النهائي" value={fmt(charges.total)} bold />
              </div>
            )}
          </div>
        )}

        <DialogFooter className="flex-wrap gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>إلغاء</Button>
          <Button variant="outline" onClick={() => save(false)} disabled={busy || !order}>حفظ التعديلات</Button>
          {canApprove && <Button onClick={() => save(true)} disabled={busy || !order}>حفظ وتأكيد الطلب</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Row({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <div className={cn("flex justify-between", bold && "border-t pt-1 font-semibold")}>
      <span className="text-muted-foreground">{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
  );
}
