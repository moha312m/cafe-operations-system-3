// src/app/prototypes/_data/mock-data.ts
// Pure in-memory synthetic mock data for the 4 visual prototype screens.
// ZERO Prisma imports, ZERO backend API calls, ZERO database side-effects.

// ==========================================
// 1. POS Types & Synthetic Catalog
// ==========================================

export type POSCategory = {
  id: string;
  nameAr: string;
  nameEn: string;
  icon: string;
};

export type POSVariant = {
  id: string;
  nameAr: string;
  priceDelta: number; // Price difference from base price
};

export type POSModifierOption = {
  id: string;
  nameAr: string;
  priceDelta: number;
  isDefault?: boolean;
};

export type POSModifierGroup = {
  id: string;
  nameAr: string;
  required: boolean;
  options: POSModifierOption[];
};

export type POSProduct = {
  id: string;
  nameAr: string;
  nameEn: string;
  descriptionAr: string;
  categoryId: string;
  basePrice: number;
  imageUrl?: string;
  badgeAr?: string;
  variants?: POSVariant[];
  modifierGroups?: POSModifierGroup[];
  isAvailable: boolean;
};

export type SelectedModifier = {
  groupId: string;
  groupNameAr: string;
  optionId: string;
  optionNameAr: string;
  priceDelta: number;
};

export type POSCartItem = {
  id: string; // unique line ID
  productId: string;
  productNameAr: string;
  variantId?: string;
  variantNameAr?: string;
  selectedModifiers: SelectedModifier[];
  unitPrice: number;
  quantity: number;
  lineTotal: number;
  notes?: string;
};

export type OrderType = "DINE_IN" | "TAKEAWAY" | "DELIVERY";
export type PaymentMethod = "CASH" | "CARD" | "WALLET";

export const POS_CATEGORIES: readonly POSCategory[] = [
  { id: "specialty-coffee", nameAr: "قهوة مختصة", nameEn: "Specialty Coffee", icon: "☕" },
  { id: "cold-drinks", nameAr: "مشروبات باردة", nameEn: "Cold Drinks", icon: "🥤" },
  { id: "bakery-desserts", nameAr: "مخبوزات وحلويات", nameEn: "Bakery & Desserts", icon: "🥐" },
  { id: "coffee-beans", nameAr: "حبوب بن", nameEn: "Whole Beans", icon: "🫘" },
];

