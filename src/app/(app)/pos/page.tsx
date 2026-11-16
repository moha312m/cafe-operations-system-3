"use client";
import { TouchSelect } from "@/components/pos/touch-select";
import { TouchNumberInput } from "@/components/pos/touch-number-input";
import {priceAmendment} from '@/lib/order-amendment-math';

import { Suspense, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { api, money, ApiRequestError } from "@/lib/client";
import { RefreshCw, Search, ShoppingBag } from "lucide-react";
import { RegisterPickup } from "@/components/pos/register-pickup";
import { useWorkspaceRead } from "@/components/cafe/use-workspace-read";
import { clientRequestUuid } from "@/lib/client-request-key";
import { registerOrderType } from "@/lib/branch-register-preferences";
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
import { OwnerOverrideField } from "@/components/approvals/owner-override-field";
import { ownerOverrideErrorMessage, ownerOverrideHeaders } from "@/lib/owner-override-client";
import { ShiftControls } from "@/components/pos/shift-controls";
import { CollectPaymentPanel } from "@/components/pos/collect-payment-panel";
import { PaymentReceiptPreview } from "@/components/receipts/payment-receipt-preview";
import { QuickActions, type RepeatItem } from "@/components/pos/quick-actions";
import type { LoyaltyRedeem } from "@/components/pos/customer-loyalty";
import { currencySymbol } from "@/lib/currency";
import type { CourierPicker, CustomerDetails } from "@/components/pos/order-type-selector";
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

const EMPTY_CATEGORIES: Category[] = [];
const EMPTY_PRODUCTS: Product[] = [];
const EMPTY_BRANCHES: Branch[] = [];

const EMPTY_MIXED = { CASH: "", CARD: "", WALLET: "" };

const round2 = (n: number) => Math.round(n * 100) / 100;

const EMPTY_DETAILS: CustomerDetails = {
  customerName: "",
  customerPhone: "",
  deliveryAddress: "",
  deliveryCourierId: "",
  tableNumber: "",
};

type PlacedOrder = { id: string; orderNumber: number; total: string; branch?: { id: string; name: string }; payments?: { id: string }[] };
type DeliveryCheckout = {
  key: string;
  body: Record<string, unknown> & { branchId: string; type: "DELIVERY"; collectionMode: CollectionMode };
};

type InvoiceDiscountType = "NONE" | "PERCENT" | "FIXED";
type PosDraft = {
  cart: CartLine[];
  orderTypeDraft: OrderType | null;
  details: CustomerDetails;
  collectionMode: CollectionMode;
  method: PaymentMethod;
  paidInput: string;
  mixed: { CASH: string; CARD: string; WALLET: string };
  discountInput: string;
  invoiceDiscountType: InvoiceDiscountType;
};

function parsePosDraft(raw: string | null): PosDraft | null {
  if (!raw) return null;
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  const cart = Array.isArray(obj.cart) ? (obj.cart as CartLine[]) : [];
  const rawOrderType = obj.orderTypeDraft;
  const orderTypeDraft: OrderType | null =
    rawOrderType === "DINE_IN" || rawOrderType === "TAKEAWAY" || rawOrderType === "DELIVERY"
      ? rawOrderType
      : null;
  const rawDetails = obj.details && typeof obj.details === "object" ? (obj.details as Record<string, unknown>) : {};
  const details: CustomerDetails = {
    customerName: typeof rawDetails.customerName === "string" ? rawDetails.customerName : "",
    customerPhone: typeof rawDetails.customerPhone === "string" ? rawDetails.customerPhone : "",
    deliveryAddress: typeof rawDetails.deliveryAddress === "string" ? rawDetails.deliveryAddress : "",
    deliveryCourierId: typeof rawDetails.deliveryCourierId === "string" ? rawDetails.deliveryCourierId : "",
    tableNumber: typeof rawDetails.tableNumber === "string" ? rawDetails.tableNumber : "",
  };
  const collectionMode: CollectionMode =
    obj.collectionMode === "NOW" || obj.collectionMode === "PARTIAL" || obj.collectionMode === "PENDING"
      ? obj.collectionMode
      : "NOW";
  const method: PaymentMethod =
    obj.method === "CASH" || obj.method === "CARD" || obj.method === "WALLET" || obj.method === "MIXED"
      ? obj.method
      : "CASH";
  const rawMixed = obj.mixed && typeof obj.mixed === "object" ? (obj.mixed as Record<string, unknown>) : {};
  const mixed = {
    CASH: typeof rawMixed.CASH === "string" ? rawMixed.CASH : "",
    CARD: typeof rawMixed.CARD === "string" ? rawMixed.CARD : "",
    WALLET: typeof rawMixed.WALLET === "string" ? rawMixed.WALLET : "",
  };
  const invoiceDiscountType: InvoiceDiscountType =
    obj.invoiceDiscountType === "NONE" || obj.invoiceDiscountType === "PERCENT" || obj.invoiceDiscountType === "FIXED"
      ? obj.invoiceDiscountType
      : "FIXED";
  return {
    cart,
    orderTypeDraft,
    details,
    collectionMode,
    method,
    paidInput: typeof obj.paidInput === "string" ? obj.paidInput : "",
    mixed,
    discountInput: typeof obj.discountInput === "string" ? obj.discountInput : "",
    invoiceDiscountType,
  };
}

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
  canChooseBranch,
  onParams,
}: {
  canChooseBranch: boolean;
  onParams: (sp: URLSearchParams) => void | (() => void);
}) {
  const searchParams = useSearchParams();
  const onParamsRef = useRef(onParams);
  useEffect(() => {
    onParamsRef.current = onParams;
  });
  useEffect(() => {
    return onParamsRef.current(new URLSearchParams(searchParams.toString()));
  }, [searchParams, canChooseBranch]);
  return null;
}

