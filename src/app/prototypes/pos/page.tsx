"use client";

import * as React from "react";
import {
  POS_CATEGORIES,
  POS_PRODUCTS,
  INITIAL_MOCK_CART,
  calculateCartTotals,
  type POSProduct,
  type POSCartItem,
  type SelectedModifier,
  type OrderType,
  type PaymentMethod,
} from "../_data/mock-data";
import { formatMoney } from "@/lib/currency";
import {
  Search,
  Plus,
  Minus,
  Trash2,
  ShoppingBag,
  CreditCard,
  Banknote,
  Smartphone,
  CheckCircle2,
  Printer,
  RotateCcw,
  X,
  SlidersHorizontal,
  ChevronDown,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

let cartLineCounter = 10;
function getNextCartLineId(): string {
  cartLineCounter += 1;
  return `cart-line-${cartLineCounter}`;
}

let orderSequenceNumber = 1042;
function getNextOrderNumber(): string {
  orderSequenceNumber += 1;
  return `#${orderSequenceNumber}`;
}

export default function POSPrototypePage() {
  // Catalog State
  const [activeCategory, setActiveCategory] = React.useState<string>("all");
  const [searchQuery, setSearchQuery] = React.useState("");

  // Cart State
  const [cart, setCart] = React.useState<POSCartItem[]>([...INITIAL_MOCK_CART]);
  const [orderType, setOrderType] = React.useState<OrderType>("DINE_IN");
  const [tableNumber, setTableNumber] = React.useState("طاولة 4");
  const [customerName, setCustomerName] = React.useState("");
  const [discountAmount, setDiscountAmount] = React.useState(0);

  // Customization Dialog State (when an item has variants or modifiers)
  const [customizingProduct, setCustomizingProduct] = React.useState<POSProduct | null>(null);
  const [selectedVariantId, setSelectedVariantId] = React.useState<string | undefined>(undefined);
  const [selectedModifiersState, setSelectedModifiersState] = React.useState<Record<string, string>>({});
  const [itemNote, setItemNote] = React.useState("");

  // Mobile Drawer State
  const [mobileCartOpen, setMobileCartOpen] = React.useState(false);

  // Checkout Modal State
  const [checkoutModalOpen, setCheckoutModalOpen] = React.useState(false);
  const [paymentMethod, setPaymentMethod] = React.useState<PaymentMethod>("CASH");
  const [cashReceived, setCashReceived] = React.useState<number>(0);

  // Order Success Receipt State
  const [completedOrder, setCompletedOrder] = React.useState<{
    orderNumber: string;
    items: POSCartItem[];
    totals: ReturnType<typeof calculateCartTotals>;
    orderType: OrderType;
    paymentMethod: PaymentMethod;
    cashReceived?: number;
    changeDue?: number;
    timestamp: string;
  } | null>(null);

  // Totals
  const totals = React.useMemo(() => {
    return calculateCartTotals(cart, discountAmount, 0.14);
  }, [cart, discountAmount]);

  const handleOpenCheckout = () => {
    setCashReceived(Math.ceil(totals.total));
    setCheckoutModalOpen(true);
  };

  // Filtered products
  const filteredProducts = React.useMemo(() => {
    return POS_PRODUCTS.filter((product) => {
      const matchesCategory =
        activeCategory === "all" || product.categoryId === activeCategory;
      const matchesSearch =
        searchQuery === "" ||
        product.nameAr.includes(searchQuery) ||
        product.nameEn.toLowerCase().includes(searchQuery.toLowerCase()) ||
        product.descriptionAr.includes(searchQuery);
      return matchesCategory && matchesSearch;
    });
  }, [activeCategory, searchQuery]);

  // Handle clicking a product tile
  const handleProductClick = (product: POSProduct) => {
    const hasVariants = product.variants && product.variants.length > 0;
    const hasModifiers = product.modifierGroups && product.modifierGroups.length > 0;

    if (hasVariants || hasModifiers) {
      // Open customization modal
      setCustomizingProduct(product);
      setSelectedVariantId(product.variants?.[0]?.id);

      // Default modifiers
      const defaults: Record<string, string> = {};
      product.modifierGroups?.forEach((group) => {
        const defaultOpt = group.options.find((o) => o.isDefault) || group.options[0];
        if (defaultOpt) {
          defaults[group.id] = defaultOpt.id;
        }
      });
      setSelectedModifiersState(defaults);
      setItemNote("");
    } else {
      // Quick add 1-click
      addCartItem({
        id: getNextCartLineId(),
        productId: product.id,
        productNameAr: product.nameAr,
        selectedModifiers: [],
        unitPrice: product.basePrice,
        quantity: 1,
        lineTotal: product.basePrice,
      });
      toast.success(`تمت إضافة "${product.nameAr}" إلى الطلب`);
    }
  };

  // Add customized item from dialog
  const handleConfirmCustomization = () => {
    if (!customizingProduct) return;

    const variant = customizingProduct.variants?.find((v) => v.id === selectedVariantId);
    let unitPrice = customizingProduct.basePrice + (variant?.priceDelta || 0);

    const modifiersList: SelectedModifier[] = [];
    customizingProduct.modifierGroups?.forEach((group) => {
      const selectedOptId = selectedModifiersState[group.id];
      const opt = group.options.find((o) => o.id === selectedOptId);
      if (opt) {
        unitPrice += opt.priceDelta;
        modifiersList.push({
          groupId: group.id,
          groupNameAr: group.nameAr,
          optionId: opt.id,
          optionNameAr: opt.nameAr,
          priceDelta: opt.priceDelta,
        });
      }
    });

    addCartItem({
      id: getNextCartLineId(),
      productId: customizingProduct.id,
      productNameAr: customizingProduct.nameAr,
      variantId: variant?.id,
      variantNameAr: variant?.nameAr,
      selectedModifiers: modifiersList,
      unitPrice,
      quantity: 1,
      lineTotal: unitPrice,
      notes: itemNote.trim() ? itemNote.trim() : undefined,
    });

    toast.success(`تمت إضافة "${customizingProduct.nameAr}"`);
    setCustomizingProduct(null);
  };

  const addCartItem = (newItem: POSCartItem) => {
    setCart((prev) => {
      // Check if identical item already exists (same product, same variant, same modifiers, same note)
      const existingIndex = prev.findIndex((item) => {
        if (item.productId !== newItem.productId) return false;
        if (item.variantId !== newItem.variantId) return false;
        if (item.notes !== newItem.notes) return false;
        if (item.selectedModifiers.length !== newItem.selectedModifiers.length) return false;
        return item.selectedModifiers.every((mod, idx) => {
          return mod.optionId === newItem.selectedModifiers[idx]?.optionId;
        });
      });

      if (existingIndex > -1) {
        const next = [...prev];
        const current = next[existingIndex];
        const newQty = current.quantity + newItem.quantity;
        next[existingIndex] = {
          ...current,
          quantity: newQty,
          lineTotal: current.unitPrice * newQty,
        };
        return next;
      }

      return [newItem, ...prev];
    });
  };

  // Stepper handlers
  const updateQuantity = (lineId: string, delta: number) => {
    setCart((prev) =>
      prev
        .map((item) => {
          if (item.id === lineId) {
            const newQty = item.quantity + delta;
            if (newQty <= 0) return null;
            return {
              ...item,
              quantity: newQty,
              lineTotal: item.unitPrice * newQty,
            };
          }
          return item;
        })
        .filter(Boolean) as POSCartItem[]
    );
  };

  const removeCartItem = (lineId: string) => {
    setCart((prev) => prev.filter((item) => item.id !== lineId));
    toast.info("تم حذف الصنف من السلة");
  };

  const clearCart = () => {
    setCart([]);
    setDiscountAmount(0);
    toast.info("تم تفريغ السلة");
  };

  // Complete Order
  const handleCompleteOrder = () => {
    if (cart.length === 0) {
      toast.error("السلة فارغة، يرجى إضافة أصناف أولاً");
      return;
    }

    if (paymentMethod === "CASH" && cashReceived < totals.total) {
      toast.error("المبلغ المستلم غير كافٍ لسداد قيمة الطلب");
      return;
    }

    const orderNumber = getNextOrderNumber();
    const changeDue =
      paymentMethod === "CASH" ? Math.max(0, cashReceived - totals.total) : 0;

    const completed = {
      orderNumber,
      items: [...cart],
      totals: { ...totals },
      orderType,
      paymentMethod,
      cashReceived: paymentMethod === "CASH" ? cashReceived : undefined,
      changeDue: paymentMethod === "CASH" ? changeDue : undefined,
      timestamp: new Date().toLocaleTimeString("ar-EG", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      }),
    };

    setCompletedOrder(completed);
    setCheckoutModalOpen(false);
    setMobileCartOpen(false);
    toast.success(`تم اعتماد الطلب ${orderNumber} بنجاح!`);
  };

  const handleStartNewOrder = () => {
    setCart([]);
    setDiscountAmount(0);
    setCustomerName("");
    setCompletedOrder(null);
  };

  // Calculating dialog price preview
  const currentDialogUnitPrice = React.useMemo(() => {
    if (!customizingProduct) return 0;
    const variant = customizingProduct.variants?.find((v) => v.id === selectedVariantId);
    let price = customizingProduct.basePrice + (variant?.priceDelta || 0);
    customizingProduct.modifierGroups?.forEach((group) => {
      const selectedOptId = selectedModifiersState[group.id];
      const opt = group.options.find((o) => o.id === selectedOptId);
      if (opt) price += opt.priceDelta;
    });
    return price;
  }, [customizingProduct, selectedVariantId, selectedModifiersState]);

  return (
    <div className="flex flex-col gap-5 w-full">
      {/* Page Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-[#E2E4DE] pb-4">
        <div>
          <h1 className="font-heading text-2xl font-bold tracking-tight text-[#17221E]">
            شاشة الكاشير والطلبات السريعة (POS)
          </h1>
          <p className="text-sm text-[#64746B]">
            تسجيل فوري للطلبات، دعم التخصيص والخيارات، وحساب ضريبة القيمة المضافة 14%
          </p>
        </div>

        {/* Quick Order Header Indicators */}
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-2 rounded-xl bg-white border border-[#E2E4DE] px-3 py-1.5 shadow-2xs">
            <span className="text-xs font-semibold text-[#64746B]">الكاشير:</span>
            <span className="text-xs font-bold text-[#17221E]">كريم فؤاد</span>
          </div>
          <div className="flex items-center gap-2 rounded-xl bg-[#27695B]/10 border border-[#27695B]/20 px-3 py-1.5">
            <span className="size-2 rounded-full bg-[#27695B] animate-pulse" />
            <span className="text-xs font-bold text-[#27695B]">الوردية #142 مفتوحة</span>
          </div>
        </div>
      </div>

      {/* Main Grid: Catalog (Right in RTL) + Cart Ticket (Left in RTL) */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Left Column in RTL / Right visually: Product Catalog (lg:col-span-8 or 7) */}
        <div className="lg:col-span-7 xl:col-span-8 flex flex-col gap-4">
          {/* Search Bar & Order Type selector on mobile */}
          <div className="flex flex-col sm:flex-row gap-3">
            <div className="relative flex-1">
              <Search className="absolute start-3.5 top-1/2 -translate-y-1/2 size-4 text-[#64746B]" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="ابحث عن مشروب، صنف، أو قهوة مختصة..."
                className="w-full min-h-[48px] rounded-xl border border-[#E2E4DE] bg-white pe-12 ps-10 text-sm outline-none transition-colors placeholder:text-[#8D9B93] focus:border-[#27695B] focus:ring-2 focus:ring-[#27695B]/20"
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery("")}
                  aria-label="مسح البحث"
                  className="absolute end-1 top-1/2 -translate-y-1/2 size-11 flex items-center justify-center rounded-lg text-[#64746B] hover:bg-[#F6F7F4] hover:text-[#17221E] transition-colors"
                >
                  <X className="size-4" />
                </button>
              )}
            </div>
          </div>

          {/* Category Tabs (Scrollable on small mobile, min-h 48px touch targets) */}
          <div className="flex items-center gap-2 overflow-x-auto pb-1 no-scrollbar">
            <button
              type="button"
              onClick={() => setActiveCategory("all")}
              className={cn(
                "flex min-h-[48px] items-center gap-2 rounded-xl px-4 text-sm font-semibold whitespace-nowrap transition-all outline-none",
                "focus-visible:ring-2 focus-visible:ring-[#27695B]",
                activeCategory === "all"
                  ? "bg-[#27695B] text-white shadow-xs"
                  : "bg-white border border-[#E2E4DE] text-[#17221E] hover:bg-[#F6F7F4]"
              )}
            >
              <span>✨</span>
              <span>جميع الأصناف ({POS_PRODUCTS.length})</span>
            </button>

            {POS_CATEGORIES.map((cat) => {
              const count = POS_PRODUCTS.filter((p) => p.categoryId === cat.id).length;
              const isActive = activeCategory === cat.id;

              return (
                <button
                  key={cat.id}
                  type="button"
                  onClick={() => setActiveCategory(cat.id)}
                  className={cn(
                    "flex min-h-[48px] items-center gap-2 rounded-xl px-4 text-sm font-semibold whitespace-nowrap transition-all outline-none",
                    "focus-visible:ring-2 focus-visible:ring-[#27695B]",
                    isActive
                      ? "bg-[#27695B] text-white shadow-xs"
                      : "bg-white border border-[#E2E4DE] text-[#17221E] hover:bg-[#F6F7F4]"
                  )}
                >
                  <span>{cat.icon}</span>
                  <span>{cat.nameAr}</span>
                  <span
                    className={cn(
                      "rounded-full px-1.5 py-0.2 text-xs",
                      isActive ? "bg-white/20 text-white" : "bg-[#F6F7F4] text-[#64746B]"
                    )}
                  >
                    {count}
                  </span>
                </button>
              );
            })}
          </div>

          {/* Product Grid (2-col on 375px/390px, 3-col on tablet 1024px, 4-col on desktop xl) */}
          <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-3 sm:gap-4">
            {filteredProducts.map((product) => {
              const hasOptions =
                (product.variants && product.variants.length > 0) ||
                (product.modifierGroups && product.modifierGroups.length > 0);

              return (
                <button
                  key={product.id}
                  type="button"
                  onClick={() => handleProductClick(product)}
                  className={cn(
                    "group relative flex flex-col justify-between rounded-2xl border border-[#E2E4DE] bg-white p-3.5 sm:p-4 text-start transition-all duration-150 outline-none select-none",
                    "hover:border-[#27695B] hover:shadow-md hover:-translate-y-0.5 active:scale-[0.98]",
                    "focus-visible:ring-2 focus-visible:ring-[#27695B] focus-visible:ring-offset-2"
                  )}
                >
                  {/* Top Badge if any */}
                  <div className="flex items-center justify-between w-full mb-2">
                    {product.badgeAr ? (
                      <span className="rounded-full bg-[#27695B]/10 px-2 py-0.5 text-[11px] font-bold text-[#27695B]">
                        {product.badgeAr}
                      </span>
                    ) : (
                      <span />
                    )}

                    {hasOptions && (
                      <span className="flex items-center gap-1 text-[11px] font-medium text-[#64746B] bg-[#F6F7F4] rounded-md px-1.5 py-0.5">
                        <SlidersHorizontal className="size-3" />
                        خيارات
                      </span>
                    )}
                  </div>

                  {/* Title & Description */}
                  <div className="flex flex-col gap-1 my-1">
                    <h3 className="font-heading text-base font-bold text-[#17221E] group-hover:text-[#27695B] transition-colors leading-snug">
                      {product.nameAr}
                    </h3>
                    <p className="line-clamp-2 text-xs text-[#64746B] leading-relaxed">
                      {product.descriptionAr}
                    </p>
                  </div>

                  {/* Price & Add Trigger */}
                  <div className="mt-3 flex items-center justify-between border-t border-[#F6F7F4] pt-2 w-full">
                    <div className="flex flex-col">
                      <span className="font-mono text-base font-bold text-[#17221E] tabular-nums">
                        {formatMoney(product.basePrice, "EGP")}
                      </span>
                      {hasOptions && (
                        <span className="text-[10px] text-[#64746B]">يبدأ من</span>
                      )}
                    </div>

                    <div className="flex size-9 sm:size-10 items-center justify-center rounded-xl bg-[#F6F7F4] text-[#17221E] group-hover:bg-[#27695B] group-hover:text-white transition-colors">
                      <Plus className="size-5" />
                    </div>
                  </div>
                </button>
              );
            })}
          </div>

          {filteredProducts.length === 0 && (
            <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-[#E2E4DE] bg-white p-12 text-center">
              <ShoppingBag className="size-12 text-[#8D9B93] mb-3" />
              <p className="font-heading text-base font-bold text-[#17221E]">
                لا توجد أصناف مطابقة للبحث
              </p>
              <p className="text-xs text-[#64746B] mt-1">
                جرب كتابة كلمة أخرى أو تصفح الأقسام الكاملة.
              </p>
            </div>
          )}
        </div>

        {/* Right Column in RTL / Left visually: Persistent Desktop Ticket Panel */}
        <aside
          aria-label="قسيمة الطلب الحالية"
          className="hidden lg:flex lg:col-span-5 xl:col-span-4 flex-col rounded-2xl border border-[#E2E4DE] bg-white shadow-xs overflow-hidden sticky top-20"
        >
          {/* Ticket Header & Order Type */}
          <div className="border-b border-[#E2E4DE] bg-[#F6F7F4]/60 p-4">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <ShoppingBag className="size-5 text-[#27695B]" />
                <h2 className="font-heading text-lg font-bold text-[#17221E]">
                  قسيمة الطلب ({totals.itemCount} صنف)
                </h2>
              </div>

              {cart.length > 0 && (
                <button
                  type="button"
                  onClick={clearCart}
                  className="text-xs text-rose-600 hover:text-rose-700 font-semibold px-2 py-1 rounded-md hover:bg-rose-50 transition-colors"
                >
                  تفريغ السلة
                </button>
              )}
            </div>

            {/* Order Type Tabs (min-h 44px) */}
            <div className="grid grid-cols-3 gap-1 rounded-xl bg-white p-1 border border-[#E2E4DE]">
              {(
                [
                  { type: "DINE_IN", label: "صالة" },
                  { type: "TAKEAWAY", label: "سفري" },
                  { type: "DELIVERY", label: "توصيل" },
                ] as const
              ).map((tab) => (
                <button
                  key={tab.type}
                  type="button"
                  onClick={() => setOrderType(tab.type)}
                  className={cn(
                    "min-h-[44px] rounded-lg text-xs font-bold transition-all outline-none",
                    orderType === tab.type
                      ? "bg-[#27695B] text-white shadow-xs"
                      : "text-[#64746B] hover:text-[#17221E]"
                  )}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            {/* Table / Customer Details */}
            <div className="mt-3 flex gap-2">
              <input
                type="text"
                value={tableNumber}
                onChange={(e) => setTableNumber(e.target.value)}
                placeholder="رقم الطاولة..."
                className="w-1/2 min-h-[44px] rounded-lg border border-[#E2E4DE] bg-white px-3 text-xs outline-none focus:border-[#27695B]"
              />
              <input
                type="text"
                value={customerName}
                onChange={(e) => setCustomerName(e.target.value)}
                placeholder="اسم العميل (اختياري)..."
                className="w-1/2 min-h-[44px] rounded-lg border border-[#E2E4DE] bg-white px-3 text-xs outline-none focus:border-[#27695B]"
              />
            </div>
          </div>

          {/* Cart Items List */}
          <div className="flex-1 max-h-[380px] overflow-y-auto divide-y divide-[#F6F7F4] p-3">
            {cart.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <div className="flex size-14 items-center justify-center rounded-full bg-[#F6F7F4] text-[#8D9B93] mb-2">
                  <ShoppingBag className="size-7" />
                </div>
                <p className="font-heading text-sm font-semibold text-[#17221E]">
                  السلة فارغة حالياً
                </p>
                <p className="text-xs text-[#64746B] mt-0.5">
                  اضغط على أي صنف من القائمة لإضافته للطلب
                </p>
              </div>
            ) : (
              cart.map((line) => (
                <div key={line.id} className="py-3 flex flex-col gap-2">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex flex-col">
                      <span className="font-heading text-sm font-bold text-[#17221E]">
                        {line.productNameAr}
                        {line.variantNameAr && ` (${line.variantNameAr})`}
                      </span>

                      {/* Selected Modifiers Pills */}
                      {line.selectedModifiers.length > 0 && (
                        <div className="flex flex-wrap gap-1 mt-1">
                          {line.selectedModifiers.map((mod) => (
                            <span
                              key={mod.groupId}
                              className="rounded-md bg-[#F6F7F4] px-1.5 py-0.5 text-[10px] text-[#64746B]"
                            >
                              {mod.optionNameAr}
                              {mod.priceDelta > 0 && ` (+${mod.priceDelta} ج.م)`}
                            </span>
                          ))}
                        </div>
                      )}

                      {line.notes && (
                        <span className="text-[11px] text-[#27695B] italic mt-0.5">
                          ملاحظة: {line.notes}
                        </span>
                      )}
                    </div>

                    <span className="font-mono text-sm font-bold text-[#17221E] tabular-nums shrink-0">
                      {formatMoney(line.lineTotal, "EGP")}
                    </span>
                  </div>

                  {/* Quantity Stepper & Delete Button (touch >= 48px on POS) */}
                  <div className="flex items-center justify-between pt-1">
                    <div className="flex items-center gap-1.5 rounded-lg border border-[#E2E4DE] bg-[#F6F7F4] p-0.5">
                      <button
                        type="button"
                        onClick={() => updateQuantity(line.id, -1)}
                        aria-label="إنقاص الكمية"
                        className="flex size-12 items-center justify-center rounded-md bg-white text-[#17221E] shadow-2xs hover:bg-[#F6F7F4] active:scale-95 transition-all"
                      >
                        <Minus className="size-4" />
                      </button>

                      <span className="font-mono text-sm font-bold text-[#17221E] w-8 text-center tabular-nums">
                        {line.quantity}
                      </span>

                      <button
                        type="button"
                        onClick={() => updateQuantity(line.id, 1)}
                        aria-label="زيادة الكمية"
                        className="flex size-12 items-center justify-center rounded-md bg-white text-[#17221E] shadow-2xs hover:bg-[#F6F7F4] active:scale-95 transition-all"
                      >
                        <Plus className="size-4" />
                      </button>
                    </div>

                    <button
                      type="button"
                      onClick={() => removeCartItem(line.id)}
                      aria-label="حذف الصنف"
                      className="flex size-12 items-center justify-center rounded-lg text-rose-600 hover:bg-rose-50 transition-colors"
                    >
                      <Trash2 className="size-5" />
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>

          {/* Calculations Summary & Checkout Trigger */}
          <div className="border-t border-[#E2E4DE] bg-[#F6F7F4]/40 p-4 flex flex-col gap-2.5">
            <div className="flex items-center justify-between text-xs text-[#64746B]">
              <span>المجموع الفرعي</span>
              <span className="font-mono font-medium text-[#17221E] tabular-nums">
                {formatMoney(totals.subtotal, "EGP")}
              </span>
            </div>

            {totals.discount > 0 && (
              <div className="flex items-center justify-between text-xs text-rose-600">
                <span>خصم مطبق</span>
                <span className="font-mono font-medium tabular-nums">
                  -{formatMoney(totals.discount, "EGP")}
                </span>
              </div>
            )}

            <div className="flex items-center justify-between text-xs text-[#64746B]">
              <span className="flex items-center gap-1">
                <span>ضريبة القيمة المضافة (14%)</span>
                <span className="text-[10px] bg-emerald-50 text-emerald-700 px-1 rounded">
                  مصر
                </span>
              </span>
              <span className="font-mono font-medium text-[#17221E] tabular-nums">
                {formatMoney(totals.taxAmount, "EGP")}
              </span>
            </div>

            <div className="border-t border-[#E2E4DE] pt-2 flex items-center justify-between">
              <span className="font-heading text-base font-bold text-[#17221E]">
                الإجمالي المستحق
              </span>
              <span className="font-mono text-xl font-bold text-[#27695B] tabular-nums">
                {formatMoney(totals.total, "EGP")}
              </span>
            </div>

            {/* Primary Action Button (min touch target 48px) */}
            <button
              type="button"
              disabled={cart.length === 0}
              onClick={handleOpenCheckout}
              className={cn(
                "mt-2 flex min-h-[48px] w-full items-center justify-between rounded-xl px-4 py-3 text-sm font-bold text-white transition-all shadow-md outline-none",
                "focus-visible:ring-2 focus-visible:ring-[#27695B] focus-visible:ring-offset-2",
                cart.length > 0
                  ? "bg-[#27695B] hover:bg-[#1e5348] active:scale-[0.99]"
                  : "bg-[#8D9B93] cursor-not-allowed opacity-60"
              )}
            >
              <span>إتمام الطلب (الدفع)</span>
              <span className="font-mono tabular-nums">
                {formatMoney(totals.total, "EGP")}
              </span>
            </button>
          </div>
        </aside>
      </div>

      {/* Mobile Sticky Floating Bottom Bar (visible < lg, min touch 48px) */}
      <div className="lg:hidden fixed bottom-16 inset-x-0 z-30 p-3 pointer-events-none">
        <div className="mx-auto max-w-lg pointer-events-auto">
          <button
            type="button"
            onClick={() => setMobileCartOpen(true)}
            className="flex min-h-[52px] w-full items-center justify-between rounded-2xl bg-[#151918] text-white px-4 py-3 shadow-xl border border-white/10 active:scale-[0.98] transition-all"
          >
            <div className="flex items-center gap-2.5">
              <div className="flex size-8 items-center justify-center rounded-lg bg-[#27695B] text-white font-mono font-bold text-xs">
                {totals.itemCount}
              </div>
              <span className="font-heading text-sm font-bold">عرض السلة الحالية</span>
            </div>

            <div className="flex items-center gap-2">
              <span className="font-mono text-base font-bold text-emerald-400 tabular-nums">
                {formatMoney(totals.total, "EGP")}
              </span>
              <ChevronDown className="size-4 text-white/60 rotate-180" />
            </div>
          </button>
        </div>
      </div>

      {/* Mobile Bottom Slide-Over Cart Drawer */}
      {mobileCartOpen && (
        <div
          className="lg:hidden fixed inset-0 z-50 flex flex-col justify-end bg-black/60 backdrop-blur-xs transition-opacity"
          onClick={() => setMobileCartOpen(false)}
        >
          <div
            className="flex max-h-[85vh] w-full flex-col rounded-t-3xl bg-white shadow-2xl animate-in slide-in-from-bottom duration-200"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Drawer Header */}
            <div className="flex items-center justify-between border-b border-[#E2E4DE] p-4">
              <div className="flex items-center gap-2">
                <ShoppingBag className="size-5 text-[#27695B]" />
                <h3 className="font-heading text-base font-bold text-[#17221E]">
                  سلة الطلب ({totals.itemCount} أصناف)
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setMobileCartOpen(false)}
                aria-label="إغلاق سلة الطلب"
                className="flex size-11 items-center justify-center rounded-full bg-[#F6F7F4] text-[#17221E] hover:bg-[#E2E4DE] transition-colors"
              >
                <X className="size-5" />
              </button>
            </div>

            {/* Mobile Cart Items */}
            <div className="flex-1 overflow-y-auto p-4 divide-y divide-[#F6F7F4] max-h-[45vh]">
              {cart.map((line) => (
                <div key={line.id} className="py-3 flex flex-col gap-2">
                  <div className="flex items-start justify-between">
                    <div>
                      <h4 className="font-bold text-sm text-[#17221E]">
                        {line.productNameAr}
                        {line.variantNameAr && ` (${line.variantNameAr})`}
                      </h4>
                      {line.selectedModifiers.map((m) => (
                        <span
                          key={m.groupId}
                          className="text-[11px] text-[#64746B] block"
                        >
                          {m.optionNameAr}
                        </span>
                      ))}
                    </div>
                    <span className="font-mono font-bold text-sm text-[#17221E] tabular-nums">
                      {formatMoney(line.lineTotal, "EGP")}
                    </span>
                  </div>

                  <div className="flex items-center justify-between pt-1">
                    <div className="flex items-center gap-2 rounded-lg border border-[#E2E4DE] bg-[#F6F7F4] p-1">
                      <button
                        type="button"
                        onClick={() => updateQuantity(line.id, -1)}
                        aria-label="إنقاص الكمية"
                        className="flex size-12 items-center justify-center rounded-md bg-white text-[#17221E] shadow-2xs hover:bg-[#F6F7F4] active:scale-95 transition-all"
                      >
                        <Minus className="size-4" />
                      </button>
                      <span className="font-mono font-bold text-sm w-7 text-center tabular-nums">
                        {line.quantity}
                      </span>
                      <button
                        type="button"
                        onClick={() => updateQuantity(line.id, 1)}
                        aria-label="زيادة الكمية"
                        className="flex size-12 items-center justify-center rounded-md bg-white text-[#17221E] shadow-2xs hover:bg-[#F6F7F4] active:scale-95 transition-all"
                      >
                        <Plus className="size-4" />
                      </button>
                    </div>

                    <button
                      type="button"
                      onClick={() => removeCartItem(line.id)}
                      aria-label="حذف الصنف"
                      className="flex size-12 items-center justify-center text-rose-600 rounded-lg hover:bg-rose-50 transition-colors"
                    >
                      <Trash2 className="size-5" />
                    </button>
                  </div>
                </div>
              ))}
            </div>

            {/* Drawer Footer Totals & Checkout Button */}
            <div className="border-t border-[#E2E4DE] bg-[#F6F7F4] p-4 flex flex-col gap-3">
              <div className="flex justify-between text-xs text-[#64746B]">
                <span>المجموع شامل ضريبة 14%</span>
                <span className="font-mono font-bold text-base text-[#27695B] tabular-nums">
                  {formatMoney(totals.total, "EGP")}
                </span>
              </div>

              <button
                type="button"
                onClick={() => {
                  setMobileCartOpen(false);
                  handleOpenCheckout();
                }}
                className="flex min-h-[48px] w-full items-center justify-center rounded-xl bg-[#27695B] text-white font-bold text-base shadow-md active:scale-98"
              >
                متابعة الدفع ({formatMoney(totals.total, "EGP")})
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Customization Dialog (When item has variants or modifiers) */}
      {customizingProduct && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-xs"
          onClick={() => setCustomizingProduct(null)}
        >
          <div
            className="flex w-full sm:max-w-md flex-col rounded-3xl bg-white p-5 shadow-2xl animate-in zoom-in-95 duration-150"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Modal Header */}
            <div className="flex items-start justify-between border-b border-[#E2E4DE] pb-3">
              <div>
                <h3 className="font-heading text-lg font-bold text-[#17221E]">
                  {customizingProduct.nameAr}
                </h3>
                <p className="text-xs text-[#64746B] mt-0.5">
                  {customizingProduct.descriptionAr}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setCustomizingProduct(null)}
                aria-label="إغلاق نافذة التخصيص"
                className="flex size-11 shrink-0 items-center justify-center rounded-full text-[#64746B] hover:bg-[#F6F7F4] transition-colors"
              >
                <X className="size-5" />
              </button>
            </div>

            {/* Options Body */}
            <div className="flex-1 overflow-y-auto py-4 space-y-4 max-h-[60vh]">
              {/* Variants Section (if any) */}
              {customizingProduct.variants && (
                <div>
                  <label className="text-xs font-bold text-[#17221E] block mb-2">
                    الحجم / الخيار الأساسي
                  </label>
                  <div className="grid grid-cols-2 gap-2">
                    {customizingProduct.variants.map((v) => {
                      const isSelected = selectedVariantId === v.id;
                      return (
                        <button
                          key={v.id}
                          type="button"
                          onClick={() => setSelectedVariantId(v.id)}
                          className={cn(
                            "flex min-h-[48px] flex-col items-center justify-center rounded-xl border p-2 text-xs font-bold transition-all",
                            isSelected
                              ? "border-[#27695B] bg-[#27695B]/10 text-[#27695B]"
                              : "border-[#E2E4DE] bg-white text-[#17221E] hover:bg-[#F6F7F4]"
                          )}
                        >
                          <span>{v.nameAr}</span>
                          {v.priceDelta !== 0 && (
                            <span className="text-[10px] text-[#64746B]">
                              {v.priceDelta > 0 ? `+${v.priceDelta}` : v.priceDelta} ج.م
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Modifier Groups */}
              {customizingProduct.modifierGroups?.map((group) => (
                <div key={group.id}>
                  <label className="text-xs font-bold text-[#17221E] block mb-2">
                    {group.nameAr}
                  </label>
                  <div className="grid grid-cols-2 gap-2">
                    {group.options.map((opt) => {
                      const isSelected = selectedModifiersState[group.id] === opt.id;
                      return (
                        <button
                          key={opt.id}
                          type="button"
                          onClick={() =>
                            setSelectedModifiersState((prev) => ({
                              ...prev,
                              [group.id]: opt.id,
                            }))
                          }
                          className={cn(
                            "flex min-h-[48px] flex-col items-center justify-center rounded-xl border p-2 text-xs font-bold transition-all",
                            isSelected
                              ? "border-[#27695B] bg-[#27695B]/10 text-[#27695B]"
                              : "border-[#E2E4DE] bg-white text-[#17221E] hover:bg-[#F6F7F4]"
                          )}
                        >
                          <span>{opt.nameAr}</span>
                          {opt.priceDelta > 0 && (
                            <span className="text-[10px] text-[#64746B]">
                              +{opt.priceDelta} ج.م
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}

              {/* Custom Note Input */}
              <div>
                <label className="text-xs font-bold text-[#17221E] block mb-1">
                  ملاحظات التحضير (اختياري)
                </label>
                <input
                  type="text"
                  value={itemNote}
                  onChange={(e) => setItemNote(e.target.value)}
                  placeholder="مثال: حليب ساخن جداً، بدون غطاء..."
                  className="w-full min-h-[44px] rounded-xl border border-[#E2E4DE] px-3 text-xs outline-none focus:border-[#27695B]"
                />
              </div>
            </div>

            {/* Modal Footer */}
            <div className="border-t border-[#E2E4DE] pt-4 flex items-center justify-between">
              <div className="flex flex-col">
                <span className="text-xs text-[#64746B]">سعر الصنف النهائي</span>
                <span className="font-mono text-lg font-bold text-[#27695B] tabular-nums">
                  {formatMoney(currentDialogUnitPrice, "EGP")}
                </span>
              </div>

              <button
                type="button"
                onClick={handleConfirmCustomization}
                className="flex min-h-[48px] items-center gap-2 rounded-xl bg-[#27695B] px-5 text-sm font-bold text-white shadow-sm hover:bg-[#1e5348] active:scale-95"
              >
                <Plus className="size-4" />
                <span>إضافة للطلب</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Checkout & Payment Modal */}
      {checkoutModalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-xs"
          onClick={() => setCheckoutModalOpen(false)}
        >
          <div
            className="flex w-full sm:max-w-lg flex-col rounded-3xl bg-white p-5 sm:p-6 shadow-2xl animate-in zoom-in-95 duration-150"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-[#E2E4DE] pb-4">
              <div>
                <h3 className="font-heading text-lg font-bold text-[#17221E]">
                  إتمام الدفع واعتماد الطلب
                </h3>
                <p className="text-xs text-[#64746B]">
                  حدد وسيلة الدفع واستكمل المحاسبة النقدية أو الإلكترونية
                </p>
              </div>
              <button
                type="button"
                onClick={() => setCheckoutModalOpen(false)}
                aria-label="إغلاق نافذة الدفع"
                className="flex size-11 shrink-0 items-center justify-center rounded-full text-[#64746B] hover:bg-[#F6F7F4] transition-colors"
              >
                <X className="size-5" />
              </button>
            </div>

            {/* Total Required Banner */}
            <div className="my-4 flex items-center justify-between rounded-2xl bg-[#F6F7F4] p-4 border border-[#E2E4DE]">
              <div>
                <span className="text-xs font-medium text-[#64746B] block">
                  المبلغ الإجمالي المستحق (شامل 14% ضريبة)
                </span>
                <span className="font-mono text-2xl font-bold text-[#27695B] tabular-nums">
                  {formatMoney(totals.total, "EGP")}
                </span>
              </div>

              <span className="rounded-lg bg-white px-3 py-1.5 text-xs font-bold text-[#17221E] border border-[#E2E4DE]">
                {totals.itemCount} صنف
              </span>
            </div>

            {/* Payment Methods Selection (min-h 48px) */}
            <div className="mb-4">
              <label className="text-xs font-bold text-[#17221E] block mb-2">
                اختر وسيلة الدفع
              </label>
              <div className="grid grid-cols-3 gap-2">
                {(
                  [
                    { method: "CASH", label: "نقدي", icon: Banknote },
                    { method: "CARD", label: "بطاقة بنكية", icon: CreditCard },
                    { method: "WALLET", label: "إنستاباي / محفظة", icon: Smartphone },
                  ] as const
                ).map((pm) => {
                  const Icon = pm.icon;
                  const isSelected = paymentMethod === pm.method;
                  return (
                    <button
                      key={pm.method}
                      type="button"
                      onClick={() => setPaymentMethod(pm.method)}
                      className={cn(
                        "flex min-h-[52px] flex-col items-center justify-center rounded-xl border p-2 text-xs font-bold transition-all outline-none",
                        isSelected
                          ? "border-[#27695B] bg-[#27695B]/10 text-[#27695B] shadow-xs"
                          : "border-[#E2E4DE] bg-white text-[#17221E] hover:bg-[#F6F7F4]"
                      )}
                    >
                      <Icon className="size-4 mb-1" />
                      <span>{pm.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Payment Specific Details */}
            {paymentMethod === "CASH" && (
              <div className="space-y-3 rounded-2xl border border-[#E2E4DE] bg-[#F6F7F4]/50 p-4 mb-4">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-bold text-[#17221E]">
                    المبلغ المستلم من العميل
                  </label>
                  <span className="text-[11px] text-[#64746B]">
                    احسب الباقي تلقائياً
                  </span>
                </div>

                <input
                  type="number"
                  value={cashReceived || ""}
                  onChange={(e) => setCashReceived(Number(e.target.value) || 0)}
                  placeholder="أدخل المبلغ المستلم..."
                  className="w-full min-h-[48px] rounded-xl border border-[#E2E4DE] bg-white px-3 text-lg font-mono font-bold text-[#17221E] outline-none focus:border-[#27695B]"
                />

                {/* Quick Cash Suggestions */}
                <div className="flex flex-wrap gap-2">
                  {[
                    Math.ceil(totals.total),
                    100,
                    200,
                    500,
                    1000,
                  ]
                    .filter((v, i, a) => a.indexOf(v) === i && v >= Math.ceil(totals.total))
                    .map((val) => (
                      <button
                        key={val}
                        type="button"
                        onClick={() => setCashReceived(val)}
                        className="inline-flex min-h-[44px] items-center justify-center rounded-xl border border-[#E2E4DE] bg-white px-3.5 py-2 text-xs font-mono font-bold text-[#17221E] hover:bg-[#27695B]/10 hover:border-[#27695B] active:scale-95 transition-all"
                      >
                        {val === Math.ceil(totals.total) ? "المبلغ بالضبط" : `${val} ج.م`}
                      </button>
                    ))}
                </div>

                {/* Calculated Change */}
                <div className="flex items-center justify-between border-t border-[#E2E4DE] pt-2">
                  <span className="text-xs font-bold text-[#17221E]">الباقي للعميل:</span>
                  <span
                    className={cn(
                      "font-mono text-base font-bold tabular-nums",
                      cashReceived >= totals.total ? "text-[#27695B]" : "text-rose-600"
                    )}
                  >
                    {cashReceived >= totals.total
                      ? formatMoney(cashReceived - totals.total, "EGP")
                      : `متبقي ${formatMoney(totals.total - cashReceived, "EGP")}`}
                  </span>
                </div>
              </div>
            )}

            {paymentMethod === "CARD" && (
              <div className="rounded-2xl border border-[#E2E4DE] bg-[#F6F7F4]/50 p-4 mb-4 text-xs text-[#64746B] space-y-2">
                <p className="font-bold text-[#17221E]">
                  جهاز نقطة البيع البنكي (POS Terminal):
                </p>
                <div className="flex items-center gap-2 text-emerald-700 bg-emerald-50 p-2.5 rounded-xl border border-emerald-200">
                  <CheckCircle2 className="size-4 shrink-0" />
                  <span>الجهاز متصل وجاهز لتمرير بطاقة الدفع (بنك مصر / فيزا)</span>
                </div>
              </div>
            )}

            {paymentMethod === "WALLET" && (
              <div className="rounded-2xl border border-[#E2E4DE] bg-[#F6F7F4]/50 p-4 mb-4 text-xs text-[#64746B] space-y-2">
                <p className="font-bold text-[#17221E]">الدفع عبر إنستاباي والمحافظ الإلكترونية:</p>
                <div className="bg-white p-3 rounded-xl border border-[#E2E4DE] space-y-1">
                  <div className="flex justify-between">
                    <span>عنوان الدفع (IPA):</span>
                    <span className="font-mono font-bold text-[#17221E]" dir="ltr">
                      nextcup@instapay
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span>رقم المحفظة للتحويل:</span>
                    <span className="font-mono font-bold text-[#17221E]" dir="ltr">
                      01099887766
                    </span>
                  </div>
                </div>
              </div>
            )}

            {/* Confirm Payment Action Button */}
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setCheckoutModalOpen(false)}
                className="flex-1 min-h-[48px] rounded-xl border border-[#E2E4DE] text-sm font-semibold text-[#17221E] hover:bg-[#F6F7F4]"
              >
                رجوع
              </button>
              <button
                type="button"
                disabled={paymentMethod === "CASH" && cashReceived < totals.total}
                onClick={handleCompleteOrder}
                className={cn(
                  "flex-[2] min-h-[48px] rounded-xl text-white text-sm font-bold shadow-md transition-all outline-none",
                  "focus-visible:ring-2 focus-visible:ring-[#27695B] focus-visible:ring-offset-2",
                  paymentMethod === "CASH" && cashReceived < totals.total
                    ? "bg-[#8D9B93] cursor-not-allowed opacity-60"
                    : "bg-[#27695B] hover:bg-[#1e5348] active:scale-98"
                )}
              >
                تأكيد الدفع وطباعة الإيصال
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Completed Order Receipt Modal */}
      {completedOrder && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-xs">
          <div className="flex w-full sm:max-w-md flex-col rounded-3xl bg-white p-5 sm:p-6 shadow-2xl animate-in zoom-in-95 duration-150">
            {/* Success Icon */}
            <div className="flex flex-col items-center text-center pb-4 border-b border-[#E2E4DE]">
              <div className="flex size-14 items-center justify-center rounded-full bg-emerald-100 text-emerald-600 mb-2">
                <CheckCircle2 className="size-8" />
              </div>
              <h3 className="font-heading text-lg font-bold text-[#17221E]">
                تم اعتماد الطلب بنجاح!
              </h3>
              <p className="text-xs text-[#64746B]">
                رقم الإيصال: <span className="font-mono font-bold text-[#17221E]">{completedOrder.orderNumber}</span>
              </p>
            </div>

            {/* Printable Receipt Preview (80mm style in Arabic) */}
            <div className="my-4 rounded-xl border border-dashed border-[#8D9B93]/40 bg-[#F6F7F4] p-4 text-xs font-mono space-y-2">
              <div className="text-center font-bold text-sm">
                نكست كب - NextCup Cafe
              </div>
              <div className="text-center text-[10px] text-[#64746B]">
                فرع وسط البلد | القاهرة
              </div>
              <div className="border-b border-dashed border-[#8D9B93]/40 pb-2 flex justify-between text-[11px]">
                <span>التوقيت: {completedOrder.timestamp}</span>
                <span>نوع: {completedOrder.orderType === "DINE_IN" ? "صالة" : "سفري"}</span>
              </div>

              {/* Items */}
              <div className="space-y-1.5 py-1">
                {completedOrder.items.map((it) => (
                  <div key={it.id} className="flex justify-between">
                    <span>
                      {it.quantity}× {it.productNameAr}
                    </span>
                    <span className="font-bold">{it.lineTotal} ج.م</span>
                  </div>
                ))}
              </div>

              <div className="border-t border-dashed border-[#8D9B93]/40 pt-2 space-y-1">
                <div className="flex justify-between text-[#64746B]">
                  <span>المجموع الفرعي:</span>
                  <span>{completedOrder.totals.subtotal} ج.م</span>
                </div>
                {completedOrder.totals.discount > 0 && (
                  <div className="flex justify-between text-rose-600">
                    <span>خصم مطبق:</span>
                    <span>-{completedOrder.totals.discount} ج.م</span>
                  </div>
                )}
                <div className="flex justify-between text-[#64746B]">
                  <span>ضريبة القيمة المضافة (14%):</span>
                  <span>{completedOrder.totals.taxAmount} ج.م</span>
                </div>
                <div className="flex justify-between font-bold text-sm text-[#17221E] pt-1 border-t border-[#8D9B93]/20">
                  <span>الإجمالي المدفوع:</span>
                  <span>{completedOrder.totals.total} ج.م</span>
                </div>

                {completedOrder.changeDue !== undefined && completedOrder.changeDue > 0 && (
                  <div className="flex justify-between text-[#27695B] font-bold">
                    <span>الباقي للعميل:</span>
                    <span>{completedOrder.changeDue} ج.م</span>
                  </div>
                )}
              </div>
            </div>

            {/* Action Buttons */}
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => toast.info("تم إرسال أمر الطباعة إلى طابعة الإيصالات")}
                className="flex-1 min-h-[48px] flex items-center justify-center gap-1.5 rounded-xl border border-[#E2E4DE] text-sm font-semibold text-[#17221E] hover:bg-[#F6F7F4]"
              >
                <Printer className="size-4" />
                <span>طباعة</span>
              </button>

              <button
                type="button"
                onClick={handleStartNewOrder}
                className="flex-[2] min-h-[48px] flex items-center justify-center gap-1.5 rounded-xl bg-[#27695B] text-white text-sm font-bold shadow-md hover:bg-[#1e5348]"
              >
                <RotateCcw className="size-4" />
                <span>طلب جديد</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
