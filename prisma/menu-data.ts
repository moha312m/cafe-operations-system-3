// Canonical demo menu (Egyptian cafe, prices in EGP), shared by
// seed.ts (fresh installs) and topup-menu.ts (topping up an existing DB).
// Variant prices are ABSOLUTE (سعر الحجم), not deltas.

export const DEMO_ADD_ONS = [
  { name: "شوت إسبريسو إضافي", price: 25 },
  { name: "فانيليا", price: 15 },
  { name: "كراميل", price: 15 },
  { name: "لبن شوفان", price: 30 },
  { name: "صوص شوكولاتة", price: 20 },
  { name: "جبنة زيادة", price: 20 },
] as const;

const COFFEE_ADDONS = ["شوت إسبريسو إضافي", "فانيليا", "كراميل", "لبن شوفان"];

// صغير = الأساسي − 20 · وسط = الأساسي · كبير = الأساسي + 20
const sizes = (base: number) => [
  { name: "صغير", price: base - 20 },
  { name: "وسط", price: base },
  { name: "كبير", price: base + 20 },
];

export type DemoMenuItem = {
  name: string;
  basePrice: number;
  costPrice?: number;
  description?: string;
  variants?: { name: string; price: number }[];
  addOns?: string[];
  isAvailable?: boolean; // default true — false shows "غير متاح"
  showInCustomerMenu?: boolean; // default true — false hides from QR menu
  branchPrices?: Record<string, number>; // menuSlug → override price
};

export const DEMO_MENU: { category: string; items: DemoMenuItem[] }[] = [
  {
    category: "قهوة",
    items: [
      {
        name: "إسبريسو",
        basePrice: 45,
        costPrice: 15,
        description: "شوت قهوة مركز",
        variants: [
          { name: "سنجل", price: 45 },
          { name: "دبل", price: 60 },
        ],
        addOns: ["شوت إسبريسو إضافي"],
      },
      {
        name: "أمريكانو",
        basePrice: 55,
        costPrice: 18,
        description: "إسبريسو مع مية سخنة",
        variants: sizes(55),
        addOns: ["شوت إسبريسو إضافي", "لبن شوفان"],
      },
      {
        name: "كابتشينو",
        basePrice: 70,
        costPrice: 25,
        description: "إسبريسو مع لبن مبخّر ورغوة",
        variants: sizes(70),
        addOns: COFFEE_ADDONS,
      },
      {
        name: "لاتيه",
        basePrice: 75,
        costPrice: 27,
        description: "إسبريسو مع لبن ناعم",
        variants: sizes(75),
        addOns: [...COFFEE_ADDONS, "صوص شوكولاتة"],
      },
      {
        name: "سبانش لاتيه",
        basePrice: 95,
        costPrice: 35,
        description: "لاتيه بلبن مكثّف محلّى",
        variants: sizes(95), // صغير 75 · وسط 95 · كبير 115
        addOns: COFFEE_ADDONS,
        // سعر مختلف حسب الفرع: التجمع = الأساسي 95
        branchPrices: { "nasr-city": 90, "sheikh-zayed": 100 },
      },
      {
        name: "آيس لاتيه",
        basePrice: 85,
        costPrice: 30,
        description: "إسبريسو مع لبن ساقع وتلج",
        variants: sizes(85),
        addOns: [...COFFEE_ADDONS, "صوص شوكولاتة"],
      },
    ],
  },
  {
    category: "شاي",
    items: [
      { name: "شاي", basePrice: 25, costPrice: 5, description: "شاي كشري بلدي" },
      { name: "شاي أخضر", basePrice: 35, costPrice: 8, description: "شاي أخضر بالياسمين" },
      { name: "شاي نعناع", basePrice: 35, costPrice: 8, description: "شاي بالنعناع الطازة" },
    ],
  },
  {
    category: "عصائر",
    items: [
      { name: "عصير برتقال", basePrice: 60, costPrice: 20, description: "برتقال طازة معصور" },
      { name: "عصير مانجو", basePrice: 70, costPrice: 28, description: "مانجو بلدي طبيعي" },
      { name: "عصير فراولة", basePrice: 65, costPrice: 24, description: "فراولة طازة" },
    ],
  },
  {
    category: "مخبوزات",
    items: [
      { name: "كرواسون", basePrice: 60, costPrice: 22, description: "كرواسون زبدة طازة" },
      {
        name: "مافن",
        basePrice: 55,
        costPrice: 20,
        description: "مافن شوكولاتة",
        isAvailable: false, // مثال لمنتج "غير متاح"
      },
      { name: "براوني", basePrice: 65, costPrice: 25, description: "براوني بعين الجمل" },
    ],
  },
  {
    category: "ساندوتشات",
    items: [
      {
        name: "ساندوتش تركي",
        basePrice: 120,
        costPrice: 55,
        description: "تركي مدخّن مع خس وطماطم",
        addOns: ["جبنة زيادة"],
      },
      {
        name: "تشيكن بانيني",
        basePrice: 130,
        costPrice: 60,
        description: "فراخ مشوية مع بيستو وموتزاريلا",
        addOns: ["جبنة زيادة"],
        showInCustomerMenu: false, // مثال لمنتج مخفي من منيو العميل
      },
    ],
  },
];
