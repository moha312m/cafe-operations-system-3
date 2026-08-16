"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { api, money } from "@/lib/client";
import { t } from "@/lib/i18n";
import { branchShift, round2 as r2 } from "@/lib/pricing";
import { computeCharges, type ChargeSettings } from "@/lib/charges";
import { useApp } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
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
import { CategoryTabs } from "@/components/pos/category-tabs";
import { ProductGrid } from "@/components/pos/product-grid";
import { OrderCart } from "@/components/pos/order-cart";
import { ShiftControls } from "@/components/pos/shift-controls";
import type { LoyaltyRedeem } from "@/components/pos/customer-loyalty";
import type { CustomerDetails } from "@/components/pos/order-type-selector";
import {
  computeUnitPrice,
  lineKey,
  type AddOn,
  type Branch,
  type CartLine,
  type Category,
  type CollectionMode,
  type OrderType,
  type PaymentMethod,
  type SplitMethod,
  type Product,
  type Variant,
} from "@/components/pos/types";

const EMPTY_MIXED = { CASH: "", CARD: "", WALLET: "" };

const round2 = (n: number) => Math.round(n * 100) / 100;

const EMPTY_DETAILS: CustomerDetails = {
  customerName: "",
  customerPhone: "",
  deliveryAddress: "",
  tableNumber: "",
};

type PlacedOrder = { id: string; orderNumber: number; total: string };

