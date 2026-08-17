"use client";

import { useMemo, useState } from "react";
import { money } from "@/lib/client";
import { computeCharges } from "@/lib/charges";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
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

type PlacedOrder = {
  orderNumber: number;
  total: string;
  status?: string;
  expectedPoints?: number;
  loyaltyEnabled?: boolean;
};

// Client-side mirror of the server's Egyptian phone check (server stays
// authoritative). Accepts 010/011/012/015 numbers with +2/002 prefixes.
function isValidEgyptianPhone(raw: string): boolean {
  let d = raw.replace(/[\s\-()]/g, "");
  if (d.startsWith("+")) d = d.slice(1);
  if (!/^\d+$/.test(d)) return false;
  if (d.startsWith("0020")) d = d.slice(4);
  else if (d.startsWith("002")) d = d.slice(3);
  else if (d.startsWith("20") && d.length > 10) d = d.slice(2);
  if (d.length === 10 && d.startsWith("1")) d = "0" + d;
  return /^01[0125]\d{8}$/.test(d);
}

// Bottom-sheet styling shared by the cart and the product-config dialogs.
// Overrides the centered dialog into a mobile sheet pinned to the bottom.
const SHEET =
  "inset-x-0 bottom-0 top-auto mx-auto w-full max-w-full translate-x-0 translate-y-0 rounded-b-none rounded-t-2xl sm:max-w-lg " +
  "flex max-h-[92dvh] flex-col gap-0 overflow-hidden p-0 " +
  "data-open:slide-in-from-bottom-8 data-closed:slide-out-to-bottom-8";

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
  const itemCount = cart.reduce((s, l) => s + l.quantity, 0);
  // Same pure engine + settings the server uses when creating the order, so
  // the customer sees the exact total (service + tax included) up front.
  const charges = useMemo(
    () =>
      computeCharges({
        subtotal,
        discount: 0,
        orderType: menu.orderType,
        settings: menu.charges,
      }),
    [subtotal, menu.orderType, menu.charges]
  );
  const total = charges.total;
  // Points this cart would earn — same floor(total/step)*pts rule as the server.
  const expectedPoints =
    menu.loyalty.enabled && menu.loyalty.earnAmountStep > 0
      ? Math.floor(total / menu.loyalty.earnAmountStep) * menu.loyalty.earnPointsPerAmount
      : 0;

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
    if (submitting) return; // hard double-submit guard
    if (cart.length === 0) {
      setError("من فضلك أضف صنف واحد على الأقل");
      return;
    }
    if (details.customerName.trim().length < 2) {
      setError("من فضلك اكتب اسمك");
      return;
    }
    const phone = details.customerPhone.trim();
    if (menu.loyalty.phoneRequired && !phone) {
      setError("من فضلك اكتب رقم الموبايل");
      return;
    }
    if (phone && !isValidEgyptianPhone(phone)) {
      setError("رقم الموبايل غير صحيح");
      return;
    }
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
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.order) {
        throw new Error(data?.error || "");
      }
      setPlaced(data.order);
      setCartOpen(false);
    } catch (e) {
      if (process.env.NODE_ENV === "development") console.error("qr submit failed", e);
      // Server messages are Arabic and actionable; anything else (network
      // failure, empty body) gets the friendly fallback.
      const msg = e instanceof Error && e.message ? e.message : "";
      setError(msg || "تعذر إرسال الطلب، من فضلك حاول مرة أخرى أو اطلب من الويتر");
    } finally {
      setSubmitting(false);
    }
  }

  // ── Success screen ────────────────────────────────────────────
  if (placed) {
    const pending = placed.status === "PENDING_WAITER_APPROVAL";
    return (
      <main className="flex min-h-dvh items-center justify-center bg-muted/40 p-6">
        <div className="w-full max-w-sm space-y-3 rounded-2xl border bg-card p-8 text-center shadow-sm">
          <p className="text-5xl">✅</p>
          <h1 className="text-xl font-bold">تم إرسال طلبك بنجاح</h1>
          <p className="text-sm font-medium text-amber-700 dark:text-amber-400">
            {pending ? "طلبك في انتظار التأكيد" : "طلبك وصل للكافيه وجاري تجهيزه"}
          </p>
          <p className="text-3xl font-bold tabular-nums">#{placed.orderNumber}</p>
          {details.tableNumber.trim() && (
            <p className="text-sm font-medium">ترابيزة رقم {details.tableNumber.trim()}</p>
          )}
          <p className="text-sm text-muted-foreground">
            الإجمالي {money(placed.total, currency)} — الدفع عند التسليم.
          </p>
          {placed.loyaltyEnabled && (placed.expectedPoints ?? 0) > 0 && (
            <div className="rounded-xl bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-400">
              <p className="font-semibold">⭐ هتكسب {placed.expectedPoints} نقطة بعد إتمام الطلب</p>
              <p className="text-xs">سيتم إضافة نقاطك بعد تأكيد الطلب والدفع.</p>
            </div>
          )}
          <Button
            variant="outline"
            className="h-12 w-full"
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

  const showTableBanner = menu.orderType === "DINE_IN" && !initialTable;

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-lg flex-col overflow-x-clip pb-36">
      {/* ── Sticky header: cafe / branch / table + cart button ─── */}
      <header className="sticky top-0 z-20 flex items-center gap-3 border-b bg-background/95 px-4 py-2.5 backdrop-blur">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xl">
          ☕
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-base font-bold leading-tight">
            {menu.cafe.name}
          </h1>
          <p className="truncate text-xs text-muted-foreground">
            المنيو · {menu.branch.name}
            {details.tableNumber && (
              <span className="font-medium text-foreground">
                {" "}· ترابيزة رقم {details.tableNumber}
              </span>
            )}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setCartOpen(true)}
          aria-label="السلة"
          className="relative flex size-11 shrink-0 items-center justify-center rounded-full border bg-card text-xl shadow-sm transition-colors active:bg-accent"
        >
          🛒
          {itemCount > 0 && (
            <span className="absolute -top-1 -end-1 flex size-5 items-center justify-center rounded-full bg-primary text-[11px] font-bold tabular-nums text-primary-foreground">
              {itemCount}
            </span>
          )}
        </button>
      </header>

      <CustomerCategoryTabs
        categories={menu.categories}
        active={activeCategory}
        onChange={setActiveCategory}
      />

      {showTableBanner && (
        <p className="mx-4 mt-2 rounded-lg bg-amber-500/10 px-3 py-2 text-xs leading-relaxed text-amber-700 dark:text-amber-400">
          رقم الترابيزة غير موجود في الرابط — تقدر تكتبه عند إتمام الطلب.
        </p>
      )}

      {/* ── Products ───────────────────────────────────────────── */}
      <div className="grid grid-cols-1 gap-2 px-4 pt-3 sm:grid-cols-2">
        {visible.map((p) => (
          <CustomerProductCard
            key={p.id}
            product={p}
            currency={currency}
            onAdd={selectProduct}
          />
        ))}
        {visible.length === 0 && (
          <p className="col-span-full py-10 text-center text-sm text-muted-foreground">
            {menu.products.length === 0
              ? "لا توجد منتجات متاحة حاليًا"
              : "لا توجد منتجات في هذا القسم"}
          </p>
        )}
      </div>

      {/* ── Sticky bottom cart bar ─────────────────────────────── */}
      {cart.length > 0 && (
        <div className="fixed inset-x-0 bottom-0 z-20 mx-auto w-full max-w-lg px-3 pb-[calc(0.75rem_+_env(safe-area-inset-bottom))] pt-2">
          <Button
            size="lg"
            className="flex h-14 w-full items-center justify-between rounded-2xl px-5 text-base font-semibold shadow-lg"
            onClick={() => setCartOpen(true)}
          >
            <span className="flex items-center gap-2">
              <span className="flex size-6 items-center justify-center rounded-full bg-primary-foreground/20 text-sm tabular-nums">
                {itemCount}
              </span>
              عرض السلة
            </span>
            <span className="tabular-nums">{money(total, currency)}</span>
          </Button>
        </div>
      )}

      {/* ── AI menu assistant (only if enabled for this cafe) ──── */}
      {menu.features.aiAssistant && (
        <MenuAIChat menu={menu} onPick={selectProduct} raised={cart.length > 0} />
      )}

      {/* ── Cart & checkout bottom sheet ───────────────────────── */}
      <Dialog open={cartOpen} onOpenChange={setCartOpen}>
        <DialogContent className={SHEET}>
          <DialogHeader className="shrink-0 border-b px-4 py-3">
            <DialogTitle>السلة</DialogTitle>
          </DialogHeader>

          {/* Scrollable middle: items + customer details */}
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain px-4 py-3">
            <CustomerCart
              cart={cart}
              currency={currency}
              onQuantityChange={changeQuantity}
              onRemove={(key) =>
                setCart((prev) => prev.filter((l) => l.key !== key))
              }
              onNoteChange={changeNote}
            />
            {cart.length > 0 && (
              <CustomerOrderForm
                details={details}
                tableLocked={initialTable !== null}
                phoneRequired={menu.loyalty.phoneRequired}
                onChange={setDetails}
              />
            )}
          </div>

          {/* Pinned footer: totals + submit always visible */}
          {cart.length > 0 && (
            <div className="shrink-0 space-y-2 border-t bg-card px-4 pt-3 pb-[calc(0.75rem_+_env(safe-area-inset-bottom))]">
              <div className="space-y-1 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">الإجمالي قبل الضريبة</span>
                  <span className="tabular-nums">{money(charges.subtotal, currency)}</span>
                </div>
                {charges.serviceChargeAmount > 0 && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">السيرفيس</span>
                    <span className="tabular-nums">
                      {money(charges.serviceChargeAmount, currency)}
                    </span>
                  </div>
                )}
                {charges.taxAmount > 0 && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">
                      الضريبة ({charges.taxRateSnapshot}٪)
                    </span>
                    <span className="tabular-nums">{money(charges.taxAmount, currency)}</span>
                  </div>
                )}
                <div className="flex justify-between text-base font-bold">
                  <span>الإجمالي</span>
                  <span className="tabular-nums">{money(total, currency)}</span>
                </div>
                {menu.loyalty.enabled && expectedPoints > 0 && (
                  <p className="pt-0.5 text-xs font-medium text-emerald-700 dark:text-emerald-400">
                    ⭐ هتكسب {expectedPoints} نقطة بعد تأكيد ودفع الطلب
                  </p>
                )}
              </div>

              {error && <p className="text-sm text-destructive">{error}</p>}

              <Button
                size="lg"
                className="h-12 w-full text-base font-semibold"
                disabled={submitting}
                onClick={submitOrder}
              >
                {submitting ? "جاري الإرسال…" : "إرسال الطلب"}
              </Button>
              <Button
                variant="ghost"
                className="h-10 w-full text-sm text-muted-foreground"
                onClick={() => setCartOpen(false)}
              >
                رجوع للمنيو
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* ── Variant / add-ons / note bottom sheet ──────────────── */}
      <Dialog
        open={configuring !== null}
        onOpenChange={(o) => !o && setConfiguring(null)}
      >
        <DialogContent className={SHEET}>
          <DialogHeader className="shrink-0 border-b px-4 py-3">
            <DialogTitle>{configuring?.name}</DialogTitle>
          </DialogHeader>
          {configuring && (
            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain px-4 py-3">
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
                        variant={selVariant === v.id ? "default" : "outline"}
                        className="h-11"
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
                        variant={selAddOns.has(addOn.id) ? "default" : "outline"}
                        className="h-11"
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
                  className="h-11"
                  value={itemNote}
                  onChange={(e) => setItemNote(e.target.value)}
                />
              </div>
            </div>
          )}
          <div className="shrink-0 border-t px-4 pt-3 pb-[calc(0.75rem_+_env(safe-area-inset-bottom))]">
            <Button
              className="h-12 w-full text-base font-semibold"
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
              إضافة
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </main>
  );
}
