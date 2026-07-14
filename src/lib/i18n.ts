// Arabic (Egyptian) UI labels — the single place for shared wording.
// Pages import from here for anything used in more than one spot;
// one-off strings live inline in their page.

import type {
  OrderSource,
  OrderStatus,
  OrderType,
  PaymentMethod,
  PaymentStatus,
  ShiftStatus,
  Role,
} from "@prisma/client";

export const t = {
  appName: "كافيه أوبس",

  nav: {
    dashboard: "لوحة التحكم",
    pos: "الكاشير",
    currentShift: "الشيفت الحالي",
    shiftReports: "تقارير الشيفتات",
    orders: "الطلبات",
    approvals: "طلبات المنيو",
    kitchen: "شاشة البار",
    menu: "المنيو",
    branches: "الفروع",
    staff: "الموظفين",
    inventory: "المخزون",
    reports: "تقرير اليوم",
    audit: "سجل الحركات",
    cafes: "الكافيهات",
  },

  common: {
    signOut: "تسجيل الخروج",
    loading: "جاري التحميل…",
    save: "حفظ",
    add: "إضافة",
    edit: "تعديل",
    delete: "حذف",
    cancel: "إلغاء",
    remove: "حذف",
    active: "مفعّل",
    hidden: "مخفي",
    disabled: "موقوف",
    name: "الاسم",
    email: "الإيميل",
    password: "الباسورد",
    phone: "التليفون",
    address: "العنوان",
    status: "الحالة",
    allBranches: "كل الفروع",
    branch: "الفرع",
    search: "بحث",
    none: "—",
  },

  pos: {
    searchProducts: "دوّر على منتج…",
    currentOrder: "الطلب الحالي",
    items: "صنف",
    cartEmpty: "الطلب فاضي",
    cartEmptyHint: "دوس على أي منتج عشان تبدأ الطلب.",
    addToOrder: "ضيف للطلب",
    variant: "الحجم / النوع",
    addOns: "الإضافات",
    itemNote: "ملاحظة على الصنف",
    itemNotePlaceholder: "مثلاً: من غير سكر، سخن زيادة، تلج أقل",
    note: "ملاحظة",
    each: "للواحد",
    subtotal: "الإجمالي قبل الخصم",
    discount: "الخصم",
    discountApplied: "خصم مطبّق",
    tax: "الضريبة",
    total: "الإجمالي",
    placeOrder: "تسجيل الطلب",
    charge: "تحصيل",
    placing: "جاري تسجيل الطلب…",
    payNow: "تحصيل الفلوس دلوقتي (شيل العلامة لو هيدفع بعدين)",
    customerName: "اسم العميل",
    customerNameOptional: "اسم العميل (اختياري)",
    customerNameRequired: "اسم العميل *",
    tableNumber: "رقم الترابيزة *",
    deliveryAddress: "عنوان التوصيل",
    unavailable: "مش متاح",
    plusOptions: "+ إضافات",
    noProducts: "مفيش منتجات بالاسم ده — جرّب تصنيف تاني أو غيّر البحث.",
    validation: {
      emptyCart: "ضيف صنف واحد على الأقل",
      noBranch: "اختار الفرع الأول",
      needTable: "رقم الترابيزة مطلوب لطلبات الصالة",
      needCustomer: "اسم العميل مطلوب للدليفري",
    },
  },

  orderTypes: {
    DINE_IN: "صالة",
    TAKEAWAY: "تيك أواي",
    DELIVERY: "دليفري",
  } satisfies Record<OrderType, string>,

  orderStatus: {
    PENDING_WAITER_APPROVAL: "في انتظار موافقة الويتر",
    CONFIRMED: "مؤكد",
    PREPARING: "جاري التحضير",
    READY: "جاهز",
    SERVED: "تم التسليم",
    CANCELLED: "ملغي",
    REJECTED: "مرفوض",
  } satisfies Record<OrderStatus, string>,

  orderSource: {
    QR_MENU: "منيو العميل",
    WAITER: "الويتر",
    CASHIER_POS: "الكاشير",
  } satisfies Record<OrderSource, string>,

  staffInfo: {
    section: "بيانات الموظف",
    sourceLabel: "مصدر الطلب",
    createdBy: "تم تسجيل الطلب بواسطة",
    handledBy: "تم تسجيله بواسطة",
    approvedBy: "تمت الموافقة بواسطة",
    approvedAt: "وقت الموافقة",
    waiter: "الويتر",
    cashier: "الكاشير",
    waiterName: "اسم الويتر",
    allStaff: "كل الموظفين",
  },

  paymentMethods: {
    CASH: "كاش",
    CARD: "فيزا",
    WALLET: "محفظة",
    MIXED: "مختلط",
  } satisfies Record<PaymentMethod, string>,

  paymentStatus: {
    PAID: "مدفوع",
    PARTIAL: "مدفوع جزئي",
    REFUNDED: "مرتجع",
    CANCELLED: "ملغي",
  } satisfies Record<PaymentStatus, string>,

  shiftStatus: {
    OPEN: "مفتوح",
    CLOSED: "مقفول",
  } satisfies Record<ShiftStatus, string>,

  shifts: {
    title: "الشيفتات",
    current: "الشيفت الحالي",
    reports: "تقارير الشيفتات",
    open: "فتح شيفت",
    openConfirm: "فتح الشيفت",
    close: "قفل الشيفت",
    closeConfirm: "تأكيد قفل الشيفت",
    shiftNumber: "رقم الشيفت",
    cashier: "الكاشير",
    branch: "الفرع",
    openedAt: "بداية الشيفت",
    closedAt: "نهاية الشيفت",
    openingCash: "رصيد بداية الشيفت",
    expectedCash: "الكاش المتوقع",
    expectedCashInDrawer: "الكاش المتوقع في الدرج",
    actualCash: "الكاش الفعلي",
    actualCashInDrawer: "الكاش الفعلي في الدرج",
    difference: "الفرق",
    totalSales: "إجمالي المبيعات",
    cashSales: "مبيعات الكاش",
    cardSales: "مبيعات الفيزا",
    walletSales: "مبيعات المحافظ",
    refunds: "إجمالي المرتجعات",
    discounts: "إجمالي الخصومات",
    orderCount: "عدد الطلبات",
    status: "الحالة",
    notes: "ملاحظات القفلة",
    shiftOpen: "الشيفت مفتوح",
    mustOpen: "يجب فتح شيفت قبل تسجيل الطلبات",
    openedSuccess: "تم فتح الشيفت بنجاح",
    alreadyOpen: "لديك شيفت مفتوح بالفعل",
    closedSuccess: "تم قفل الشيفت",
    matched: "الكاش مطابق",
    shortage: "يوجد عجز بقيمة",
    surplus: "يوجد زيادة بقيمة",
    noShift: "لا يمكن تسجيل الطلب بدون شيفت مفتوح",
    ordersInShift: "الطلبات داخل الشيفت",
    payments: "المدفوعات",
    auditTrail: "سجل الحركات",
    details: "بيانات الشيفت",
  },

  roles: {
    SUPER_ADMIN: "سوبر أدمن",
    CAFE_OWNER: "صاحب الكافيه",
    BRANCH_MANAGER: "مدير فرع",
    WAITER: "ويتر",
    CASHIER: "كاشير",
    BARISTA: "بارستا",
    INVENTORY_MANAGER: "مسؤول مخزون",
  } satisfies Record<Role, string>,

  dashboard: {
    title: "لوحة التحكم",
    welcome: "أهلاً بيك،",
    todayRevenue: "مبيعات النهارده",
    todayOrders: "طلبات النهارده",
    avgOrderValue: "متوسط قيمة الطلب",
    openOrders: "طلبات مفتوحة",
    weekRevenue: "المبيعات — آخر ٧ أيام (الطلبات المكتملة)",
    topProducts: "الأكثر مبيعاً — آخر ٧ أيام",
    noSales: "مفيش مبيعات لسه.",
    product: "المنتج",
    quantity: "الكمية",
    revenue: "المبيعات",
    ordersCount: "طلب",
  },
} as const;

// ── Formatters ─────────────────────────────────────────────────

// Prices like "95 ج.م" — Western digits for readability, Arabic
// currency mark for EGP; other currencies fall back to Intl.
export function formatMoney(value: number | string, currency = "EGP"): string {
  const n = Number(value);
  if (currency === "EGP") {
    const formatted = new Intl.NumberFormat("en-EG", {
      minimumFractionDigits: n % 1 === 0 ? 0 : 2,
      maximumFractionDigits: 2,
    }).format(n);
    return `${formatted} ج.م`;
  }
  return new Intl.NumberFormat("en", { style: "currency", currency }).format(n);
}

// Arabic date/time with readable Western digits.
export function formatDate(date: string | Date): string {
  return new Date(date).toLocaleDateString("ar-EG-u-nu-latn", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

export function formatDateTime(date: string | Date): string {
  return new Date(date).toLocaleString("ar-EG-u-nu-latn", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatTime(date: string | Date): string {
  return new Date(date).toLocaleTimeString("ar-EG-u-nu-latn", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatWeekday(date: string | Date): string {
  return new Date(date).toLocaleDateString("ar-EG-u-nu-latn", {
    weekday: "short",
  });
}
