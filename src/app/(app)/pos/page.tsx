"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
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
import {
  cartAdjusted,
  type BranchAvailability,
  type CartDemandLine,
} from "@/lib/available-to-sell";
import { AvailabilityBadge } from "@/components/pos/availability-badge";
import { ConfiguredAvailability } from "@/components/pos/configured-availability";
import { CategoryTabs } from "@/components/pos/category-tabs";
import { ProductGrid } from "@/components/pos/product-grid";
import { OrderCart } from "@/components/pos/order-cart";
import { ShiftControls } from "@/components/pos/shift-controls";
import { CollectPaymentPanel } from "@/components/pos/collect-payment-panel";
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

// The POS tree must not sit inside the Suspense boundary that useSearchParams
// requires. On a full page load React streams such a boundary as "queued"
// ($~); its subtree is parked in a hidden container and never hydrates, so the
// cashier gets a blank screen (POS-UI-001). Only the tiny param reader needs
// the boundary — which is what the Next docs actually prescribe.
export default function PosPage() {
  return <PosPageInner />;
}

// Reads the collection-mode deep link inside its own (empty) boundary and
// hands the params to the page. Renders nothing.
function CollectionModeParams({
  onParams,
}: {
  onParams: (sp: URLSearchParams) => void;
}) {
  const searchParams = useSearchParams();
  useEffect(() => {
    onParams(new URLSearchParams(searchParams.toString()));
  }, [searchParams, onParams]);
  return null;
}

