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
  SubscriptionStatus,
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
    UNPAID: "غير مدفوع",
    PENDING_COLLECTION: "في انتظار التحصيل",
    PARTIAL: "مدفوع جزئيًا",
    PAID: "مدفوع",
    REFUNDED: "مرتجع",
    CANCELLED: "ملغي",
  } satisfies Record<PaymentStatus, string>,

  // POS payment collection + configurable tax/service
  collection: {
    title: "طريقة التحصيل",
    now: "تحصيل الآن",
    pending: "انتظار التحصيل",
    partial: "مدفوع جزئيًا",
    paid: "المدفوع",
    remaining: "المتبقي",
    collectPayment: "تحصيل الدفع",
    collectAmount: "مبلغ التحصيل",
    orderTotal: "إجمالي الطلب",
    collectedSuccess: "تم تحصيل الدفع بنجاح",
    validation: {
      needMode: "من فضلك اختار طريقة التحصيل",
      needMethod: "من فضلك اختار طريقة الدفع",
      amountPositive: "مبلغ الدفع يجب أن يكون أكبر من صفر",
      amountTooBig: "مبلغ الدفع لا يمكن أن يكون أكبر من إجمالي الطلب",
      needShift: "لا يمكن تحصيل الدفع بدون شيفت مفتوح",
    },
  },

  servingPolicy: {
    title: "سياسة الدفع والتقديم",
    hint: "بتحدد إذا كان ينفع الطلب يتسلّم للعميل قبل ما يتدفع. بيتظبط مرة واحدة — الموظف مش بيختاره كل طلب.",
    dineIn: "الصالة",
    takeaway: "التيك أواي",
    allowBefore: "السماح بالتقديم قبل الدفع",
    requireFirst: "الدفع قبل التقديم",
    allowBeforeTakeaway: "السماح بالتسليم قبل الدفع",
    requireFirstTakeaway: "الدفع قبل التسليم",
    branchSection: "إعدادات الفرع",
    useCafeDefault: "استخدام سياسة الكافيه",
    effectiveNow: "المطبّق حاليًا",
    inherited: "موروث من الكافيه",
    overridden: "مخصص لهذا الفرع",
    saved: "تم حفظ سياسة الدفع",
    // Pay-first dead-end: the barista needs a way forward, not a dead button.
    mustCollectFirst: "لازم يتدفع الأول",
    collectNow: "تحصيل الدفع",
    // Close / keep-open decision.
    closePromptTitle: "الترابيزة خلصت",
    closePromptBody: "الحساب مدفوع بالكامل وكل الطلبات اتسلّمت. تقفل الترابيزة؟",
    closeTable: "اقفل الترابيزة",
    keepOpen: "سيبها مفتوحة",
  },
  finance: {
    settingsTitle: "إعدادات الضريبة والسيرفيس",
    taxEnabled: "تفعيل الضريبة",
    taxRate: "نسبة الضريبة",
    serviceEnabled: "تفعيل السيرفيس",
    serviceRate: "نسبة السيرفيس",
    serviceFixed: "قيمة السيرفيس الثابتة",
    serviceType: "نوع السيرفيس",
    percentage: "نسبة",
    fixed: "مبلغ ثابت",
    applyServiceTo: "تطبيق السيرفيس على",
    applyTaxTo: "تطبيق الضريبة على",
    service: "السيرفيس",
    tax: "الضريبة",
    finalTotal: "الإجمالي النهائي",
    save: "حفظ الإعدادات",
    saved: "تم حفظ الإعدادات",
    scope: {
      ALL_ORDERS: "كل الطلبات",
      DINE_IN_ONLY: "الصالة فقط",
      TAKEAWAY_ONLY: "التيك أواي فقط",
      DELIVERY_ONLY: "الدليفري فقط",
    },
  },

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
    blindCountHint: "اعدّ الكاش الفعلي في الدرج وسجّله. الفرق هيظهر بعد التسجيل.",
    actualCash: "الكاش الفعلي",
    actualCashInDrawer: "الكاش الفعلي في الدرج",
    varianceReason: "سبب الفرق (لو فيه فرق)",
    // Phrased as a conditional because the count is blind: the cashier does
    // not know yet whether there IS a difference, so the field cannot be
    // demanded up front without revealing the target it exists to withhold.
    varianceReasonHint: "لو الكاش المعدود مختلف عن المتوقع، لازم تكتب السبب.",
    // T34 — the two channels that never reach the drawer. Each is asked for
    // separately, and explained separately: a rejected card authorisation and
    // a pending wallet transfer are different events with different
    // counterparties, and one shared box would let a sentence about one stand
    // as the explanation for the other.
    settlementHeading: "تسوية الفيزا والمحافظ",
    settlementHint: "اكتب المبلغ اللي المزود سوّاه فعليًا من تقرير التسوية.",
    actualCardSettled: "المبلغ المسوّى من الفيزا",
    actualWalletSettled: "المبلغ المسوّى من المحفظة",
    cardVarianceReason: "سبب فرق الفيزا (لو فيه فرق)",
    walletVarianceReason: "سبب فرق المحفظة (لو فيه فرق)",
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
    openBadge: "شيفت مفتوح",
    closedBadge: "شيفت مغلق",
    latestClosed: "آخر شيفت مغلق",
    closedTodayTotal: "إجمالي الشيفتات المغلقة اليوم",
    noOpenShift: "لا يوجد شيفت مفتوح",
    lockedSuccess: "تم قفل الشيفت بنجاح",
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

  // ── Super Admin (platform owner) panel ──
  handoverConfig: {
    title: "إعدادات تسليم المخزون",
    enabled: "تفعيل عدّ التسليم",
    mode: "نوع العد",
    modeValues: { FULL: "كل الأصناف", SELECTED: "أصناف محددة" },
    ingredients: "الأصناف المختارة",
    ingredientSearch: "ابحث عن صنف…",
    noIngredients: "لا توجد أصناف مطابقة",
    schedule: "جدول العد الدوري",
    scheduleValues: { MANUAL_ONLY: "يدوي فقط", DAILY_LAST_HANDOVER: "يومي عند آخر تسليم", WEEKLY: "أسبوعي" },
    weekday: "يوم الأسبوع",
    weekdays: { sunday: "الأحد", monday: "الاثنين", tuesday: "الثلاثاء", wednesday: "الأربعاء", thursday: "الخميس", friday: "الجمعة", saturday: "السبت" },
    usingCafeDefault: "يستخدم إعداد الكافيه الافتراضي",
    save: "حفظ إعدادات التسليم",
    saving: "جارٍ الحفظ…",
    loading: "جارٍ تحميل إعدادات التسليم…",
    loadFailure: "تعذر تحميل إعدادات التسليم",
    saveSuccess: "تم حفظ إعدادات التسليم",
    saveFailure: "تعذر حفظ إعدادات التسليم",
    selectedEmpty: "اختر صنفًا واحدًا على الأقل عند تفعيل الأصناف المحددة",
    chooseModeFirst: "اختر نوع عدّ مدعومًا أولًا قبل التفعيل",
    errors: {
      CYCLE_POLICY_UNSUPPORTED: "سياسة العد الدوري غير مدعومة لإعدادات التسليم",
      SELECTED_WITH_NO_ITEMS: "لا توجد أصناف نشطة محددة لعدّ التسليم",
      WEEKLY_WITHOUT_WEEKDAY: "الجدول الأسبوعي يحتاج يومًا محددًا",
    },
  },

  admin: {
    brand: "إدارة المنصة",
    brandSub: "لوحة تحكم المالك",
    nav: {
      dashboard: "لوحة المنصة",
      cafes: "الكافيهات",
      reports: "التقارير",
      users: "المستخدمين",
      subscriptions: "الاشتراكات",
      payments: "المدفوعات",
      audit: "سجل الحركات",
      settings: "الإعدادات",
    },
    subStatus: {
      TRIAL: "تجريبي",
      ACTIVE: "نشط",
      EXPIRED: "منتهي",
      SUSPENDED: "موقوف",
    } satisfies Record<SubscriptionStatus, string>,
    cafeStatus: {
      active: "نشط",
      suspended: "موقوف",
    },
    stats: {
      totalCafes: "إجمالي الكافيهات",
      activeCafes: "الكافيهات النشطة",
      suspendedCafes: "الكافيهات الموقوفة",
      totalBranches: "إجمالي الفروع",
      totalUsers: "إجمالي المستخدمين",
      totalOrders: "إجمالي الطلبات",
      todaySales: "مبيعات اليوم للمنصة",
      monthSales: "مبيعات الشهر للمنصة",
      openShifts: "الشيفتات المفتوحة",
      todayOrders: "طلبات اليوم",
      avgOrderValue: "متوسط قيمة الطلب",
      topCafeToday: "أفضل كافيه اليوم",
      topCafeMonth: "الأكثر مبيعًا هذا الشهر",
    },
    charts: {
      sales7: "مبيعات آخر ٧ أيام (كل المنصة)",
      orders7: "الطلبات آخر ٧ أيام",
      topCafes: "أفضل ٥ كافيهات حسب المبيعات",
      byPayment: "توزيع المبيعات حسب طريقة الدفع",
      cafeGrowth: "نمو عدد الكافيهات",
    },
    actions: {
      view: "عرض",
      edit: "تعديل",
      suspend: "إيقاف",
      activate: "تفعيل",
      resetPassword: "تغيير كلمة المرور",
      manage: "إدارة",
      exportCsv: "تصدير CSV",
      backToCafes: "الرجوع للكافيهات",
    },
    passwordReset: {
      title: "تغيير كلمة المرور",
      newPassword: "كلمة المرور الجديدة",
      confirmPassword: "تأكيد كلمة المرور",
      required: "كلمة المرور مطلوبة",
      tooShort: "كلمة المرور يجب أن تكون 8 أحرف على الأقل",
      mismatch: "تأكيد كلمة المرور غير مطابق",
      success: "تم تغيير كلمة المرور بنجاح",
    },
    empty: "لا توجد بيانات لعرضها",
    loading: "جاري تحميل بيانات المنصة…",
    suspendedCafeLogin: "تم إيقاف حساب الكافيه، برجاء التواصل مع إدارة المنصة",
  },

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
    // Date-range filter labels
    range: {
      today: "النهارده",
      d7: "آخر ٧ أيام",
      d30: "آخر ٣٠ يوم",
      month: "هذا الشهر",
      custom: "مخصص",
    },
    refresh: "تحديث",
    // Expanded KPI labels
    completedOrders: "الطلبات المكتملة",
    cancelledOrders: "الطلبات الملغية",
    openShiftsLabel: "الشيفتات المفتوحة",
    closedShiftsToday: "الشيفتات المغلقة اليوم",
    netCash: "صافي الكاش",
    uncollected: "المبيعات غير المحصلة",
    pendingCollection: "في انتظار التحصيل",
    taxTotal: "إجمالي الضريبة",
    serviceTotal: "إجمالي السيرفيس",
    stockAlerts: "تنبيهات المخزون",
    vsPrev: "مقارنة بالفترة السابقة",
    insights: "لمحات سريعة",
    bestBranch: "أفضل فرع",
    bestProduct: "الأكثر مبيعًا",
    worstProduct: "الأقل مبيعًا",
    bestCashier: "أفضل كاشير",
    ordersBySource: "توزيع مصدر الطلبات",
    pendingOrders: "طلبات في انتظار التحصيل",
    recentShifts: "آخر الشيفتات",
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
