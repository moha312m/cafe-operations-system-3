"use client";

import { useMemo, useState } from "react";
import { money } from "@/lib/client";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { CustomerCategoryTabs } from "./customer-category-tabs";
import { CustomerProductCard } from "./customer-product-card";
import { CustomerCart } from "./customer-cart";
import { MenuAIChat } from "./menu-ai-chat";
import {
  CustomerOrderForm,
  type CustomerOrderDetails,
} from "./customer-order-form";
import {
  customerLineKey,
  customerUnitPrice,
  type CustomerCartLine,
  type MenuAddOn,
  type MenuData,
  type MenuProduct,
  type MenuVariant,
} from "./types";

type PlacedOrder = { orderNumber: number; total: string };

// The whole customer-facing menu experience. Receives the menu data
// from the server component (fresh on every request, so manager edits
// show up immediately) plus the table number from the QR link.
export function CustomerMenuPage({
  menu,
  initialTable,
}: {
  menu: MenuData;
  initialTable: string | null;
}) {
  const currency = menu.cafe.currency;
  const taxRate = menu.cafe.taxRate;

  const [activeCategory, setActiveCategory] = useState("all");
  const [cart, setCart] = useState<CustomerCartLine[]>([]);
  const [cartOpen, setCartOpen] = useState(false);
  const [details, setDetails] = useState<CustomerOrderDetails>({
    customerName: "",
    customerPhone: "",
    tableNumber: initialTable ?? "",
    notes: "",
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [placed, setPlaced] = useState<PlacedOrder | null>(null);

  // Variant / add-on / note picker
  const [configuring, setConfiguring] = useState<MenuProduct | null>(null);
  const [selVariant, setSelVariant] = useState("");
  const [selAddOns, setSelAddOns] = useState<Set<string>>(new Set());
  const [itemNote, setItemNote] = useState("");

  const visible = useMemo(
    () =>
      activeCategory === "all"
        ? menu.products
        : menu.products.filter((p) => p.category.id === activeCategory),
    [menu.products, activeCategory]
  );

  const subtotal = cart.reduce((s, l) => s + l.unitPrice * l.quantity, 0);
  const total = Math.round(subtotal * (1 + taxRate / 100) * 100) / 100;
  const itemCount = cart.reduce((s, l) => s + l.quantity, 0);

  function addToCart(
    product: MenuProduct,
    variant: MenuVariant | null,
    addOns: MenuAddOn[],
    note: string
  ) {
    const key = customerLineKey(
      product.id,
      variant?.id ?? null,
      addOns.map((a) => a.id),
      note
    );
    setCart((prev) => {
      const existing = prev.find((l) => l.key === key);
      if (existing) {
        return prev.map((l) =>
          l.key === key ? { ...l, quantity: l.quantity + 1 } : l
        );
      }
      return [
        ...prev,
        {
          key,
          product,
          variant,
          addOns,
          note,
          quantity: 1,
          unitPrice: customerUnitPrice(product, variant, addOns),
        },
      ];
    });
  }

  function selectProduct(product: MenuProduct) {
    if (product.variants.length === 0 && product.addOns.length === 0) {
      addToCart(product, null, [], "");
      return;
    }
    setConfiguring(product);
    setSelVariant(product.variants[0]?.id ?? "");
    setSelAddOns(new Set());
    setItemNote("");
  }

  function changeQuantity(key: string, delta: number) {
    setCart((prev) =>
      prev
        .map((l) => (l.key === key ? { ...l, quantity: l.quantity + delta } : l))
        .filter((l) => l.quantity > 0)
    );
  }

  function changeNote(key: string, note: string) {
    setCart((prev) =>
      prev.map((l) => (l.key === key ? { ...l, note } : l))
    );
  }

  async function submitOrder() {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/qr/${menu.branch.id}/orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          customerName: details.customerName.trim(),
          customerPhone: details.customerPhone.trim() || undefined,
          tableNumber: details.tableNumber.trim() || undefined,
          notes: details.notes.trim() || undefined,
          items: cart.map((l) => ({
            productId: l.product.id,
            variantId: l.variant?.id ?? null,
            quantity: l.quantity,
            addOnIds: l.addOns.map((a) => a.id),
            notes: l.note || undefined,
          })),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "فشل إرسال الطلب");
      setPlaced(data.order);
      setCartOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "فشل إرسال الطلب");
    } finally {
      setSubmitting(false);
    }
  }

  // ── Success screen ────────────────────────────────────────────
  if (placed) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-muted/40 p-6">
        <div className="w-full max-w-sm space-y-3 rounded-2xl border bg-card p-8 text-center shadow-sm">
          <p className="text-5xl">✅</p>
          <h1 className="text-xl font-bold">
            تم إرسال طلبك، في انتظار تأكيد الويتر
          </h1>
          <p className="text-3xl font-bold tabular-nums">#{placed.orderNumber}</p>
          <p className="text-sm text-muted-foreground">
            الإجمالي {money(placed.total, currency)} — الدفع عند التسليم.
          </p>
          <Button
            variant="outline"
            className="w-full"
            onClick={() => {
              setPlaced(null);
              setCart([]);
              setDetails((d) => ({ ...d, notes: "" }));
            }}
          >
            اطلب حاجة تانية
          </Button>
        </div>
      </main>
    );
  }

  return (
    <main className="mx-auto min-h-screen max-w-lg space-y-3 px-4 pb-28">
      {/* Header */}
      <header className="space-y-1 pt-4 text-center">
        <p className="text-4xl">☕</p>
        <h1 className="text-2xl font-bold">{menu.cafe.name}</h1>
        <p className="text-sm text-muted-foreground">
          {menu.branch.name}
          {details.tableNumber && ` · ترابيزة ${details.tableNumber}`}
        </p>
        <h2 className="pt-1 text-sm font-semibold text-muted-foreground">المنيو</h2>
      </header>

      <CustomerCategoryTabs
        categories={menu.categories}
        active={activeCategory}
        onChange={setActiveCategory}
      />

      <div className="space-y-2">
        {visible.map((p) => (
          <CustomerProductCard
            key={p.id}
            product={p}
            currency={currency}
            onAdd={selectProduct}
          />
        ))}
        {visible.length === 0 && (
          <p className="py-8 text-center text-sm text-muted-foreground">
            مفيش منتجات في التصنيف ده.
          </p>
        )}
      </div>

      {/* ── Floating cart bar ──────────────────────────────────── */}
      {cart.length > 0 && (
        <div className="fixed inset-x-0 bottom-0 z-20 p-3">
          <Button
            size="lg"
            className="mx-auto flex h-13 w-full max-w-lg items-center justify-between px-5 text-base font-semibold shadow-lg"
            onClick={() => setCartOpen(true)}
          >
            <span>🛒 سلة الطلب · {itemCount} صنف</span>
            <span className="tabular-nums">{money(total, currency)}</span>
          </Button>
        </div>
      )}

      {/* ── AI menu assistant (only if enabled for this cafe) ──── */}
      {menu.features.aiAssistant && (
        <MenuAIChat menu={menu} onPick={selectProduct} raised={cart.length > 0} />
      )}

      {/* ── Cart & checkout dialog ─────────────────────────────── */}
      <Dialog open={cartOpen} onOpenChange={setCartOpen}>
        <DialogContent className="max-h-[90vh] max-w-lg overflow-y-auto">
          <DialogHeader>
            <DialogTitle>سلة الطلب</DialogTitle>
          </DialogHeader>
          <CustomerCart
            cart={cart}
            currency={currency}
            onQuantityChange={changeQuantity}
            onRemove={(key) => setCart((prev) => prev.filter((l) => l.key !== key))}
            onNoteChange={changeNote}
          />
          {cart.length > 0 && (
            <CustomerOrderForm
              details={details}
              tableLocked={initialTable !== null}
              currency={currency}
              subtotal={subtotal}
              taxRate={taxRate}
              total={total}
              submitting={submitting}
              error={error}
              onChange={setDetails}
              onSubmit={submitOrder}
            />
          )}
        </DialogContent>
      </Dialog>

      {/* ── Variant / add-ons / note dialog ────────────────────── */}
      <Dialog open={configuring !== null} onOpenChange={(o) => !o && setConfiguring(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{configuring?.name}</DialogTitle>
          </DialogHeader>
          {configuring && (
            <div className="space-y-4">
              {configuring.description && (
                <p className="text-sm text-muted-foreground">
                  {configuring.description}
                </p>
              )}
              {configuring.variants.length > 0 && (
                <div className="space-y-2">
                  <Label>الحجم</Label>
                  <div className="flex flex-wrap gap-2">
                    {configuring.variants.map((v) => (
                      <Button
                        key={v.id}
                        size="sm"
                        variant={selVariant === v.id ? "default" : "outline"}
                        onClick={() => setSelVariant(v.id)}
                      >
                        {v.name} — {money(v.price, currency)}
                      </Button>
                    ))}
                  </div>
                </div>
              )}
              {configuring.addOns.length > 0 && (
                <div className="space-y-2">
                  <Label>الإضافات</Label>
                  <div className="flex flex-wrap gap-2">
                    {configuring.addOns.map(({ addOn }) => (
                      <Button
                        key={addOn.id}
                        size="sm"
                        variant={selAddOns.has(addOn.id) ? "default" : "outline"}
                        onClick={() =>
                          setSelAddOns((prev) => {
                            const next = new Set(prev);
                            if (next.has(addOn.id)) next.delete(addOn.id);
                            else next.add(addOn.id);
                            return next;
                          })
                        }
                      >
                        {addOn.name} (+{money(addOn.price, currency)})
                      </Button>
                    ))}
                  </div>
                </div>
              )}
              <div className="space-y-2">
                <Label>ملاحظة على الصنف (اختياري)</Label>
                <Input
                  placeholder="مثلاً: من غير سكر"
                  value={itemNote}
                  onChange={(e) => setItemNote(e.target.value)}
                />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button
              className="w-full"
              onClick={() => {
                if (!configuring) return;
                const variant =
                  configuring.variants.find((v) => v.id === selVariant) ?? null;
                const addOns = configuring.addOns
                  .map((a) => a.addOn)
                  .filter((a) => selAddOns.has(a.id));
                addToCart(configuring, variant, addOns, itemNote.trim());
                setConfiguring(null);
              }}
            >
              أضف للطلب
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </main>
  );
}