export const POS_PRODUCTS: readonly POSProduct[] = [
  {
    id: "p1",
    nameAr: "إسبريسو دبل",
    nameEn: "Double Espresso",
    descriptionAr: "شوت مزدوج مركز بنكهات غنية وتحميص طازج",
    categoryId: "specialty-coffee",
    basePrice: 65,
    badgeAr: "الأكثر طلباً",
    variants: [
      { id: "single", nameAr: "سنجل", priceDelta: -15 },
      { id: "double", nameAr: "دبل", priceDelta: 0 },
    ],
    modifierGroups: [
      {
        id: "beans",
        nameAr: "نوع حبوب البن",
        required: true,
        options: [
          { id: "ethiopia", nameAr: "إثيوبي غوجي (فاكهي)", priceDelta: 0, isDefault: true },
          { id: "colombia", nameAr: "كولومبي هويلا (شوكولاتة)", priceDelta: 10 },
        ],
      },
    ],
    isAvailable: true,
  },
  {
    id: "p2",
    nameAr: "فلات وايت",
    nameEn: "Flat White",
    descriptionAr: "شوت مزدوج مع حليب مبخر برغوة مخملية ناعمة 6oz",
    categoryId: "specialty-coffee",
    basePrice: 85,
    badgeAr: "مميز",
    modifierGroups: [
      {
        id: "milk",
        nameAr: "نوع الحليب",
        required: true,
        options: [
          { id: "regular", nameAr: "كامل الدسم", priceDelta: 0, isDefault: true },
          { id: "skimmed", nameAr: "خالي الدسم", priceDelta: 0 },
          { id: "oat", nameAr: "حليب شوفان Oatly", priceDelta: 25 },
          { id: "almond", nameAr: "حليب لوز", priceDelta: 25 },
        ],
      },
      {
        id: "sugar",
        nameAr: "درجة السكر",
        required: false,
        options: [
          { id: "zero", nameAr: "بدون سكر", priceDelta: 0, isDefault: true },
          { id: "normal", nameAr: "مظبوط (1 ملعقة)", priceDelta: 0 },
          { id: "extra", nameAr: "زيادة (2 ملعقة)", priceDelta: 0 },
          { id: "stevia", nameAr: "سكر ستيفيا دايت", priceDelta: 5 },
        ],
      },
    ],
    isAvailable: true,
  },
  {
    id: "p3",
    nameAr: "كورتادو",
    nameEn: "Cortado",
    descriptionAr: "نسب متساوية من الإسبريسو المركز والحليب المبخر الساخن",
    categoryId: "specialty-coffee",
    basePrice: 75,
    modifierGroups: [
      {
        id: "milk",
        nameAr: "نوع الحليب",
        required: true,
        options: [
          { id: "regular", nameAr: "كامل الدسم", priceDelta: 0, isDefault: true },
          { id: "oat", nameAr: "حليب شوفان Oatly", priceDelta: 25 },
        ],
      },
    ],
    isAvailable: true,
  },
  {
    id: "p4",
    nameAr: "كابتشينو كلاسيك",
    nameEn: "Classic Cappuccino",
    descriptionAr: "توازن مثالي بين الإسبريسو والحليب والرغوة الغنية الكثيفة",
    categoryId: "specialty-coffee",
    basePrice: 85,
    variants: [
      { id: "regular", nameAr: "عادي 8oz", priceDelta: 0 },
      { id: "large", nameAr: "كبير 12oz", priceDelta: 20 },
    ],
    modifierGroups: [
      {
        id: "milk",
        nameAr: "نوع الحليب",
        required: true,
        options: [
          { id: "regular", nameAr: "كامل الدسم", priceDelta: 0, isDefault: true },
          { id: "skimmed", nameAr: "خالي الدسم", priceDelta: 0 },
          { id: "oat", nameAr: "حليب شوفان Oatly", priceDelta: 25 },
        ],
      },
    ],
    isAvailable: true,
  },
  {
    id: "p5",
    nameAr: "لاتيه كلاسيك",
    nameEn: "Classic Latte",
    descriptionAr: "إسبريسو دبل مع حليب مبخر دافئ ورسمة باريستا متقنة",
    categoryId: "specialty-coffee",
    basePrice: 90,
    variants: [
      { id: "regular", nameAr: "عادي 8oz", priceDelta: 0 },
      { id: "large", nameAr: "كبير 12oz", priceDelta: 20 },
    ],
    modifierGroups: [
      {
        id: "syrup",
        nameAr: "إضافة سيرب نكهة",
        required: false,
        options: [
          { id: "vanilla", nameAr: "فانيليا مدغشقر", priceDelta: 20 },
          { id: "caramel", nameAr: "كراميل مملح", priceDelta: 20 },
          { id: "hazelnut", nameAr: "بندق محمص", priceDelta: 20 },
        ],
      },
    ],
    isAvailable: true,
  },
  {
    id: "p6",
    nameAr: "في 60 كولومبي هويلا",
    nameEn: "V60 Colombia Huila",
    descriptionAr: "تقطير يدوي مختص بإيحاءات التفاح الأحمر والكرز وحلاوة السكر البني",
    categoryId: "specialty-coffee",
    basePrice: 110,
    badgeAr: "مختص",
    variants: [
      { id: "hot", nameAr: "ساخن", priceDelta: 0 },
      { id: "iced", nameAr: "مثلج (آيس V60)", priceDelta: 10 },
    ],
    isAvailable: true,
  },
  {
    id: "p7",
    nameAr: "كيمكس إثيوبي يرغاتشيف",
    nameEn: "Chemex Ethiopia Yirgacheffe",
    descriptionAr: "تحضير مصفى نظيف القوام بإيحاءات الياسمين والبرغموت والخوخ",
    categoryId: "specialty-coffee",
    basePrice: 125,
    isAvailable: true,
  },
  {
    id: "p8",
    nameAr: "آيس سبانش لاتيه",
    nameEn: "Iced Spanish Latte",
    descriptionAr: "المشروب البارد المفضل بمزيج الإسبريسو والحليب وصوص الحليب المكثف",
    categoryId: "cold-drinks",
    basePrice: 105,
    badgeAr: "الأكثر مبيعاً",
    variants: [
      { id: "regular", nameAr: "عادي 12oz", priceDelta: 0 },
      { id: "large", nameAr: "كبير 16oz", priceDelta: 20 },
    ],
    modifierGroups: [
      {
        id: "milk",
        nameAr: "نوع الحليب",
        required: true,
        options: [
          { id: "regular", nameAr: "كامل الدسم", priceDelta: 0, isDefault: true },
          { id: "oat", nameAr: "شوفان باريستا Oatly", priceDelta: 25 },
        ],
      },
    ],
    isAvailable: true,
  },
  {
    id: "p9",
    nameAr: "كولد برو إثيوبي",
    nameEn: "Ethiopian Cold Brew",
    descriptionAr: "قهوة مقطرة ببطء على البارد لمدة 16 ساعة متواصلة لنكهات منعشة",
    categoryId: "cold-drinks",
    basePrice: 95,
    isAvailable: true,
  },
  {
    id: "p10",
    nameAr: "ماتشا لاتيه مثلج",
    nameEn: "Iced Ceremonial Matcha",
    descriptionAr: "ماتشا يابانية احتفالية فاخرة مع حليب بارد وثلج نقي",
    categoryId: "cold-drinks",
    basePrice: 115,
    modifierGroups: [
      {
        id: "milk",
        nameAr: "نوع الحليب",
        required: true,
        options: [
          { id: "regular", nameAr: "كامل الدسم", priceDelta: 0, isDefault: true },
          { id: "oat", nameAr: "حليب شوفان Oatly", priceDelta: 25 },
          { id: "coconut", nameAr: "حليب جوز هند", priceDelta: 25 },
        ],
      },
    ],
    isAvailable: true,
  },
  {
    id: "p11",
    nameAr: "موهيتو باشن فروت ونعناع",
    nameEn: "Passion Fruit Mojito",
    descriptionAr: "صودا فوارة منعشة مع بيوريه الباشن فروت الطبيعي وأوراق النعناع",
    categoryId: "cold-drinks",
    basePrice: 75,
    isAvailable: true,
  },
  {
    id: "p12",
    nameAr: "كرواسون لوز فرنسي",
    nameEn: "Almond Croissant",
    descriptionAr: "مورق بالزبدة الفرنسية الفاخرة ومحشو ومغطى بشرائح اللوز المقرمشة",
    categoryId: "bakery-desserts",
    basePrice: 75,
    badgeAr: "طازج يومياً",
    isAvailable: true,
  },
  {
    id: "p13",
    nameAr: "تشيز كيك سان سيباستيان",
    nameEn: "San Sebastian Cheesecake",
    descriptionAr: "كيكة الجبن الباسكية المحروقة بقوام كريمي ذائب في الفم",
    categoryId: "bakery-desserts",
    basePrice: 110,
    modifierGroups: [
      {
        id: "sauce",
        nameAr: "الصوص الإضافي",
        required: false,
        options: [
          { id: "chocolate", nameAr: "شوكولاتة بلجيكية دافئة", priceDelta: 20 },
          { id: "lotus", nameAr: "كراميل لوتس مقرمش", priceDelta: 20 },
        ],
      },
    ],
    isAvailable: true,
  },
  {
    id: "p14",
    nameAr: "كوكيز شوكولاتة بلجيكية",
    nameEn: "Triple Chocolate Cookie",
    descriptionAr: "كوكي دافئة محشوة بقطع الشوكولاتة البلجيكية الغنية",
    categoryId: "bakery-desserts",
    basePrice: 55,
    isAvailable: true,
  },
  {
    id: "p15",
    nameAr: "كيس بن إثيوبي غوجي 250جم",
    nameEn: "Ethiopia Guji Whole Bean 250g",
    descriptionAr: "حبوب بن أرابيكا مختصة مجففة لاهوائياً، إيحاءات توت أسود وخوخ وعسل",
    categoryId: "coffee-beans",
    basePrice: 340,
    variants: [
      { id: "whole", nameAr: "حبوب كاملة (بدون طحن)", priceDelta: 0 },
      { id: "filter", nameAr: "مطحون فلتر (V60 / كيمكس)", priceDelta: 0 },
      { id: "espresso", nameAr: "مطحون إسبريسو ناعم", priceDelta: 0 },
    ],
    isAvailable: true,
  },
  {
    id: "p16",
    nameAr: "كيس بن كولومبيا سوبريمو 250جم",
    nameEn: "Colombia Supremo 250g",
    descriptionAr: "معالجة مغسولة، قوام شوكولاتة متوازن مع حمضية خفيفة وحلاوة كراميل",
    categoryId: "coffee-beans",
    basePrice: 290,
    variants: [
      { id: "whole", nameAr: "حبوب كاملة (بدون طحن)", priceDelta: 0 },
      { id: "filter", nameAr: "مطحون فلتر", priceDelta: 0 },
      { id: "espresso", nameAr: "مطحون إسبريسو", priceDelta: 0 },
    ],
    isAvailable: true,
  },
];