function PosPageInner() {
  const router = useRouter();
  const { cafe, user, can, canKey, permKeys } = useApp();
  const canDiscount = canKey("pos.apply_discount");
  const canCreateOrder = canKey("pos.create_order");
  const canReadOrders = can("orders:read");
  // Without the discount key a cashier may still enter a discount; the server
  // accepts it only with a valid owner override code.
  const discountEnabled = canDiscount || canCreateOrder;
  const currency = cafe?.currency ?? "USD";
  const taxRate = cafe?.taxRate ?? 0;

  // ── Menu data ────────────────────────────────────────────────
  const menuIdentity = `${user.cafeId}:${user.id}:${user.branchId}:${user.role}:${canCreateOrder}:${canReadOrders}:${permKeys.join(",")}`;
  const [menuVersion, setMenuVersion] = useState(0);
  const [menuState, setMenuState] = useState<{ identity: string; version: number; categories?: Category[]; products?: Product[]; branches?: Branch[]; error?: string; denied?: boolean }>({ identity: "", version: -1 });
  const menu = menuState.identity === menuIdentity && menuState.version === menuVersion ? menuState : null;
  const categories = menu?.categories ?? EMPTY_CATEGORIES;
  const products = menu?.products ?? EMPTY_PRODUCTS;
  const branches = menu?.branches ?? EMPTY_BRANCHES;
  const menuReady = !!menu && !menu.error;
  const menuLoading = canCreateOrder && !menu;
  const refreshMenu = () => setMenuVersion(value => value + 1);
  const [selectedBranchId, setBranchId] = useState<string>(user.branchId ?? "");
  const canChooseBranch = user.role === "CAFE_OWNER" && !user.branchId;
  const branchId = canChooseBranch ? selectedBranchId : (user.branchId ?? "");
  const [activeCategory, setActiveCategory] = useState<string>("all");
  const [compactView, setCompactView] = useState<"products" | "cart">("products");
  const workspaceId = useId();
  const [registerWorkspace, setRegisterView] = useState<"sale" | "pickup">("sale");
  const registerView = canReadOrders ? registerWorkspace : "sale";
  const registerTabRefs = useRef<Record<"sale" | "pickup", HTMLButtonElement | null>>({ sale: null, pickup: null });
  function selectRegisterView(view: "sale" | "pickup") {
    const params = new URLSearchParams(window.location.search);
    if (view === "pickup") params.set("workspace", view);
    else params.delete("workspace");
    const query = params.toString();
    window.history.replaceState(null, "", query ? `/pos?${query}` : "/pos");
    setRegisterView(view);
  }
  const productsId = `${workspaceId}-products`;
  const orderId = `${workspaceId}-order`;
  const productSearchRef = useRef<HTMLInputElement>(null);
  const orderHeadingRef = useRef<HTMLHeadingElement>(null);
  const pendingWorkspaceFocus = useRef<"products" | "cart" | null>(null);
  function showCompactWorkspace(view: "products" | "cart") {
    if (view === compactView) {
      (view === "products" ? productSearchRef.current : orderHeadingRef.current)?.focus();
      return;
    }
    pendingWorkspaceFocus.current = view;
    setCompactView(view);
  }
  useEffect(() => {
    const destination = pendingWorkspaceFocus.current;
    if (!destination) return;
    (destination === "products" ? productSearchRef.current : orderHeadingRef.current)?.focus();
    pendingWorkspaceFocus.current = null;
  }, [compactView]);
  const categoryStorageKey = `nextcup-category:${user.id}:${branchId}`;
  useEffect(() => {
    if (!menuReady) return;
    let saved = "all";
    try { saved = sessionStorage.getItem(categoryStorageKey) ?? "all"; } catch {}
    if (saved !== "all" && !categories.some(category => category.id === saved)) {
      saved = "all";
      try { sessionStorage.removeItem(categoryStorageKey); } catch {}
    }
    const timer = setTimeout(() => setActiveCategory(saved), 0);
    return () => clearTimeout(timer);
  }, [categoryStorageKey, categories, menuReady]);
  function selectCategory(id: string) {
    setActiveCategory(id);
    try { sessionStorage.setItem(categoryStorageKey, id); } catch {}
  }
  const [search, setSearch] = useState("");

  // ── Order state ──────────────────────────────────────────────
  const [cart, setCart] = useState<CartLine[]>([]);
  const [orderTypeDraft, setOrderType] = useState<OrderType | null>(null);
  const branchDefaultOrderType = branches.find((branch) => branch.id === branchId)?.posDefaultOrderType;
  const orderType = registerOrderType(orderTypeDraft, branchDefaultOrderType);
  const [details, setDetails] = useState<CustomerDetails>(EMPTY_DETAILS);
  const courierOptions = useWorkspaceRead<{ couriers: CourierPicker["couriers"] }>(
    canCreateOrder && orderType === "DELIVERY" && branchId
      ? `/api/orders/delivery-couriers?branchId=${encodeURIComponent(branchId)}`
      : null,
    menuIdentity,
  );
  const couriers = courierOptions.data?.couriers ?? [];
  const selectedCourierId = !courierOptions.loading && !courierOptions.error
    ? couriers.find(courier => courier.id === details.deliveryCourierId)?.id ?? null
    : null;
  const [discountInput, setDiscountInput] = useState("");
  const [invoiceDiscountType,setInvoiceDiscountType]=useState<'NONE'|'PERCENT'|'FIXED'>('FIXED');
  let manualDiscount=0,discountError:string|null=null,invoiceDiscountError:string|null=null;
  if(discountEnabled&&cart.length){const amendmentLines=cart.map(l=>({id:l.key,unitPrice:String(l.unitPrice),addOnTotal:'0',quantity:l.quantity,discount:l.discount??{type:'NONE',value:'0'}}));try{manualDiscount=Number(priceAmendment(amendmentLines,{type:invoiceDiscountType,value:discountInput||'0'}).discountAmount);}catch(e){discountError=e instanceof Error?e.message:'خصم غير صالح';}
    // The same message is thrown for line and invoice discounts. Mark the invoice field when it is invalid on its own (line discounts neutralized)
    // or when the combination fails while the line discounts alone are valid; leave it unmarked only when a line discount is the sole cause.
    if(discountError){
      const noLineDiscount=amendmentLines.map(l=>({...l,discount:{type:'NONE',value:'0'}}));
      let invoiceOnlyError:string|null=null,lineOnlyError=false;
      try{priceAmendment(noLineDiscount,{type:invoiceDiscountType,value:discountInput||'0'});}catch(e){invoiceOnlyError=e instanceof Error?e.message:'خصم غير صالح';}
      try{priceAmendment(amendmentLines,{type:'NONE',value:'0'});}catch{lineOnlyError=true;}
      invoiceDiscountError=invoiceOnlyError??(lineOnlyError?null:discountError);
    }}
  const [overrideCode, setOverrideCode] = useState("");
  const overrideOffered = manualDiscount > 0 && (!canDiscount || !["CAFE_OWNER", "BRANCH_MANAGER"].includes(user.role));
  const [method, setMethod] = useState<PaymentMethod>("CASH");
  const [mixed, setMixed] = useState<{ CASH: string; CARD: string; WALLET: string }>(
    EMPTY_MIXED
  );
  const [collectionMode, setCollectionMode] = useState<CollectionMode>("NOW");
  const [paidInput, setPaidInput] = useState("");
  const [settingsVersion, setSettingsVersion] = useState(0);
  const settingsIdentity = `${menuIdentity}:${branchId}:${settingsVersion}`;
  const [settingsState, setSettingsState] = useState<{ identity: string; data?: ChargeSettings; error?: string }>({ identity: "" });
  const finSettings = settingsState.identity === settingsIdentity ? settingsState.data ?? null : null;
  const settingsError = settingsState.identity === settingsIdentity ? settingsState.error : undefined;
  const [submitting, setSubmitting] = useState(false);
  const submissionInFlight = useRef(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [receiptPaymentId, setReceiptPaymentId] = useState<string | null>(null);
  const [pickupConfirmation, setPickupConfirmation] = useState<{ id: string; orderNumber: number; branchName: string; zeroTotal: boolean } | null>(null);
  // Bumped after a dine-in order is placed so the table invoice cards refetch.
  const [tableReload, setTableReload] = useState(0);
  // Loyalty points the cashier is redeeming for this order.
  const [redeem, setRedeem] = useState<LoyaltyRedeem>({ points: 0, discount: 0 });

  const draftKey = branchId ? `nextcup-pos-draft:${user.cafeId ?? ""}:${user.id}:${branchId}` : "";
  const deliveryCheckoutKey = draftKey ? `${draftKey}:delivery-checkout` : "";
  const [deliveryCheckoutState, setDeliveryCheckoutState] = useState<{ key: string; checkout: DeliveryCheckout | null }>({ key: "", checkout: null });
  const deliveryCheckout = deliveryCheckoutState.key === deliveryCheckoutKey ? deliveryCheckoutState.checkout : null;
  const [hydratedDraftKey, setHydratedDraftKey] = useState("");
  const previousDraftKeyRef = useRef("");
  const suppressNextDraftSaveRef = useRef(false);

  // ── Collection mode (تحصيل دفع) — deep-linked from orders/tables ──
  // /pos?collectOrderId=X   → single-order collection dialog
  // /pos?collectTableSessionId=Y or /pos?table=6&mode=collect
  //                         → select the table so فواتير الترابيزة opens
  const [collectOrderId, setCollectOrderId] = useState<string | null>(null);
  const [collectTableBanner, setCollectTableBanner] = useState<string | null>(null);

  function applyCollectionParams(sp: URLSearchParams) {
    const controller = new AbortController();
    const orderParam = sp.get("collectOrderId");
    const sessionParam = sp.get("collectTableSessionId");
    const tableParam = sp.get("table");
    const modeParam = sp.get("mode");
    const branchParam = sp.get("branchId");
    if (branchParam && canChooseBranch) setBranchId(branchParam);
    setRegisterView(sp.get("workspace") === "pickup" ? "pickup" : "sale");
    if (orderParam) setCollectOrderId(orderParam);
    if (tableParam && modeParam === "collect") {
      setOrderType("DINE_IN");
      setDetails((d) => ({ ...d, tableNumber: tableParam }));
      setCollectTableBanner(tableParam);
    } else if (sessionParam) {
      // Resolve the session to its table, then open its invoice cards.
      api<{ target: { tableNumber: string } }>(
        `/api/payments/collect-info?tableSessionId=${sessionParam}`, { signal: controller.signal, readTimeoutMs: 20_000 }
      )
        .then((r) => {
          if (controller.signal.aborted) return;
          setOrderType("DINE_IN");
          setDetails((d) => ({ ...d, tableNumber: r.target.tableNumber }));
          setCollectTableBanner(r.target.tableNumber);
        })
        .catch((e) => { if (!controller.signal.aborted) toast.error(e instanceof Error ? e.message : "فشل تحميل حساب الترابيزة"); });
    }
    return () => controller.abort();
  }

  function exitCollectionMode() {
    setCollectOrderId(null);
    setCollectTableBanner(null);
    setDetails((d) => ({ ...d, tableNumber: "" }));
    router.replace("/pos", { scroll: false });
  }

  function setOrderTypeAndSync(next: OrderType | null) {
    setOrderType(next);
    if (next !== "DINE_IN") {
      setDetails((d) => (d.tableNumber ? { ...d, tableNumber: "" } : d));
    }
  }

  function clearCart() {
    setCart([]);
    setOrderType(null);
    setDetails(EMPTY_DETAILS);
    setDiscountInput("");
    setInvoiceDiscountType("FIXED");
    setCollectionMode("NOW");
    setPaidInput("");
    setMixed(EMPTY_MIXED);
    setOverrideCode("");
    setRedeem({ points: 0, discount: 0 });
    setSubmitError(null);
    if (draftKey) {
      suppressNextDraftSaveRef.current = true;
      try { window.sessionStorage.removeItem(draftKey); } catch {}
    }
  }

  function handleBranchSwitch(next: string) {
    if (next && next !== branchId && cart.length > 0) {
      if (draftKey) {
        try {
          window.sessionStorage.setItem(
            draftKey,
            JSON.stringify({
              cart,
              orderTypeDraft,
              details,
              collectionMode,
              method,
              paidInput,
              mixed,
              discountInput,
              invoiceDiscountType,
            } satisfies PosDraft)
          );
        } catch {}
      }
      toast.info("تم حفظ مسودة طلب الفرع السابق مؤقتًا — راجع الأسعار والفرع الحالي");
    }
    setBranchId(next);
  }

  useEffect(() => {
    if (!draftKey) return;
    const timer = window.setTimeout(() => {
      let checkout: DeliveryCheckout | null = null;
      try {
        const raw = window.sessionStorage.getItem(deliveryCheckoutKey);
        const saved = raw ? JSON.parse(raw) as DeliveryCheckout : null;
        if (saved?.key && saved.body?.type === "DELIVERY" && saved.body.branchId === branchId) checkout = saved;
      } catch { /* Delivery checkout verifies storage before sending. */ }
      setDeliveryCheckoutState({ key: deliveryCheckoutKey, checkout });
      const prevKey = previousDraftKeyRef.current;
      previousDraftKeyRef.current = draftKey;
      let draft: PosDraft | null = null;
      try {
        draft = parsePosDraft(window.sessionStorage.getItem(draftKey));
      } catch {
        try { window.sessionStorage.removeItem(draftKey); } catch {}
      }
      const sp = new URLSearchParams(window.location.search);
      const hasTableDeepLink =
        (sp.get("mode") === "collect" && !!sp.get("table")) ||
        !!sp.get("collectTableSessionId");
      if (draft) {
        suppressNextDraftSaveRef.current = true;
        setCart(draft.cart);
        if (!hasTableDeepLink) {
          setOrderType(draft.orderTypeDraft);
          setDetails(draft.details);
        } else {
          setDetails((d) => ({
            ...draft.details,
            tableNumber: d.tableNumber || draft.details.tableNumber,
          }));
        }
        setCollectionMode(draft.collectionMode);
        setMethod(draft.method);
        setPaidInput(draft.paidInput);
        setMixed(draft.mixed);
        setDiscountInput(draft.discountInput);
        setInvoiceDiscountType(draft.invoiceDiscountType);
      } else if (prevKey && prevKey !== draftKey) {
        suppressNextDraftSaveRef.current = true;
        setCart([]);
        if (!hasTableDeepLink) {
          setOrderType(null);
          setDetails(EMPTY_DETAILS);
        }
        setCollectionMode("NOW");
        setMethod("CASH");
        setPaidInput("");
        setMixed(EMPTY_MIXED);
        setDiscountInput("");
        setInvoiceDiscountType("FIXED");
        setOverrideCode("");
        setRedeem({ points: 0, discount: 0 });
      }
      setHydratedDraftKey(draftKey);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [draftKey, deliveryCheckoutKey, branchId]);

  useEffect(() => {
    if (!draftKey || hydratedDraftKey !== draftKey) return;
    if (suppressNextDraftSaveRef.current) {
      suppressNextDraftSaveRef.current = false;
      return;
    }
    const hasContent =
      cart.length > 0 ||
      orderTypeDraft !== null ||
      details.customerName !== "" ||
      details.customerPhone !== "" ||
      details.deliveryAddress !== "" ||
      details.deliveryCourierId !== "" ||
      details.tableNumber !== "" ||
      collectionMode !== "NOW" ||
      method !== "CASH" ||
      paidInput !== "" ||
      mixed.CASH !== "" ||
      mixed.CARD !== "" ||
      mixed.WALLET !== "" ||
      discountInput !== "" ||
      invoiceDiscountType !== "FIXED";
    try {
      if (!hasContent) {
        window.sessionStorage.removeItem(draftKey);
      } else {
        window.sessionStorage.setItem(
          draftKey,
          JSON.stringify({
            cart,
            orderTypeDraft,
            details,
            collectionMode,
            method,
            paidInput,
            mixed,
            discountInput,
            invoiceDiscountType,
          } satisfies PosDraft)
        );
      }
    } catch {}
  }, [
    draftKey,
    hydratedDraftKey,
    cart,
    orderTypeDraft,
    details,
    collectionMode,
    method,
    paidInput,
    mixed,
    discountInput,
    invoiceDiscountType,
  ]);

  // ── Shift gate (cashiers and immediate-collection orders require an open shift) ─
  const [activeShiftBranch, setActiveShiftBranch] = useState<string | null>(null);
  const shiftActive = activeShiftBranch === branchId;
  const handleShiftActive = useCallback((active: boolean) => {
    setActiveShiftBranch(active ? branchId : null);
  }, [branchId]);
  const canOperateShift =
    can("shifts:operate") ||
    user.role === "CASHIER" ||
    user.role === "BRANCH_MANAGER" ||
    user.role === "CAFE_OWNER";
  const orderNeedsShift = user.role === "CASHIER" || collectionMode !== "PENDING";

  // ── Item configuration dialog (variant / add-ons / note) ────
  const [configuring, setConfiguring] = useState<Product | null>(null);
  const [selVariant, setSelVariant] = useState<string>("");
  const [selAddOns, setSelAddOns] = useState<Set<string>>(new Set());
  const [itemNote, setItemNote] = useState("");

  useEffect(() => {
    if (!canCreateOrder && !canReadOrders) return;
    const controller = new AbortController();
    let live = true;
    const read = { signal: controller.signal, readTimeoutMs: 20_000 };
    const branchesPromise = api<{ branches: (Branch & { isActive?: boolean })[] }>("/api/branches", read);
    if (!canCreateOrder) {
      branchesPromise
        .then((b) => {
          if (!live) return;
          const activeBranches = b.branches.filter(branch => branch.isActive !== false);
          setMenuState({ identity: menuIdentity, version: menuVersion, categories: [], products: [], branches: activeBranches });
          if (canChooseBranch) setBranchId(current => activeBranches.some(branch => branch.id === current) ? current : activeBranches[0]?.id ?? "");
        })
        .catch((error: unknown) => {
          if (!live || controller.signal.aborted) return;
          if (error instanceof ApiRequestError && error.status === 403) {
            setMenuState({ identity: menuIdentity, version: menuVersion, categories: [], products: [], branches: [] });
            return;
          }
          setMenuState({ identity: menuIdentity, version: menuVersion, error: error instanceof Error ? error.message : "تعذر تحميل بيانات الفروع" });
        });
      return () => { live = false; controller.abort(); };
    }
    Promise.all([
      api<{ categories: Category[] }>("/api/categories", read),
      api<{ products: Product[] }>("/api/products", read),
      branchesPromise,
    ]).then(([c, p, b]) => {
      if (!live) return;
      const activeBranches = b.branches.filter(branch => branch.isActive !== false);
      setMenuState({ identity: menuIdentity, version: menuVersion, categories: c.categories.filter(x => x.isActive), products: p.products, branches: activeBranches });
      if (canChooseBranch) setBranchId(current => activeBranches.some(branch => branch.id === current) ? current : activeBranches[0]?.id ?? "");
    }).catch((error: unknown) => {
      if (!live || controller.signal.aborted) return;
      setMenuState({ identity: menuIdentity, version: menuVersion, error: error instanceof Error ? error.message : "تعذر تحميل قائمة البيع", denied: error instanceof ApiRequestError && error.status === 403 });
    });
    return () => { live = false; controller.abort(); };
  }, [menuIdentity, menuVersion, canCreateOrder, canReadOrders, canChooseBranch]);

  // Only the current branch read may supply preview tax/service settings.
  // Cancellation is limited to reads; financial submission keys remain untouched.
  useEffect(() => {
    if (!branchId || !canCreateOrder) return;
    const controller = new AbortController();
    let live = true;
    api<{ settings: ChargeSettings }>(`/api/branches/${branchId}/financial-settings`, { signal: controller.signal, readTimeoutMs: 20_000 })
      .then(r => { if (live) setSettingsState({ identity: settingsIdentity, data: r.settings }); })
      .catch((error: unknown) => { if (live && !controller.signal.aborted) setSettingsState({ identity: settingsIdentity, error: error instanceof Error ? error.message : "تعذر تحميل إعدادات الفرع" }); });
    return () => { live = false; controller.abort(); };
  }, [branchId, canCreateOrder, settingsIdentity]);

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
    counts.set("all", posProducts.length);
    return counts;
  }, [posProducts]);

  const visibleProducts = useMemo(() => {
    const term = search.trim().toLowerCase();
    return posProducts.filter(
      (p) =>
        (activeCategory === "all" || p.category.id === activeCategory) &&
        (term === "" || p.name.toLowerCase().includes(term) || (p.sku ?? "").toLowerCase().includes(term))
    );
  }, [posProducts, activeCategory, search]);

  // ── Cart operations ──────────────────────────────────────────
  function addToCart(
    product: Product,
    variant: Variant | null,
    addOns: AddOn[],
    note: string,
    quantity = 1
  ) {
    // Clear the search so the cashier can type the next product right away.
    setSearch("");
    setOrderType((current) => current ?? orderType);
    const key = lineKey(product.id, variant?.id ?? null, addOns.map((a) => a.id), note);
    setCart((prev) => {
      const existing = prev.find((l) => l.key === key);
      if (existing) {
        return prev.map((l) =>
          l.key === key ? { ...l, quantity: l.quantity + quantity } : l
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
          quantity,
          unitPrice: round2(computeUnitPrice(product, variant, addOns)),
        },
      ];
    });
  }

  function handleSelectProduct(product: Product) {
    if (submissionInFlight.current || !product.isActive || product.isAvailable === false) return;
    const activeVariants = product.variants.filter((v) => v.isActive);
    const activeAddOns = product.addOns.filter((a) => a.addOn.isActive);
    if (activeVariants.length === 0 && activeAddOns.length === 0) {
      addToCart(product, null, [], "");
      toast.success(`تمت إضافة ${product.name}`, {duration: 1200});
      return;
    }
    setConfiguring(product);
    setSelVariant(activeVariants[0]?.id ?? "");
    setSelAddOns(new Set());
    setItemNote("");
  }

  // Rebuilds the customer's last order from TODAY's menu: a product, size or
  // add-on that is no longer offered is left out and named, never guessed.
  function repeatOrder(items: RepeatItem[]) {
    const skipped: string[] = [];
    let added = 0;
    for (const item of items) {
      const product = posProducts.find((p) => p.id === item.productId);
      if (!product || !product.isActive || product.isAvailable === false) {
        skipped.push(item.productName);
        continue;
      }
      const variant = item.variantId
        ? product.variants.find((v) => v.id === item.variantId && v.isActive) ?? null
        : null;
      if (item.variantId && !variant) {
        skipped.push(`${item.productName}${item.variantName ? ` (${item.variantName})` : ""}`);
        continue;
      }
      const offered = product.addOns.map((a) => a.addOn).filter((a) => a.isActive);
      const addOns = offered.filter((a) => item.addOnIds.includes(a.id));
      if (addOns.length < item.addOnIds.length) skipped.push(`إضافات ${item.productName}`);
      addToCart(product, variant, addOns, item.notes ?? "", item.quantity);
      added += item.quantity;
    }
    if (added > 0) toast.success(`اتضاف ${added} صنف من آخر طلب`);
    if (skipped.length > 0) toast.warning(`مش متاح دلوقتي: ${skipped.join("، ")}`);
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
        .map((l) => (l.key === key ? { ...l, quantity: Math.max(1, l.quantity + delta) } : l))
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
    discount: manualDiscount,
    orderType,
    settings: effectiveSettings,
  });
  const charges = computeCharges({
    subtotal,
    discount: manualDiscount + redeem.discount,
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
    if(discountError)return discountError;
    if (!canCreateOrder) return "ليس لديك صلاحية إنشاء طلب";
    if (deliveryCheckout) return "أكّد نتيجة طلب التوصيل السابق أولًا";
    if (orderNeedsShift && !shiftActive) return t.shifts.mustOpen;
    if (cart.length === 0) return t.pos.validation.emptyCart;
    if (!branchId || !branches.some(branch => branch.id === branchId)) return t.pos.validation.noBranch;
    if (!finSettings) return settingsError ? "تعذر التحقق من الضرائب والخدمة؛ أعد تحميل إعدادات الفرع قبل التحصيل" : "جارٍ التحقق من إعدادات الضرائب والخدمة…";
    if (orderType === "DINE_IN" && !details.tableNumber.trim())
      return t.pos.validation.needTable;
    if (orderType === "DELIVERY" && hydratedDraftKey !== draftKey)
      return "جاري التحقق من طلبات التوصيل السابقة…";
    if (orderType === "DELIVERY" && !selectedCourierId)
      return "اختار مندوب التوصيل أولًا";
    if (orderType === "DELIVERY" && !details.customerName.trim())
      return t.pos.validation.needCustomer;
    return null;
  }, [canCreateOrder, deliveryCheckout, orderNeedsShift, shiftActive, cart.length, branchId, branches, finSettings, settingsError, orderType, details, discountError, selectedCourierId, hydratedDraftKey, draftKey]);

  function changeMixed(field: SplitMethod, value: string) {
    setMixed((prev) => ({ ...prev, [field]: value }));
  }

  // ── Order submission ─────────────────────────────────────────
  async function placeOrder(retryDelivery = false) {
    if (submissionInFlight.current || (retryDelivery ? !deliveryCheckout || !canCreateOrder : !!disabledReason)) return;
    let checkout = retryDelivery ? deliveryCheckout : null;
    submissionInFlight.current = true;
    setSubmitError(null);
    setSubmitting(true);
    const overrideHeaders = ownerOverrideHeaders(overrideOffered ? overrideCode : "");
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

      const body = checkout?.body ?? {
          branchId: branchId || undefined,
          type: orderType,
          customerName: details.customerName.trim() || undefined,
          customerPhone: details.customerPhone.trim() || undefined,
          deliveryAddress: details.deliveryAddress.trim() || undefined,
          ...(orderType === "DELIVERY" ? { deliveryCourierId: selectedCourierId } : {}),
          tableNumber: orderType === "DINE_IN" ? (details.tableNumber.trim() || undefined) : undefined,
          // Manual discount only — the server recomputes the loyalty
          // discount from the redeemed points.
          discountAmount: 0,
          invoiceDiscount: {type:discountEnabled?invoiceDiscountType:'NONE',value:discountEnabled?(discountInput||'0'):'0'},
          loyaltyPointsToRedeem: redeem.points || undefined,
          collectionMode,
          ...paymentBody,
          items: cart.map((l) => ({
            discount:discountEnabled?(l.discount??{type:'NONE',value:'0'}):{type:'NONE',value:'0'},
            productId: l.product.id,
            variantId: l.variant?.id ?? null,
            quantity: l.quantity,
            addOnIds: l.addOns.map((a) => a.id),
            notes: l.note || undefined,
          })),
      };
      if (!checkout && orderType === "DELIVERY") {
        const next: DeliveryCheckout = {
          key: clientRequestUuid(),
          body: { ...body, branchId, type: "DELIVERY", collectionMode },
        };
        try {
          window.sessionStorage.setItem(deliveryCheckoutKey, JSON.stringify(next));
        } catch {
          throw new Error("تعذر حفظ محاولة طلب التوصيل على هذا الجهاز. لم يُرسل الطلب.");
        }
        checkout = next;
        setDeliveryCheckoutState({ key: deliveryCheckoutKey, checkout });
      }
      const { order } = await api<{ order: PlacedOrder }>("/api/orders", {
        method: "POST",
        headers: overrideHeaders,
        body: checkout?.body ?? body,
        idempotencyKey: checkout?.key,
      });
      if (checkout) clearDeliveryCheckout();
      const submittedType = checkout?.body.type ?? orderType;
      const submittedCollection = checkout?.body.collectionMode ?? collectionMode;

      const isDineIn = submittedType === "DINE_IN";
      const collectedMsg =
        submittedCollection === "NOW"
          ? ` · اتحصّل ${money(order.total, currency)}`
          : submittedCollection === "PARTIAL"
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
      if (draftKey) {
        suppressNextDraftSaveRef.current = true;
        try { window.sessionStorage.removeItem(draftKey); } catch {}
      }
      setCart([]);
      setOrderType(null);
      setDetails(isDineIn && branchDefaultOrderType !== "TAKEAWAY"
        ? { ...EMPTY_DETAILS, tableNumber: details.tableNumber }
        : EMPTY_DETAILS);
      setDiscountInput("");
      setInvoiceDiscountType("FIXED");
      setCollectionMode("NOW");
      setMixed(EMPTY_MIXED);
      setPaidInput("");
      setRedeem({ points: 0, discount: 0 });
      if (isDineIn) setTableReload((k) => k + 1);
      setPickupConfirmation(submittedType === "TAKEAWAY" && submittedCollection === "PENDING" ? {
        id: order.id, orderNumber: order.orderNumber,
        branchName: order.branch?.name ?? branches.find(branch => branch.id === branchId)?.name ?? "الفرع",
        zeroTotal: Number(order.total) === 0,
      } : null);
      // Use the payment committed with this order, for every method and partial
      // collection. Closing/printing must never resubmit the emptied cart.
      if (submittedCollection !== "PENDING" && order.payments?.[0]?.id) {
        setReceiptPaymentId(order.payments[0].id);
      }
    } catch (e) {
      if (checkout && e instanceof ApiRequestError && e.status >= 400 && e.status < 500
        && ![408, 409, 425, 429].includes(e.status) && (!retryDelivery || ![401, 403, 404].includes(e.status))) {
        clearDeliveryCheckout();
        if (e.status === 400) courierOptions.refresh();
      }
      const message = ownerOverrideErrorMessage(e, !!overrideHeaders, "فشل تسجيل الطلب");
      setSubmitError(message);
      toast.error(message);
    } finally {
      // The code is single-use on this screen: never kept for the next order.
      setOverrideCode("");
      submissionInFlight.current = false;
      setSubmitting(false);
    }
  }

  function clearDeliveryCheckout() {
    try { window.sessionStorage.removeItem(deliveryCheckoutKey); } catch {}
    setDeliveryCheckoutState({ key: deliveryCheckoutKey, checkout: null });
  }

  // ── Render ───────────────────────────────────────────────────
  return (
    <div className="cashier-page flex min-w-0 flex-col gap-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div><p className="mb-1 hidden text-xs font-semibold text-primary md:block">نقطة البيع</p><h1 className="text-[28px] font-bold leading-snug">الكاشير</h1><p className="mt-1 hidden text-sm text-muted-foreground md:block">اختر المنتجات، راجع الطلب ثم حصّل.</p></div>
        <div className="flex items-center gap-2"><span className="hidden rounded-full bg-primary/8 px-3 py-2 text-sm text-primary md:inline-flex">{branches.find(branch => branch.id === branchId)?.name ?? "نطاق الفرع"}</span><Button variant="outline" aria-label="تحديث قائمة البيع" disabled={menuLoading} onClick={refreshMenu}><RefreshCw aria-hidden="true" className="size-4" /> تحديث</Button></div>
      </header>
      {receiptPaymentId && (
        <PaymentReceiptPreview key={receiptPaymentId} paymentId={receiptPaymentId} scope="order" onClose={() => setReceiptPaymentId(null)} />
      )}
      {pickupConfirmation && <section aria-label="تأكيد طلب الاستلام" className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-primary/40 bg-card p-3">
        <div role="status">
          <p className="text-lg font-semibold">رقم الاستلام <bdi className="text-2xl">#{pickupConfirmation.orderNumber}</bdi></p>
          <p className="text-sm">{pickupConfirmation.branchName} · {pickupConfirmation.zeroTotal ? "لا يوجد مبلغ مستحق" : "في انتظار التحصيل"}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {(canKey("receipts.print") || canKey("receipts.print_pickup")) && <a className="inline-flex items-center rounded-lg border px-3 text-sm font-medium"
            href={`/receipts/pickup/${encodeURIComponent(pickupConfirmation.id)}?print=1`} target="_blank" rel="noopener noreferrer">طباعة تذكرة الاستلام</a>}
          <Button variant="ghost" onClick={() => setPickupConfirmation(null)}>إخفاء التأكيد</Button>
        </div>
      </section>}
      <Suspense fallback={null}>
        <CollectionModeParams canChooseBranch={canChooseBranch} onParams={applyCollectionParams} />
      </Suspense>
      {can("orders:read") && <div role="tablist" aria-label="مساحة عمل الكاشير" className="flex gap-2">
        {(["sale", "pickup"] as const).map(view => <Button key={view}
          ref={node => { registerTabRefs.current[view] = node; }}
          id={`${workspaceId}-tab-${view}`} role="tab" aria-selected={registerView === view}
          aria-controls={`${workspaceId}-panel-${view}`} tabIndex={registerView === view ? 0 : -1}
          disabled={submitting} variant={registerView === view ? "default" : "outline"}
          onClick={() => selectRegisterView(view)}
          onKeyDown={event => {
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
            event.preventDefault();
            const next = event.key === "Home" ? "sale" : event.key === "End" ? "pickup" : view === "sale" ? "pickup" : "sale";
            selectRegisterView(next);
            registerTabRefs.current[next]?.focus();
          }}>{view === "sale" ? "بيع جديد" : "استلام الطلبات"}</Button>)}
      </div>}

      {deliveryCheckout && (
        <section aria-label="طلب توصيل بانتظار التأكيد" className="space-y-2 rounded-xl border border-primary/40 bg-card p-3">
          <p className="font-semibold">طلب توصيل بانتظار التأكيد</p>
          <p className="text-sm text-muted-foreground">أعد إرسال نفس الطلب للتأكد من تسجيله وتحصيله.</p>
          {submitError && <p role="alert" className="text-sm text-destructive">{submitError}</p>}
          {overrideOffered && <OwnerOverrideField value={overrideCode} onChange={setOverrideCode} />}
          <Button type="button" disabled={submitting || !canCreateOrder} onClick={() => placeOrder(true)}>
            تأكيد نتيجة طلب التوصيل
          </Button>
        </section>
      )}
      <fieldset disabled={submitting || !!deliveryCheckout} aria-busy={submitting} className="cashier-workspace min-w-0" data-compact-view={compactView} data-register-view={registerView}>
      <div className="cashier-lead flex min-w-0 shrink-0 flex-col gap-3">
        {!canChooseBranch && !branchId && (
          <p role="alert" className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-amber-900">
            حسابك غير معيّن على فرع. اطلب من المدير تعيين الفرع قبل فتح الشيفت.
          </p>
        )}

        {canOperateShift && branchId && (
          <ShiftControls
            key={branchId}
            branchId={branchId}
            currency={currency}
            onActiveChange={handleShiftActive}
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
          <CollectPaymentPanel key={collectOrderId}
            orderId={collectOrderId}
            currency={currency}
            needsShift={true}
            shiftActive={shiftActive}
            onDone={exitCollectionMode}
            onClose={exitCollectionMode}
          />
        )}

        {settingsError && <p role="alert" className="rounded-xl bg-caramel-soft p-3 text-sm text-caramel-ink">تعذر تحميل إعدادات الضرائب والخدمة: {settingsError}. التحصيل متوقف حتى التحقق من إعدادات الفرع؛ بيانات الطلب محفوظة. <Button variant="outline" onClick={() => setSettingsVersion(value => value + 1)}>إعادة تحميل إعدادات الفرع</Button></p>}
        {submitError && <p role="alert" className="rounded-lg border border-destructive p-3">{submitError} — البيانات محفوظة للمراجعة وإعادة المحاولة.</p>}
        {submitting && <p role="status">جاري حفظ الطلب وتسجيل الدفع…</p>}
      </div>
      <div role="tabpanel" id={`${workspaceId}-panel-pickup`} aria-labelledby={`${workspaceId}-tab-pickup`}
        className={registerView === "pickup" ? "cashier-pickup min-w-0 flex-1" : "hidden"}>
        <RegisterPickup active={registerView === "pickup"} branchId={branchId} branches={branches} currency={currency} />
      </div>
      <div role={can("orders:read") ? "tabpanel" : undefined} id={`${workspaceId}-panel-sale`}
        aria-labelledby={can("orders:read") ? `${workspaceId}-tab-sale` : undefined}
        className={registerView === "sale" ? "contents" : "hidden"}>
      <div className="cashier-compact-tabs gap-2" aria-label="عرض الكاشير">
        <Button aria-controls={productsId} aria-pressed={compactView === "products"} variant={compactView === "products" ? "default" : "outline"} onClick={() => showCompactWorkspace("products")}>المنتجات والتصنيفات</Button>
        <Button aria-controls={orderId} aria-pressed={compactView === "cart"} variant={compactView === "cart" ? "default" : "outline"} onClick={() => showCompactWorkspace("cart")}>الطلب والدفع ({cart.reduce((sum,line) => sum + line.quantity,0)})</Button>
      </div>
      {/* Main area: search, categories, product grid */}
      <div id={productsId} role="region" aria-labelledby={`${productsId}-heading`} className="cashier-catalog flex min-w-0 flex-1 flex-col gap-3">
        <h2 id={`${productsId}-heading`} className="sr-only">المنتجات والتصنيفات</h2>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <div className="relative min-w-0 flex-1">
            <Search aria-hidden="true" className="pointer-events-none absolute start-3 top-1/2 size-5 -translate-y-1/2 text-muted-foreground" />
            <Input
              ref={productSearchRef}
              placeholder={t.pos.searchProducts}
              aria-label={t.pos.searchProducts}
              className="h-10 ps-9"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          {canChooseBranch && branches.length > 1 && (
            <Select value={branchId} onValueChange={(v) => handleBranchSwitch(v ?? "")}>
              <SelectTrigger className="h-10 w-32">
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

        {menuReady && branchId && canCreateOrder && <CategoryTabs
          key={`${branchId}:${categories.length}`}
          categories={categories}
          active={activeCategory}
          counts={countsByCategory}
          onChange={selectCategory}
        />}
        {menuReady && canCreateOrder && branchId && <QuickActions
          key={branchId}
          branchId={branchId}
          products={posProducts}
          customerPhone={details.customerPhone}
          showPicks={search.trim() === "" && activeCategory === "all"}
          onSelect={handleSelectProduct}
          onRepeat={repeatOrder}
        />}
        {menuReady && branchId && <div className="flex shrink-0 items-center justify-between gap-2 text-sm"><h3 className="font-semibold">{activeCategory === "all" ? "قائمة المنتجات" : categories.find(category => category.id === activeCategory)?.name ?? "المنتجات"}</h3><span className="text-muted-foreground">{visibleProducts.length} منتج مطابق</span></div>}



        <ProductGrid
          products={visibleProducts}
          state={!canCreateOrder || menu?.denied ? "denied" : menuLoading ? "loading" : menu?.error ? "error" : !branchId || !branches.some(branch => branch.id === branchId) ? "no-branch" : posProducts.length === 0 ? "empty" : visibleProducts.length === 0 ? "filtered" : "ready"}
          error={menu?.error}
          onRetry={refreshMenu}
          onClear={() => { setSearch(""); selectCategory("all"); }}
          canManageMenu={can("menu:manage")}
          currency={currency}
          onSelect={handleSelectProduct}
        />

      </div>

      {/* Sticky order cart */}
      <OrderCart
        id={orderId}
        headingId={`${orderId}-heading`}
        headingRef={orderHeadingRef}
        discountControls={cart.length > 0 ? <div className="space-y-2">{discountEnabled && <details className="space-y-2 rounded border p-2 text-sm"><summary>خصومات الأصناف والفاتورة</summary>{cart.map(l=><div key={l.key} className="flex flex-wrap items-center gap-1"><span>{l.product.name}</span><TouchSelect aria-label={'نوع خصم '+l.product.name} value={l.discount?.type??'NONE'} className="rounded border bg-background p-1" onValueChange={touchValue => setCart(rows=>rows.map(r=>r.key===l.key?{...r,discount:{type:touchValue as 'NONE'|'PERCENT'|'FIXED',value:'0'}}:r))}><option value="NONE">بدون خصم</option><option value="PERCENT">%</option><option value="FIXED">{currencySymbol(currency)}</option></TouchSelect><TouchNumberInput aria-label={'قيمة خصم '+l.product.name} type="number" min="0" step="0.01" className="w-20 rounded border bg-background p-1" disabled={!l.discount||l.discount.type==='NONE'} value={l.discount?.value??'0'} onValueChange={touchValue => setCart(rows=>rows.map(r=>r.key===l.key?{...r,discount:{type:r.discount!.type,value:touchValue}}:r))}/></div>)}<label className="block">نوع خصم الفاتورة <TouchSelect aria-label="نوع خصم الفاتورة قبل التأكيد" className="rounded border bg-background p-1" value={invoiceDiscountType} onValueChange={touchValue => {setInvoiceDiscountType(touchValue as typeof invoiceDiscountType);setDiscountInput('');}}><option value="FIXED">مبلغ</option><option value="PERCENT">نسبة %</option><option value="NONE">بدون خصم</option></TouchSelect></label><p>تُحسب خصومات الأصناف أولًا. ما يتجاوز حدك يحتاج كود تخويل المالك، أو اعتماد المدير عبر طلب تعديل بالمبيعات.</p></details>}<Button type="button" size="sm" variant="outline" className="w-full" onClick={clearCart}>تفريغ السلة</Button></div> : null}
        cart={cart}
        currency={currency}
        orderType={orderType}
        details={details}
        courierPicker={{
          couriers, selectedId: selectedCourierId, loading: courierOptions.loading,
          error: courierOptions.error, refresh: courierOptions.refresh,
        }}
        branchId={branchId || undefined}
        tableReloadKey={tableReload}
        totalBeforeLoyalty={preLoyaltyCharges.total}
        previewTotalAfterDiscount={(loyaltyDisc) =>
          computeCharges({
            subtotal,
            discount: manualDiscount + loyaltyDisc,
            orderType,
            settings: effectiveSettings,
          }).total
        }
        redeem={redeem}
        onRedeemChange={setRedeem}
        subtotal={subtotal}
        discountInput={discountEnabled ? discountInput : ""}
        discountExtra={overrideOffered ? <OwnerOverrideField value={overrideCode} onChange={setOverrideCode} /> : null}
        discountError={invoiceDiscountError}
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
        onTypeChange={setOrderTypeAndSync}
        onDetailsChange={setDetails}
        onQuantityChange={changeQuantity}
        onRemove={removeLine}
        onNoteChange={changeNote}
        onDiscountChange={setDiscountInput}
        onCollectionModeChange={setCollectionMode}
        onPaidChange={setPaidInput}
        onMethodChange={setMethod}
        onMixedChange={changeMixed}
        onPlaceOrder={() => placeOrder()}
      />

      <div className="cashier-compact-checkout space-y-2 rounded-xl border bg-card p-3">
        <div className="flex items-center justify-between gap-2 text-lg font-bold"><span>الإجمالي النهائي</span><span>{money(total,currency)}</span></div>
        <Button aria-controls={orderId} className="min-h-14 w-full text-base" onClick={() => showCompactWorkspace("cart")}><ShoppingBag aria-hidden="true" className="size-5" /> مراجعة الطلب والدفع ({cart.reduce((sum,line) => sum + line.quantity,0)})</Button>
      </div>

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
            <Button variant="outline" onClick={() => setConfiguring(null)}>إلغاء</Button>
            <Button onClick={confirmConfigure} className="w-full sm:w-auto">
              {t.pos.addToOrder}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      </div>
      </fieldset>
    </div>
  );
}