function PosPageInner() {
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

  // ── Collection mode (تحصيل دفع) — deep-linked from orders/tables ──
  // /pos?collectOrderId=X   → single-order collection dialog
  // /pos?collectTableSessionId=Y or /pos?table=6&mode=collect
  //                         → select the table so فواتير الترابيزة opens
  const [collectOrderId, setCollectOrderId] = useState<string | null>(null);
  const [collectTableBanner, setCollectTableBanner] = useState<string | null>(null);

  const applyCollectionParams = useCallback((sp: URLSearchParams) => {
    const orderParam = sp.get("collectOrderId");
    const sessionParam = sp.get("collectTableSessionId");
    const tableParam = sp.get("table");
    const modeParam = sp.get("mode");
    if (orderParam) setCollectOrderId(orderParam);
    if (tableParam && modeParam === "collect") {
      setOrderType("DINE_IN");
      setDetails((d) => ({ ...d, tableNumber: tableParam }));
      setCollectTableBanner(tableParam);
    } else if (sessionParam) {
      // Resolve the session to its table, then open its invoice cards.
      api<{ target: { tableNumber: string } }>(
        `/api/payments/collect-info?tableSessionId=${sessionParam}`
      )
        .then((r) => {
          setOrderType("DINE_IN");
          setDetails((d) => ({ ...d, tableNumber: r.target.tableNumber }));
          setCollectTableBanner(r.target.tableNumber);
        })
        .catch((e) => toast.error(e instanceof Error ? e.message : "فشل تحميل حساب الترابيزة"));
    }
  }, []);

  function exitCollectionMode() {
    setCollectOrderId(null);
    setCollectTableBanner(null);
    router.replace("/pos", { scroll: false });
  }

  // ── Shift gate (cashiers must have an open shift) ────────────
  const [shiftActive, setShiftActive] = useState(false);
  const canOperateShift =
    user.role === "CASHIER" ||
    user.role === "BRANCH_MANAGER" ||
    user.role === "CAFE_OWNER";
  const needsShift = user.role === "CASHIER";

  // ── Available-to-sell ────────────────────────────────────────
  // How many more of each configuration the branch can physically make. Kept
  // apart from the menu on purpose: the menu is what the café sells and
  // changes when somebody edits it, while this changes on every sale,
  // delivery, cancellation and recipe edit. Caching it alongside the products
  // would serve a number that was true when the shift opened.
  const [availability, setAvailability] = useState<BranchAvailability | null>(null);

  const loadAvailability = useCallback(() => {
    if (!branchId) return;
    api<{ availability: BranchAvailability }>(
      `/api/pos/availability?branchId=${branchId}`
    )
      .then((r) => setAvailability(r.availability))
      // A failed load leaves the cards with no badge rather than a wrong one.
      // Availability is an aid to the cashier, never a gate — the order
      // endpoint enforces the café's policy whatever this screen shows.
      .catch(() => setAvailability(null));
  }, [branchId]);

  useEffect(() => {
    loadAvailability();
  }, [loadAvailability]);

  // The board goes stale from other tills, the kitchen, and deliveries, so it
  // is refreshed whenever this till comes back to the front — which is what a
  // cashier actually does between orders — and on a slow beat while it stays
  // there. No realtime channel is opened for this: none exists in the app
  // today, and one built for a count on a card would be a subsystem to
  // operate forever.
  useEffect(() => {
    if (!branchId) return;
    const onFocus = () => loadAvailability();
    window.addEventListener("focus", onFocus);
    const timer = setInterval(loadAvailability, 60_000);
    return () => {
      window.removeEventListener("focus", onFocus);
      clearInterval(timer);
    };
  }, [branchId, loadAvailability]);

  // What this cart has already spoken for. Subtracted from the board in the
  // browser, so tapping a product updates every card that shares an
  // ingredient without a round trip.
  const cartDemandLines: CartDemandLine[] = useMemo(
    () =>
      cart.map((l) => ({
        productId: l.product.id,
        variantId: l.variant?.id ?? null,
        addOnIds: l.addOns.map((a) => a.id),
        quantity: l.quantity,
      })),
    [cart]
  );

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
  // Manual discount only — the loyalty discount is displayed as its own
  // "خصم النقاط" row in the payment summary.
  const discountAmount = preLoyaltyCharges.discountAmount;
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
      // The order just took capacity, and the cart it was subtracted from is
      // now empty — so the cards must come back from the server rather than
      // springing back to their pre-cart numbers.
      loadAvailability();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "فشل تسجيل الطلب");
    } finally {
      setSubmitting(false);
    }
  }

  // ── Render ───────────────────────────────────────────────────
  return (
    <div className="flex flex-col gap-4">
      <Suspense fallback={null}>
        <CollectionModeParams onParams={applyCollectionParams} />
      </Suspense>

      {canOperateShift && branchId && (
        <ShiftControls
          branchId={branchId}
          currency={currency}
          onActiveChange={setShiftActive}
        />
      )}

      {/* تحصيل دفع mode banner — deep-linked table collection */}
      {collectTableBanner && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-500/50 bg-amber-500/10 px-4 py-2.5">
          <p className="text-sm font-semibold text-amber-800 dark:text-amber-300">
            💵 وضع تحصيل الدفع — ترابيزة {collectTableBanner}
            <span className="ms-2 font-normal text-amber-700/80 dark:text-amber-400/80">
              فواتير الترابيزة والتحصيل في لوحة الكاشير الجانبية
            </span>
          </p>
          <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={exitCollectionMode}>
            رجوع لإنشاء طلب
          </Button>
        </div>
      )}

      {/* Single-order collection dialog (/pos?collectOrderId=…) */}
      {collectOrderId && (
        <CollectPaymentPanel
          orderId={collectOrderId}
          currency={currency}
          needsShift={needsShift}
          shiftActive={shiftActive}
          onDone={exitCollectionMode}
          onClose={exitCollectionMode}
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
          availability={availability}
          cartDemand={cartDemandLines}
          onSelect={handleSelectProduct}
        />
      </div>

      {/* Sticky order cart */}
      <OrderCart
        cart={cart}
        currency={currency}
        availability={availability}
        cartDemand={cartDemandLines}
        orderType={orderType}
        details={details}
        branchId={branchId || undefined}
        tableReloadKey={tableReload}
        totalBeforeLoyalty={preLoyaltyCharges.total}
        previewTotalAfterDiscount={(loyaltyDisc) =>
          computeCharges({
            subtotal,
            discount: (Number(discountInput) || 0) + loyaltyDisc,
            orderType,
            settings: effectiveSettings,
          }).total
        }
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
                  {/* Each size carries its OWN count. A large latte is not a
                      small one — they are priced, costed and now counted
                      separately — so the picker is where a multi-size product
                      gets its numbers, and the card outside stays honest by
                      showing a range instead of one of them. */}
                  <div className="flex flex-wrap gap-2">
                    {configuring.variants
                      .filter((v) => v.isActive)
                      .map((v) => (
                        <Button
                          key={v.id}
                          size="sm"
                          variant={selVariant === v.id ? "default" : "outline"}
                          className="h-auto flex-col items-start gap-0.5 py-1.5"
                          onClick={() => setSelVariant(v.id)}
                        >
                          <span>
                            {v.name} — {money(v.price, currency)}
                          </span>
                          <AvailabilityBadge
                            availability={
                              availability
                                ? cartAdjusted(
                                    availability,
                                    {
                                      productId: configuring.id,
                                      variantId: v.id,
                                      addOnIds: [...selAddOns],
                                    },
                                    cartDemandLines
                                  )
                                : null
                            }
                            mode={availability?.mode ?? "STRICT"}
                            afterCart={cartDemandLines.length > 0}
                          />
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
              {/* The count for what is actually being added: this size, with
                  these add-ons, after this cart. An extra shot draws beans of
                  its own, so the configured line can support fewer than the
                  drink alone — which is the number the cashier is about to
                  promise. */}
              <ConfiguredAvailability
                availability={availability}
                selection={{
                  productId: configuring.id,
                  variantId: selVariant || null,
                  addOnIds: [...selAddOns],
                }}
                cartDemand={cartDemandLines}
              />
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