// Initial mock cart lines for demonstration
export const INITIAL_MOCK_CART: readonly POSCartItem[] = [
  {
    id: "cart-line-1",
    productId: "p2",
    productNameAr: "فلات وايت",
    selectedModifiers: [
      { groupId: "milk", groupNameAr: "نوع الحليب", optionId: "regular", optionNameAr: "كامل الدسم", priceDelta: 0 },
    ],
    unitPrice: 85,
    quantity: 2,
    lineTotal: 170,
  },
  {
    id: "cart-line-2",
    productId: "p8",
    productNameAr: "آيس سبانش لاتيه",
    variantId: "regular",
    variantNameAr: "عادي 12oz",
    selectedModifiers: [
      { groupId: "milk", groupNameAr: "نوع الحليب", optionId: "oat", optionNameAr: "شوفان باريستا Oatly", priceDelta: 25 },
    ],
    unitPrice: 130,
    quantity: 1,
    lineTotal: 130,
  },
  {
    id: "cart-line-3",
    productId: "p12",
    productNameAr: "كرواسون لوز فرنسي",
    selectedModifiers: [],
    unitPrice: 75,
    quantity: 1,
    lineTotal: 75,
  },
];

// ==========================================
// 2. Expenses Types & Synthetic Dataset
// ==========================================

export type ExpenseCategory =
  | "COFFEE_BEANS"
  | "DAIRY_MILK"
  | "MAINTENANCE"
  | "PACKAGING"
  | "UTILITIES"
  | "CLEANING"
  | "TECH_SUBSCRIPTION"
  | "FRESH_PRODUCE";

export type ExpenseStatus = "APPROVED" | "PAID" | "PENDING";

export type ExpenseItem = {
  id: string;
  code: string;
  date: string;
  category: ExpenseCategory;
  categoryNameAr: string;
  descriptionAr: string;
  amount: number;
  paymentMethodAr: string;
  vendorName: string;
  branchName: string;
  status: ExpenseStatus;
  receiptThumbnailUrl?: string;
  notes?: string;
};