export default function PosPage() {
  const router = useRouter();
  const { cafe, user } = useApp();
  const currency = cafe?.currency ?? "USD";
  const taxRate = cafe?.taxRate ?? 0;

  // ── Menu data ────────────────────────────────────────────────
  const [categories, setCategories] = useState<Category[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [branchId, setBranchId] = useState<string>(user.branchId ?? "");
  const [activeCategory, setActiveCategory] = useState<string>("all");
  const [search, setSearch] = useState("");

  // ── Order state ──────────────────────────────────────────────
  const [cart, setCart] = useState<CartLine[]>([]);
  const [orderType, setOrderType] = useState<OrderType>("DINE_IN");
  const [details, setDetails] = useState<CustomerDetails>(EMPTY_DETAILS);
  const [discountInput, setDiscountInput] = useState("");
  const [method, setMethod] = useState<PaymentMethod>("CASH");
  const [mixed, setMixed] = useState<{ CASH: string; CARD: string; WALLET: string }>(
    EMPTY_MIXED
  );
  const [collectionMode, setCollectionMode] = useState<CollectionMode>("NOW");
  const [paidInput, setPaidInput] = useState("");
  const [finSettings, setFinSettings] = useState<ChargeSettings | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // Bumped after a dine-in order is placed so the table invoice cards refetch.
  const [tableReload, setTableReload] = useState(0);
  // Loyalty points the cashier is redeeming for this order.
  const [redeem, setRedeem] = useState<LoyaltyRedeem>({ points: 0, discount: 0 });

  // ── Shift gate (cashiers must have an open shift) ────────────
  const [shiftActive, setShiftActive] = useState(false);
  const canOperateShift =
    user.role === "CASHIER" ||
    user.role === "BRANCH_MANAGER" ||
    user.role === "CAFE_OWNER";
  const needsShift = user.role === "CASHIER";

  // ── Item configuration dialog (variant / add-ons / note) ────
  const [configuring, setConfiguring] = useState<Product | null>(null);
  const [selVariant, setSelVariant] = useState<string>("");
  const [selAddOns, setSelAddOns] = useState<Set<string>>(new Set());
  const [itemNote, setItemNote] = useState("");

  useEffect(() => {
    Promise.all([
      api<{ categories: Category[] }>("/api/categories"),
      api<{ products: Product[] }>("/api/products"),
      api<{ branches: Branch[] }>("/api/branches"),
    ])
      .then(([c, p, b]) => {
        setCategories(c.categories.filter((x) => x.isActive));
        setProducts(p.products);
        setBranches(b.branches);
        if (!user.branchId && b.branches.length > 0) setBranchId(b.branches[0].id);
      })
      .catch((e) => toast.error(e.message));
  }, [user.branchId]);

  // Branch tax/service settings drive the live totals (server recomputes
  // authoritatively on submit).
  useEffect(() => {
    if (!branchId) return;
    api<{ settings: ChargeSettings }>(`/api/branches/${branchId}/financial-settings`)
      .then((r) => setFinSettings(r.settings))
      .catch(() => setFinSettings(null));
  }, [branchId]);

  // POS shows only showInPOS products, priced for the selected branch:
  // a branch override shifts the base and every variant equally.
  const posProducts = useMemo(
    () =>
      products
        .filter((p) => p.showInPOS !== false)
        .map((p) => {
          const shift = branchShift(p, branchId);
          if (shift === 0) return p;
          return {
            ...p,
            basePrice: String(r2(Number(p.basePrice) + shift)),
            variants: p.variants.map((v) => ({
              ...v,
              price: String(r2(Number(v.price) + shift)),
            })),
          };
        }),
    [products, branchId]
  );

  const countsByCategory = useMemo(() => {
    const counts = new Map<string, number>();
    for (const p of posProducts) {
      counts.set(p.category.id, (counts.get(p.category.id) ?? 0) + 1);
    }
    return counts;
  }, [posProducts]);

  const visibleProducts = useMemo(() => {
    const term = search.trim().toLowerCase();
    return posProducts.filter(
      (p) =>
        (activeCategory === "all" || p.category.id === activeCategory) &&
        (term === "" || p.name.toLowerCase().includes(term))
    );
  }, [posProducts, activeCategory, search]);

  // ── Cart operations ──────────────────────────────────────────
  function addToCart(
    product: Product,
    variant: Variant | null,
    addOns: AddOn[],
    note: string
  ) {
    // Clear the search so the cashier can type the next product right away.
    setSearch("");
    const key = lineKey(product.id, variant?.id ?? null, addOns.map((a) => a.id), note);
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
          unitPrice: round2(computeUnitPrice(product, variant, addOns)),
        },
      ];
    });
  }

  function handleSelectProduct(product: Product) {
    const activeVariants = product.variants.filter((v) => v.isActive);
    const activeAddOns = product.addOns.filter((a) => a.addOn.isActive);
    if (activeVariants.length === 0 && activeAddOns.length === 0) {
      addToCart(product, null, [], "");
      return;
    }
    setConfiguring(product);
    setSelVariant(activeVariants[0]?.id ?? "");
    setSelAddOns(new Set());
    setItemNote("");
  }

  function confirmConfigure() {
    if (!configuring) return;
    const variant = configuring.variants.find((v) => v.id === selVariant) ?? null;
    const addOns = configuring.addOns
      .map((a) => a.addOn)
      .filter((a) => selAddOns.has(a.id));
    addToCart(configuring, variant, addOns, itemNote.trim());
    setConfiguring(null);
  }

  function changeQuantity(key: string, delta: number) {
    setCart((prev) =>
      prev
        .map((l) => (l.key === key ? { ...l, quantity: l.quantity + delta } : l))
        .filter((l) => l.quantity > 0)
    );
  }

  function removeLine(key: string) {
    setCart((prev) => prev.filter((l) => l.key !== key));
  }

  function changeNote(key: string, note: string) {
    // The note is part of the merge key, so recompute it (and merge if a
    // twin line with the same note already exists).
    setCart((prev) => {
      const line = prev.find((l) => l.key === key);
      if (!line) return prev;
      const newKey = lineKey(
        line.product.id,
        line.variant?.id ?? null,
        line.addOns.map((a) => a.id),
        note
      );
      const twin = prev.find((l) => l.key === newKey && l.key !== key);
      if (twin) {
        return prev
          .filter((l) => l.key !== key)
          .map((l) =>
            l.key === newKey ? { ...l, quantity: l.quantity + line.quantity } : l
          );
      }
      return prev.map((l) => (l.key === key ? { ...l, key: newKey, note } : l));
    });
  }

  // ── Totals & validation ──────────────────────────────────────
  const subtotal = round2(cart.reduce((s, l) => s + l.unitPrice * l.quantity, 0));
  // Fall back to the cafe tax rate until branch settings load.
  const effectiveSettings: ChargeSettings =
    finSettings ?? {
      taxEnabled: taxRate > 0,
      taxRate,
      applyTaxTo: "ALL_ORDERS",
      serviceChargeEnabled: false,
      serviceChargeType: "PERCENTAGE",
      serviceChargeRate: 0,
      serviceChargeFixedAmount: 0,
      applyServiceTo: "DINE_IN_ONLY",
    };
  // Pre-loyalty total drives the redemption cap (max % of order).
  const preLoyaltyCharges = computeCharges({
    subtotal,
    discount: Number(discountInput) || 0,
    orderType,
    settings: effectiveSettings,
  });
  const charges = computeCharges({
    subtotal,
    discount: (Number(discountInput) || 0) + redeem.discount,
    orderType,
    settings: effectiveSettings,
  });
  const discountAmount = charges.discountAmount;
  const serviceCharge = charges.serviceChargeAmount;
  const taxAmount = charges.taxAmount;
  const effectiveTaxRate = charges.taxRateSnapshot;
  const total = charges.total;

  const disabledReason = useMemo(() => {
    if (needsShift && !shiftActive) return t.shifts.mustOpen;
    if (cart.length === 0) return t.pos.validation.emptyCart;
    if (!branchId) return t.pos.validation.noBranch;
    if (orderType === "DINE_IN" && !details.tableNumber.trim())
      return t.pos.validation.needTable;
    if (orderType === "DELIVERY" && !details.customerName.trim())
      return t.pos.validation.needCustomer;
    return null;
  }, [needsShift, shiftActive, cart.length, branchId, orderType, details]);

  function changeMixed(field: SplitMethod, value: string) {
    setMixed((prev) => ({ ...prev, [field]: value }));
  }

  // ── Order submission ─────────────────────────────────────────
  async function placeOrder() {
    if (disabledReason) return;
    setSubmitting(true);
    try {
      // Payment collection is resolved server-side (order + payment created
      // atomically) based on the collection mode.
      const paymentBody =
        collectionMode === "NOW"
          ? method === "MIXED"
            ? {
                method: "MIXED" as const,
                splits: (["CASH", "CARD", "WALLET"] as SplitMethod[])
                  .map((m) => ({ method: m, amount: Number(mixed[m]) || 0 }))
                  .filter((s) => s.amount > 0),
              }
            : { method }
          : collectionMode === "PARTIAL"
            ? { method, paidAmount: round2(Number(paidInput) || 0) }
            : {};

      const { order } = await api<{ order: PlacedOrder }>("/api/orders", {
        method: "POST",
        body: {
          branchId: branchId || undefined,
          type: orderType,
          customerName: details.customerName.trim() || undefined,
          customerPhone: details.customerPhone.trim() || undefined,
          deliveryAddress: details.deliveryAddress.trim() || undefined,
          tableNumber: details.tableNumber.trim() || undefined,
          // Manual discount only — the server recomputes the loyalty
          // discount from the redeemed points.
          discountAmount: Number(discountInput) || 0,
          loyaltyPointsToRedeem: redeem.points || undefined,
          collectionMode,
          ...paymentBody,
          items: cart.map((l) => ({
            productId: l.product.id,
            variantId: l.variant?.id ?? null,
            quantity: l.quantity,
            addOnIds: l.addOns.map((a) => a.id),
            notes: l.note || undefined,
          })),
        },
      });

      const isDineIn = orderType === "DINE_IN";
      const collectedMsg =
        collectionMode === "NOW"
          ? ` · اتحصّل ${money(order.total, currency)}`
          : collectionMode === "PARTIAL"
            ? ` · ${t.collection.partial}`
            : ` · ${t.collection.pending}`;
      toast.success(
        isDineIn
          ? `تم إضافة الفاتورة على الترابيزة${collectedMsg}`
          : `طلب رقم ${order.orderNumber} اتسجل${collectedMsg}`,
        {
          action: { label: "عرض الطلب", onClick: () => router.push("/orders") },
          duration: 5000,
        }
      );

      // Reset the cart for the next order. For dine-in keep the table selected
      // so the newly-added invoice appears in "فواتير الترابيزة" cards.
      setCart([]);
      setDetails(isDineIn ? { ...EMPTY_DETAILS, tableNumber: details.tableNumber } : EMPTY_DETAILS);
      setDiscountInput("");
      setMixed(EMPTY_MIXED);
      setPaidInput("");
      setRedeem({ points: 0, discount: 0 });
      if (isDineIn) setTableReload((k) => k + 1);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "فشل تسجيل الطلب");
    } finally {
      setSubmitting(false);
    }
  }

  // ── Render ───────────────────────────────────────────────────
  return (
    <div className="flex flex-col gap-4">
      {canOperateShift && branchId && (
        <ShiftControls
          branchId={branchId}
          currency={currency}
          onActiveChange={setShiftActive}
        />
      )}
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
      {/* Main area: search, categories, product grid */}
      <div className="flex min-w-0 flex-1 flex-col gap-3 lg:h-[calc(100vh-5.5rem)] lg:overflow-hidden">
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <div className="relative min-w-48 flex-1">
            <span className="pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 text-muted-foreground">
              🔍
            </span>
            <Input
              placeholder={t.pos.searchProducts}
              className="h-10 ps-9"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          {!user.branchId && branches.length > 1 && (
            <Select value={branchId} onValueChange={(v) => setBranchId(v ?? "")}>
              <SelectTrigger className="h-10 w-40">
                <SelectValue placeholder={t.common.branch}>
                  {branches.find((b) => b.id === branchId)?.name}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {branches.map((b) => (
                  <SelectItem key={b.id} value={b.id}>
                    {b.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>

        <CategoryTabs
          categories={categories}
          active={activeCategory}
          counts={countsByCategory}
          onChange={setActiveCategory}
        />

        <ProductGrid
          products={visibleProducts}
          currency={currency}
          onSelect={handleSelectProduct}
        />
      </div>

      {/* Sticky order cart */}
      <OrderCart
        cart={cart}
        currency={currency}
        orderType={orderType}
        details={details}
        branchId={branchId || undefined}
        tableReloadKey={tableReload}
        totalBeforeLoyalty={preLoyaltyCharges.total}
        redeem={redeem}
        onRedeemChange={setRedeem}
        subtotal={subtotal}
        discountInput={discountInput}
        discountAmount={discountAmount}
        serviceCharge={serviceCharge}
        taxRate={effectiveTaxRate}
        taxAmount={taxAmount}
        total={total}
        collectionMode={collectionMode}
        paidInput={paidInput}
        method={method}
        mixed={mixed}
        placeDisabled={disabledReason !== null}
        disabledReason={disabledReason}
        submitting={submitting}
        onTypeChange={setOrderType}
        onDetailsChange={setDetails}
        onQuantityChange={changeQuantity}
        onRemove={removeLine}
        onNoteChange={changeNote}
        onDiscountChange={setDiscountInput}
        onCollectionModeChange={setCollectionMode}
        onPaidChange={setPaidInput}
        onMethodChange={setMethod}
        onMixedChange={changeMixed}
        onPlaceOrder={placeOrder}
      />

      {/* Variant / add-ons / note dialog */}
      <Dialog open={configuring !== null} onOpenChange={(o) => !o && setConfiguring(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{configuring?.name}</DialogTitle>
          </DialogHeader>
          {configuring && (
            <div className="space-y-4">
              {configuring.variants.filter((v) => v.isActive).length > 0 && (
                <div className="space-y-2">
                  <Label>{t.pos.variant}</Label>
                  <div className="flex flex-wrap gap-2">
                    {configuring.variants
                      .filter((v) => v.isActive)
                      .map((v) => (
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
              {configuring.addOns.filter((a) => a.addOn.isActive).length > 0 && (
                <div className="space-y-2">
                  <Label>{t.pos.addOns}</Label>
                  <div className="flex flex-wrap gap-2">
                    {configuring.addOns
                      .filter((a) => a.addOn.isActive)
                      .map(({ addOn }) => (
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
                <Label>{t.pos.itemNote}</Label>
                <Textarea
                  rows={2}
                  placeholder={t.pos.itemNotePlaceholder}
                  value={itemNote}
                  onChange={(e) => setItemNote(e.target.value)}
                />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button onClick={confirmConfigure} className="w-full sm:w-auto">
              {t.pos.addToOrder}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      </div>
    </div>
  );
}