export const MOCK_EXPENSES: readonly ExpenseItem[] = [
  {
    id: "exp-01",
    code: "EXP-2026-089",
    date: "2026-11-08",
    category: "COFFEE_BEANS",
    categoryNameAr: "خامات ومستلزمات بن",
    descriptionAr: "توريد 20 كجم بن كولومبيا وبرازيل تحميص طازج",
    amount: 18500,
    paymentMethodAr: "عهدة نقدية للفرع",
    vendorName: "شركة البن الأخضر للتجارة",
    branchName: "فرع التجمع الخامس",
    status: "APPROVED",
    notes: "تم فحص تاريخ التحميص وجودة الأكياس وصمامات التهوية",
  },
  {
    id: "exp-02",
    code: "EXP-2026-088",
    date: "2026-11-08",
    category: "DAIRY_MILK",
    categoryNameAr: "ألبان ومنتجات طازجة",
    descriptionAr: "40 كرتونة حليب كامل الدسم المراعي × 12 لتر",
    amount: 17280,
    paymentMethodAr: "تحويل بنكي / إنستاباي",
    vendorName: "موزعي ألبان المراعي المعتمدين",
    branchName: "فرع وسط البلد",
    status: "PAID",
    notes: "فحص درجة حرارة التبريد عند الاستلام وكانت 4 درجات مئوية",
  },
  {
    id: "exp-03",
    code: "EXP-2026-087",
    date: "2026-11-07",
    category: "MAINTENANCE",
    categoryNameAr: "صيانة ومعدات",
    descriptionAr: "صيانة وقائية نصف سنوية لماكينة La Marzocco Linea PB",
    amount: 6500,
    paymentMethodAr: "بطاقة بنكية للشركة",
    vendorName: "شركة تكنيكال كير لخدمات القهوة",
    branchName: "فرع الشيخ زايد",
    status: "APPROVED",
    notes: "تغيير جوانات مجموعات الاستخلاص وشاشات الشاور سكرين",
  },
  {
    id: "exp-04",
    code: "EXP-2026-086",
    date: "2026-11-06",
    category: "PACKAGING",
    categoryNameAr: "أدوات وتغليف ومطبوعات",
    descriptionAr: "10,000 كوب دبل وول بشعار الكافيه وشلمونات قابلة للتحلل",
    amount: 12800,
    paymentMethodAr: "فاتورة آجلة (للاعتماد)",
    vendorName: "مطابع الأهرام للتغليف الحديث",
    branchName: "كافيه الإدارة (توزيع فروع)",
    status: "PENDING",
    notes: "بانتظار موافقة المالك لصرف دفعة التوريد",
  },
  {
    id: "exp-05",
    code: "EXP-2026-085",
    date: "2026-11-05",
    category: "UTILITIES",
    categoryNameAr: "مرافق وفواتير كهرباء",
    descriptionAr: "فاتورة استهلاك الكهرباء لشهر أكتوبر 2026",
    amount: 14350,
    paymentMethodAr: "سداد إلكتروني فوري",
    vendorName: "شركة جنوب القاهرة لتوزيع الكهرباء",
    branchName: "فرع وسط البلد",
    status: "PAID",
  },
  {
    id: "exp-06",
    code: "EXP-2026-084",
    date: "2026-11-05",
    category: "CLEANING",
    categoryNameAr: "نظافة وتطهير",
    descriptionAr: "معقمات ومساحيق غسيل ماكينة القهوة Cafiza ومناشف مايكروفايبر",
    amount: 4200,
    paymentMethodAr: "عهدة نقدية للفرع",
    vendorName: "الشركة المتحدة للتوريدات الكيماوية",
    branchName: "فرع التجمع الخامس",
    status: "PAID",
  },
  {
    id: "exp-07",
    code: "EXP-2026-083",
    date: "2026-11-04",
    category: "DAIRY_MILK",
    categoryNameAr: "بدائل حليب ونباتي",
    descriptionAr: "15 كرتونة حليب شوفان باريستا إديشن Oatly",
    amount: 16500,
    paymentMethodAr: "فاتورة آجلة (للاعتماد)",
    vendorName: "الوكيل الحصري للأغذية والمستوردات",
    branchName: "فرع الشيخ زايد",
    status: "PENDING",
  },
  {
    id: "exp-08",
    code: "EXP-2026-082",
    date: "2026-11-03",
    category: "TECH_SUBSCRIPTION",
    categoryNameAr: "اشتراكات واتصالات",
    descriptionAr: "تجديد اشتراك باقة الإنترنت فايبر فائق السرعة للفرع",
    amount: 1850,
    paymentMethodAr: "بطاقة الخزينة",
    vendorName: "الشركة المصرية للاتصالات WE",
    branchName: "فرع وسط البلد",
    status: "PAID",
  },
  {
    id: "exp-09",
    code: "EXP-2026-081",
    date: "2026-11-02",
    category: "FRESH_PRODUCE",
    categoryNameAr: "فواكه وخامات موسمية",
    descriptionAr: "باشن فروت، ليمون طازج، وأوراق نعناع للموهيتو والمشروبات الباردة",
    amount: 3450,
    paymentMethodAr: "نقدي",
    vendorName: "أسواق العبور المركزية",
    branchName: "فرع التجمع الخامس",
    status: "PAID",
  },
  {
    id: "exp-10",
    code: "EXP-2026-080",
    date: "2026-11-01",
    category: "MAINTENANCE",
    categoryNameAr: "فلاتر ومحطات تنقية",
    descriptionAr: "صيانة محطة تنقية المياه وتغيير شمعات التناضح العكسي RO",
    amount: 5100,
    paymentMethodAr: "شيك مصرفي",
    vendorName: "شركة أكوا تك لتنقية مياه المقاهي",
    branchName: "فرع الشيخ زايد",
    status: "APPROVED",
  },
];

// ==========================================
// 3. Dashboard Types & Synthetic Cockpit Data
// ==========================================

export type DashboardPeriod = "today" | "week" | "month";

export type ActionInboxItem = {
  id: string;
  type: "SHIFT_CLOSE" | "EXPENSE_APPROVAL" | "OVERDUE_TASK" | "LOW_STOCK";
  titleAr: string;
  descriptionAr: string;
  branchName: string;
  timeAgoAr: string;
  severity: "URGENT" | "HIGH" | "MEDIUM";
  actionLabelAr: string;
  secondaryActionLabelAr?: string;
};

export type DashboardData = {
  period: DashboardPeriod;
  kpis: {
    netSales: number;
    netSalesTrend: string;
    collections: number;
    collectionsRatio: string;
    expenses: number;
    expensesRatio: string;
    openShifts: number;
    activeBranches: number;
  };
  channelBreakdown: {
    channel: "DINE_IN" | "TAKEAWAY" | "DELIVERY";
    channelNameAr: string;
    percentage: number;
    amount: number;
  }[];
  topProducts: {
    nameAr: string;
    ordersCount: number;
    revenue: number;
  }[];
  branchPerformance: {
    branchName: string;
    revenue: number;
    percentage: number;
  }[];
  actionInbox: ActionInboxItem[];
};

export const MOCK_DASHBOARD_PERIODS: Record<DashboardPeriod, DashboardData> = {
  today: {
    period: "today",
    kpis: {
      netSales: 24650,
      netSalesTrend: "+8.5% مقارنة بأمس",
      collections: 23800,
      collectionsRatio: "96.5% محصل",
      expenses: 4850,
      expensesRatio: "19.6% من المبيعات",
      openShifts: 2,
      activeBranches: 3,
    },
    channelBreakdown: [
      { channel: "DINE_IN", channelNameAr: "صالات", percentage: 54, amount: 13311 },
      { channel: "TAKEAWAY", channelNameAr: "سفري واستلام", percentage: 34, amount: 8381 },
      { channel: "DELIVERY", channelNameAr: "توصيل وتطبيقات", percentage: 12, amount: 2958 },
    ],
    topProducts: [
      { nameAr: "فلات وايت", ordersCount: 92, revenue: 7820 },
      { nameAr: "آيس سبانش لاتيه", ordersCount: 64, revenue: 6720 },
      { nameAr: "في 60 كولومبي", ordersCount: 45, revenue: 4950 },
      { nameAr: "كرواسون لوز فرنسي", ordersCount: 38, revenue: 2850 },
      { nameAr: "كولد برو إثيوبي", ordersCount: 24, revenue: 2280 },
    ],
    branchPerformance: [
      { branchName: "فرع التجمع الخامس", revenue: 10850, percentage: 44 },
      { branchName: "فرع وسط البلد", revenue: 8400, percentage: 34 },
      { branchName: "فرع الشيخ زايد", revenue: 5400, percentage: 22 },
    ],
    actionInbox: [
      {
        id: "act-1",
        type: "SHIFT_CLOSE",
        titleAr: "اعتماد إغلاق وردية - فرع التجمع الخامس",
        descriptionAr: "الوردية #142 (الكاشير كريم فؤاد) - يوجد فائض بالدرج +45 ج.م بمذكرة توضيحية",
        branchName: "فرع التجمع الخامس",
        timeAgoAr: "منذ 25 دقيقة",
        severity: "URGENT",
        actionLabelAr: "اعتماد الإغلاق",
        secondaryActionLabelAr: "فحص التفاصيل",
      },
      {
        id: "act-2",
        type: "EXPENSE_APPROVAL",
        titleAr: "اعتماد فاتورة توريد بن معلقة",
        descriptionAr: "شركة البن الأخضر للتجارة - 18,500 ج.م بانتظار الموافقة لصرف الدفعة",
        branchName: "فرع التجمع الخامس",
        timeAgoAr: "منذ ساعة",
        severity: "HIGH",
        actionLabelAr: "اعتماد الصرف",
        secondaryActionLabelAr: "عرض الفاتورة",
      },
      {
        id: "act-3",
        type: "OVERDUE_TASK",
        titleAr: "مهمة تشغيلية متأخرة ساعتين",
        descriptionAr: "معايرة مطحنة الإسبريسو وتنظيف دورة الحليب الصباحية لم تكتمل",
        branchName: "فرع وسط البلد",
        timeAgoAr: "متأخرة ساعتين",
        severity: "HIGH",
        actionLabelAr: "تنبيه المشرف",
      },
      {
        id: "act-4",
        type: "LOW_STOCK",
        titleAr: "تنبيه اقتراب نفاد مخزون حرج",
        descriptionAr: "حليب شوفان Oatly متبقي 4 عبوات فقط (حد إعادة الطلب 12)",
        branchName: "فرع الشيخ زايد",
        timeAgoAr: "الآن",
        severity: "MEDIUM",
        actionLabelAr: "طلب تحويل مخزني",
      },
    ],
  },
  week: {
    period: "week",
    kpis: {
      netSales: 168200,
      netSalesTrend: "+14.2% مقارنة بالأسبوع الماضي",
      collections: 159400,
      collectionsRatio: "94.8% محصل",
      expenses: 28400,
      expensesRatio: "16.8% من المبيعات",
      openShifts: 2,
      activeBranches: 3,
    },
    channelBreakdown: [
      { channel: "DINE_IN", channelNameAr: "صالات", percentage: 51, amount: 85782 },
      { channel: "TAKEAWAY", channelNameAr: "سفري واستلام", percentage: 37, amount: 62234 },
      { channel: "DELIVERY", channelNameAr: "توصيل وتطبيقات", percentage: 12, amount: 20184 },
    ],
    topProducts: [
      { nameAr: "فلات وايت", ordersCount: 380, revenue: 32300 },
      { nameAr: "آيس سبانش لاتيه", ordersCount: 260, revenue: 27300 },
      { nameAr: "في 60 كولومبي", ordersCount: 220, revenue: 24200 },
      { nameAr: "كرواسون لوز فرنسي", ordersCount: 180, revenue: 13500 },
      { nameAr: "كولد برو إثيوبي", ordersCount: 135, revenue: 12825 },
    ],
    branchPerformance: [
      { branchName: "فرع التجمع الخامس", revenue: 72326, percentage: 43 },
      { branchName: "فرع وسط البلد", revenue: 58870, percentage: 35 },
      { branchName: "فرع الشيخ زايد", revenue: 37004, percentage: 22 },
    ],
    actionInbox: [
      {
        id: "act-1",
        type: "SHIFT_CLOSE",
        titleAr: "اعتماد إغلاق وردية - فرع التجمع الخامس",
        descriptionAr: "الوردية #142 (الكاشير كريم فؤاد) - يوجد فائض بالدرج +45 ج.م بمذكرة توضيحية",
        branchName: "فرع التجمع الخامس",
        timeAgoAr: "منذ 25 دقيقة",
        severity: "URGENT",
        actionLabelAr: "اعتماد الإغلاق",
      },
      {
        id: "act-2",
        type: "EXPENSE_APPROVAL",
        titleAr: "اعتماد فاتورة توريد بن معلقة",
        descriptionAr: "شركة البن الأخضر للتجارة - 18,500 ج.م بانتظار الموافقة لصرف الدفعة",
        branchName: "فرع التجمع الخامس",
        timeAgoAr: "منذ ساعة",
        severity: "HIGH",
        actionLabelAr: "اعتماد الصرف",
      },
    ],
  },
  month: {
    period: "month",
    kpis: {
      netSales: 385400,
      netSalesTrend: "+12.4% مقارنة بالشهر السابق",
      collections: 362100,
      collectionsRatio: "93.9% محصل (متبقي 23,300 آجل)",
      expenses: 142500,
      expensesRatio: "37% من المبيعات (هامش تشغيلي 63%)",
      openShifts: 2,
      activeBranches: 3,
    },
    channelBreakdown: [
      { channel: "DINE_IN", channelNameAr: "صالات", percentage: 52, amount: 200408 },
      { channel: "TAKEAWAY", channelNameAr: "سفري واستلام", percentage: 36, amount: 138744 },
      { channel: "DELIVERY", channelNameAr: "توصيل وتطبيقات", percentage: 12, amount: 46248 },
    ],
    topProducts: [
      { nameAr: "فلات وايت", ordersCount: 820, revenue: 69700 },
      { nameAr: "آيس سبانش لاتيه", ordersCount: 570, revenue: 59850 },
      { nameAr: "في 60 كولومبي", ordersCount: 490, revenue: 53900 },
      { nameAr: "كرواسون لوز فرنسي", ordersCount: 450, revenue: 33750 },
      { nameAr: "كولد برو إثيوبي", ordersCount: 350, revenue: 33250 },
    ],
    branchPerformance: [
      { branchName: "فرع التجمع الخامس", revenue: 164200, percentage: 42.6 },
      { branchName: "فرع وسط البلد", revenue: 132800, percentage: 34.5 },
      { branchName: "فرع الشيخ زايد", revenue: 88400, percentage: 22.9 },
    ],
    actionInbox: [
      {
        id: "act-1",
        type: "SHIFT_CLOSE",
        titleAr: "اعتماد إغلاق وردية - فرع التجمع الخامس",
        descriptionAr: "الوردية #142 (الكاشير كريم فؤاد) - يوجد فائض بالدرج +45 ج.م بمذكرة توضيحية",
        branchName: "فرع التجمع الخامس",
        timeAgoAr: "منذ 25 دقيقة",
        severity: "URGENT",
        actionLabelAr: "اعتماد الإغلاق",
      },
      {
        id: "act-2",
        type: "EXPENSE_APPROVAL",
        titleAr: "اعتماد فاتورة توريد بن معلقة",
        descriptionAr: "شركة البن الأخضر للتجارة - 18,500 ج.م بانتظار الموافقة لصرف الدفعة",
        branchName: "فرع التجمع الخامس",
        timeAgoAr: "منذ ساعة",
        severity: "HIGH",
        actionLabelAr: "اعتماد الصرف",
      },
      {
        id: "act-3",
        type: "OVERDUE_TASK",
        titleAr: "مهمة تشغيلية متأخرة ساعتين",
        descriptionAr: "معايرة مطحنة الإسبريسو وتنظيف دورة الحليب الصباحية لم تكتمل",
        branchName: "فرع وسط البلد",
        timeAgoAr: "متأخرة ساعتين",
        severity: "HIGH",
        actionLabelAr: "تنبيه المشرف",
      },
      {
        id: "act-4",
        type: "LOW_STOCK",
        titleAr: "تنبيه اقتراب نفاد مخزون حرج",
        descriptionAr: "حليب شوفان Oatly متبقي 4 عبوات فقط (حد إعادة الطلب 12)",
        branchName: "فرع الشيخ زايد",
        timeAgoAr: "الآن",
        severity: "MEDIUM",
        actionLabelAr: "طلب تحويل مخزني",
      },
    ],
  },
};

// ==========================================
// 4. Tasks Types & Synthetic Dataset
// ==========================================

export type TaskStatus = "PENDING" | "IN_PROGRESS" | "COMPLETED" | "OVERDUE";
export type TaskPriority = "URGENT" | "HIGH" | "MEDIUM" | "ROUTINE";

export type TaskChecklistItem = {
  id: string;
  textAr: string;
  isDone: boolean;
};

export type TaskItem = {
  id: string;
  code: string;
  titleAr: string;
  descriptionAr: string;
  branchName: string;
  roleAr: string;
  assigneeName: string;
  dueTimeAr: string;
  status: TaskStatus;
  priority: TaskPriority;
  checklist: TaskChecklistItem[];
  supervisorNoteAr?: string;
  evidenceRequired: boolean;
  evidenceMockImage?: string;
  evidenceNotesAr?: string;
};

export const MOCK_TASKS: readonly TaskItem[] = [
  {
    id: "tsk-01",
    code: "TSK-101",
    titleAr: "فحص ومعايرة مطحنة الإسبريسو الصباحية (Dial-in)",
    descriptionAr: "وزن الجرعة الجافة 18.5 جم، استخلاص 38 جم خلال 27-29 ثانية، وتذوق نوتات الإسبريسو قبل فتح الصالة للجمهور.",
    branchName: "فرع وسط البلد",
    roleAr: "باريستا",
    assigneeName: "أحمد سامي",
    dueTimeAr: "08:30 ص",
    status: "OVERDUE",
    priority: "URGENT",
    checklist: [
      { id: "c1", textAr: "تنظيف هوبر البن ومسح زيوت الحبوب القديمة", isDone: true },
      { id: "c2", textAr: "قياس وزن الجرعة الجافة على الميزان بدقة (18.5 جم)", isDone: true },
      { id: "c3", textAr: "ضبط زمن تدفق الاستخلاص على 28 ثانية (38 جم في الفنجان)", isDone: false },
      { id: "c4", textAr: "تذوق وتقييم نوتات الحموضة والمرارة واعتماد الطعم", isDone: false },
    ],
    supervisorNoteAr: "يرجى عدم فتح باب استلام الطلبات من الزبائن قبل اعتماد طعم الاستخلاص وتوثيق القراءة.",
    evidenceRequired: true,
  },
  {
    id: "tsk-02",
    code: "TSK-102",
    titleAr: "تعقيم عصا التبخير ودورة الباك فلاش لماكينة الإسبريسو",
    descriptionAr: "إجراء دورة الغسيل العكسي بمسحوق Cafiza ونقع عصا التبخير لإزالة ترسبات الحليب المحترق.",
    branchName: "فرع التجمع الخامس",
    roleAr: "باريستا",
    assigneeName: "زياد محمود",
    dueTimeAr: "02:00 م",
    status: "IN_PROGRESS",
    priority: "MEDIUM",
    checklist: [
      { id: "c1", textAr: "تنظيف الباسكت الأعمى بالمسحوق المخصص", isDone: true },
      { id: "c2", textAr: "تشغيل دورة الباك فلاش 5 مرات متتالية لمجموعتي الماكينة", isDone: true },
      { id: "c3", textAr: "فك رؤوس عصا التبخير وتطهيرها بالفرشاة الدقيقة", isDone: false },
      { id: "c4", textAr: "مسح وتلميع حوض تصريف الماكينة بالكامل", isDone: false },
    ],
    evidenceRequired: true,
  },
  {
    id: "tsk-03",
    code: "TSK-103",
    titleAr: "استلام وفحص شحنة البن وتاريخ التحميص وحالة الأكياس",
    descriptionAr: "استلام 20 كجم بن كولومبيا وبرازيل من شركة البن الأخضر ومطابقة أوزان الأكياس وصمامات التهوية.",
    branchName: "فرع التجمع الخامس",
    roleAr: "مشرف الوردية",
    assigneeName: "سارة عثمان",
    dueTimeAr: "11:00 ص",
    status: "COMPLETED",
    priority: "HIGH",
    checklist: [
      { id: "c1", textAr: "مطابقة عدد الأكياس مع إذن التوريد (20 كيس × 1 كجم)", isDone: true },
      { id: "c2", textAr: "التأكد من تاريخ التحميص المطبوع (أقل من 10 أيام)", isDone: true },
      { id: "c3", textAr: "فحص سلامة صمامات تفريغ الهواء (Degassing Valve)", isDone: true },
      { id: "c4", textAr: "توقيع إشعار الاستلام ورفع صورة الفاتورة للسيستم", isDone: true },
    ],
    evidenceRequired: true,
    evidenceMockImage: "invoice_coffee_delivery.png",
    evidenceNotesAr: "تم استلام الشحنة بالكامل وتخزينها في المستودع المكيف بدرجة حرارة 21 مئوية.",
  },
  {
    id: "tsk-04",
    code: "TSK-104",
    titleAr: "جرد الحليب والمشروبات النباتية في الثلاجة ومطابقة الصلاحية",
    descriptionAr: "عد عبوات حليب المراعي وحليب الشوفان واللوز، وتطبيق قاعدة FIFO لتجنب هدر المنتجات.",
    branchName: "فرع الشيخ زايد",
    roleAr: "مشرف الوردية",
    assigneeName: "عمر خالد",
    dueTimeAr: "04:00 م",
    status: "IN_PROGRESS",
    priority: "MEDIUM",
    checklist: [
      { id: "c1", textAr: "عد عبوات حليب كامل الدسم وتوثيق أي عبوة تالفة", isDone: true },
      { id: "c2", textAr: "حصر عبوات حليب الشوفان واللوز والتأكد من تاريخ الانتهاء", isDone: true },
      { id: "c3", textAr: "إعادة ترتيب العبوات على الأرفف حسب الأسبقية (FIFO)", isDone: false },
      { id: "c4", textAr: "تسجيل النواقص في سجل طلبات المستودع المركزي", isDone: false },
    ],
    evidenceRequired: true,
  },
  {
    id: "tsk-05",
    code: "TSK-105",
    titleAr: "فحص حرارة ثلاجة عرض الحلويات والكيك وضبط البرودة",
    descriptionAr: "التأكد من بقاء درجة حرارة عرض الكيك بين 3 و 5 درجات مئوية لحماية جودة وسلامة المنتجات الغذائية.",
    branchName: "فرع وسط البلد",
    roleAr: "باريستا",
    assigneeName: "منى إبراهيم",
    dueTimeAr: "10:00 ص",
    status: "COMPLETED",
    priority: "HIGH",
    checklist: [
      { id: "c1", textAr: "قراءة مقياس الحرارة الرقمي الداخلي (الترمومتر)", isDone: true },
      { id: "c2", textAr: "التأكد من إحكام غلق الأبواب الزجاجية المنزلقة", isDone: true },
      { id: "c3", textAr: "مسح وتلميع الزجاج الخارجي وإزالة بصمات الأصابع", isDone: true },
    ],
    evidenceRequired: true,
    evidenceMockImage: "fridge_thermometer_4c.png",
    evidenceNotesAr: "الحرارة المسجلة 4.1 درجة مئوية والزجاج نظيف تماماً.",
  },
  {
    id: "tsk-06",
    code: "TSK-106",
    titleAr: "تطهير وتعقيم دورات المياه وصالة الجلوس - الجولة المسائية",
    descriptionAr: "تنظيف دورات المياه، تعبئة الصابون والمناديل، ومسح وتطهير طاولات الصالة الداخلية والخارجية.",
    branchName: "فرع الشيخ زايد",
    roleAr: "فريق النظافة",
    assigneeName: "حسن عبد الله",
    dueTimeAr: "07:00 م",
    status: "PENDING",
    priority: "ROUTINE",
    checklist: [
      { id: "c1", textAr: "تعقيم مقابض الأبواب ومغاسل المياه بمطهر معتمد", isDone: false },
      { id: "c2", textAr: "ملء موزعات الصابون الرغوي ومجففات المناديل الورقية", isDone: false },
      { id: "c3", textAr: "مسح وتطهير جميع طاولات الصالة الداخلية والخارجية", isDone: false },
      { id: "c4", textAr: "تفريغ سلات المهملات وتغيير أكياس القمامة", isDone: false },
    ],
    evidenceRequired: true,
  },
  {
    id: "tsk-07",
    code: "TSK-107",
    titleAr: "إغلاق الكاشير ومطابقة نقدية الدرج مع مبيعات الوردية",
    descriptionAr: "طباعة تقرير نهاية الوردية (Z-Report)، عد النقدية في الدرج، وفصل إيصالات البطاقات والمحافظ.",
    branchName: "فرع وسط البلد",
    roleAr: "مشرف الوردية",
    assigneeName: "طارق مصطفى",
    dueTimeAr: "04:30 م",
    status: "PENDING",
    priority: "URGENT",
    checklist: [
      { id: "c1", textAr: "طباعة تقرير إغلاق الوردية الشامل من شاشة الكاشير", isDone: false },
      { id: "c2", textAr: "عد النقدية الورقية والمعدنية ومطابقتها مع إجمالي السيستم", isDone: false },
      { id: "c3", textAr: "حصر إيصالات شبكة مدى والبطاقات البنكية", isDone: false },
      { id: "c4", textAr: "وضع النقدية في المظروف المالي الآمن وإغلاقه", isDone: false },
    ],
    evidenceRequired: true,
  },
];

// Helper calculations
export function calculateCartTotals(
  items: readonly POSCartItem[],
  discountAmount = 0,
  taxRate = 0.14
) {
  const subtotal = items.reduce((acc, item) => acc + item.lineTotal, 0);
  const discounted = Math.max(0, subtotal - discountAmount);
  const tax = Math.round(discounted * taxRate * 100) / 100;
  const total = Math.round((discounted + tax) * 100) / 100;

  return {
    subtotal,
    discount: discountAmount,
    taxableAmount: discounted,
    taxAmount: tax,
    total,
    itemCount: items.reduce((acc, item) => acc + item.quantity, 0),
  };
}
