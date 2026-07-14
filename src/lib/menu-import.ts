// Menu Excel/CSV import — shared, pure logic used by both the client
// (header mapping for the preview) and the server (validation + import).
// Arabic and English column headers are both accepted.

// ── Column mapping ────────────────────────────────────────────

export type ImportField =
  | "category"
  | "productName"
  | "price"
  | "description"
  | "costPrice"
  | "imageUrl"
  | "isAvailable"
  | "showInCustomerMenu"
  | "showInPOS"
  | "sortOrder"
  | "branchName"
  | "variantName"
  | "variantPrice"
  | "addonName"
  | "addonPrice";

// header (lowercased, trimmed) → field
const HEADER_MAP: Record<string, ImportField> = {
  // required
  "القسم": "category", "category": "category",
  "اسم المنتج": "productName", "المنتج": "productName", "productname": "productName", "product": "productName",
  "سعر البيع": "price", "السعر": "price", "price": "price",
  // optional
  "الوصف": "description", "description": "description",
  "تكلفة المنتج": "costPrice", "التكلفة": "costPrice", "costprice": "costPrice",
  "رابط الصورة": "imageUrl", "صورة المنتج": "imageUrl", "imageurl": "imageUrl",
  "متاح": "isAvailable", "متاح للبيع": "isAvailable", "isavailable": "isAvailable",
  "يظهر في منيو العميل": "showInCustomerMenu", "showincustomermenu": "showInCustomerMenu",
  "يظهر في الكاشير": "showInPOS", "showinpos": "showInPOS",
  "ترتيب الظهور": "sortOrder", "الترتيب": "sortOrder", "sortorder": "sortOrder",
  "اسم الفرع": "branchName", "الفرع": "branchName", "branchname": "branchName", "branch": "branchName",
  "اسم الحجم": "variantName", "الحجم": "variantName", "variantname": "variantName",
  "سعر الحجم": "variantPrice", "variantprice": "variantPrice",
  "اسم الإضافة": "addonName", "الإضافة": "addonName", "addonname": "addonName", "addon": "addonName",
  "سعر الإضافة": "addonPrice", "addonprice": "addonPrice",
};

export function mapHeader(header: string): ImportField | null {
  return HEADER_MAP[header.trim().toLowerCase()] ?? null;
}

// Raw row as sent from the client: original headers already mapped to
// fields, values still unparsed strings/numbers.
export type RawImportRow = Partial<Record<ImportField, string | number | boolean | null>>;

// Convert a sheet row (original headers) into a RawImportRow.
export function mapRowHeaders(row: Record<string, unknown>): RawImportRow {
  const mapped: RawImportRow = {};
  for (const [header, value] of Object.entries(row)) {
    const field = mapHeader(header);
    if (field && value !== undefined && value !== null && String(value).trim() !== "") {
      mapped[field] = value as string | number;
    }
  }
  return mapped;
}

// ── Value parsing ─────────────────────────────────────────────

const TRUE_WORDS = new Set(["نعم", "true", "yes", "1", "متاح", "ظاهر"]);
const FALSE_WORDS = new Set(["لا", "false", "no", "0", "غير متاح", "مخفي"]);

export function parseBoolean(value: unknown): boolean | null | "invalid" {
  if (value === undefined || value === null || String(value).trim() === "") return null;
  if (typeof value === "boolean") return value;
  const word = String(value).trim().toLowerCase();
  if (TRUE_WORDS.has(word)) return true;
  if (FALSE_WORDS.has(word)) return false;
  return "invalid";
}

export function parseNumber(value: unknown): number | null | "invalid" {
  if (value === undefined || value === null || String(value).trim() === "") return null;
  // Accept Arabic-Indic digits too.
  const normalized = String(value)
    .trim()
    .replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)))
    .replace(/٫/g, ".")
    .replace(/,/g, "");
  const n = Number(normalized);
  return isNaN(n) ? "invalid" : n;
}

// ── Validated row ─────────────────────────────────────────────

export type ValidatedRow = {
  rowNumber: number; // 1-based data row number (excluding header)
  category: string;
  productName: string;
  price: number | null;
  description?: string;
  costPrice?: number;
  imageUrl?: string;
  isAvailable?: boolean;
  showInCustomerMenu?: boolean;
  showInPOS?: boolean;
  sortOrder?: number;
  branchName?: string;
  variantName?: string;
  variantPrice?: number;
  addonName?: string;
  addonPrice?: number;
  errors: string[];
};

export function validateRow(raw: RawImportRow, rowNumber: number): ValidatedRow {
  const errors: string[] = [];
  const str = (v: unknown) => String(v ?? "").trim();

  const category = str(raw.category);
  const productName = str(raw.productName);
  if (!productName) errors.push("اسم المنتج مطلوب");
  if (!category) errors.push("القسم مطلوب");

  const price = parseNumber(raw.price);
  if (price === null) errors.push("السعر مطلوب");
  else if (price === "invalid" || price <= 0) {
    errors.push("السعر يجب أن يكون رقم أكبر من صفر");
  }

  const numField = (value: unknown, label: string): number | undefined => {
    const n = parseNumber(value);
    if (n === "invalid") {
      errors.push(`${label} يجب أن يكون رقم`);
      return undefined;
    }
    return n ?? undefined;
  };
  const boolField = (value: unknown, label: string): boolean | undefined => {
    const b = parseBoolean(value);
    if (b === "invalid") {
      errors.push(`قيمة «${label}» غير مفهومة (استخدم نعم/لا)`);
      return undefined;
    }
    return b ?? undefined;
  };

  const costPrice = numField(raw.costPrice, "تكلفة المنتج");
  const sortOrder = numField(raw.sortOrder, "ترتيب الظهور");
  const variantPrice = numField(raw.variantPrice, "سعر الحجم");
  const addonPrice = numField(raw.addonPrice, "سعر الإضافة");

  const variantName = str(raw.variantName) || undefined;
  if (variantName && variantPrice === undefined) {
    errors.push("سعر الحجم مطلوب مع اسم الحجم");
  }
  const addonName = str(raw.addonName) || undefined;
  if (addonName && addonPrice === undefined) {
    errors.push("سعر الإضافة مطلوب مع اسم الإضافة");
  }

  return {
    rowNumber,
    category,
    productName,
    price: typeof price === "number" ? price : null,
    description: str(raw.description) || undefined,
    costPrice,
    imageUrl: str(raw.imageUrl) || undefined,
    isAvailable: boolField(raw.isAvailable, "متاح"),
    showInCustomerMenu: boolField(raw.showInCustomerMenu, "يظهر في منيو العميل"),
    showInPOS: boolField(raw.showInPOS, "يظهر في الكاشير"),
    sortOrder,
    branchName: str(raw.branchName) || undefined,
    variantName,
    variantPrice,
    addonName,
    addonPrice,
    errors,
  };
}

// ── Grouping ──────────────────────────────────────────────────
// Multiple rows with the same (category, productName) describe one
// product: the first row supplies the product fields, every row may
// add a variant, an add-on, or a branch price.

export type ProductGroup = {
  category: string;
  productName: string;
  rows: ValidatedRow[];
};

export function groupRows(rows: ValidatedRow[]): ProductGroup[] {
  const groups = new Map<string, ProductGroup>();
  for (const row of rows) {
    const key = `${row.category}::${row.productName}`;
    const group = groups.get(key);
    if (group) group.rows.push(row);
    else groups.set(key, { category: row.category, productName: row.productName, rows: [row] });
  }
  return [...groups.values()];
}

export type ImportMode = "create" | "update" | "upsert";

export const IMPORT_MODE_LABELS: Record<ImportMode, string> = {
  create: "إضافة المنتجات الجديدة فقط",
  update: "تحديث المنتجات الموجودة بنفس الاسم",
  upsert: "إضافة وتحديث",
};

export const MAX_IMPORT_ROWS = 500;

// Template definition (also used by the error report).
export const TEMPLATE_HEADERS = [
  "القسم",
  "اسم المنتج",
  "سعر البيع",
  "الوصف",
  "تكلفة المنتج",
  "رابط الصورة",
  "متاح",
  "يظهر في منيو العميل",
  "يظهر في الكاشير",
  "ترتيب الظهور",
  "اسم الفرع",
  "اسم الحجم",
  "سعر الحجم",
  "اسم الإضافة",
  "سعر الإضافة",
] as const;

export const TEMPLATE_EXAMPLE_ROWS: (string | number)[][] = [
  ["قهوة", "إسبريسو", 45, "قهوة إسبريسو مركزة", 15, "", "نعم", "نعم", "نعم", 1, "", "", "", "", ""],
  ["قهوة", "سبانش لاتيه", 95, "مشروب بالحليب المكثف", 35, "", "نعم", "نعم", "نعم", 2, "", "صغير", 75, "", ""],
  ["قهوة", "سبانش لاتيه", 95, "", "", "", "", "", "", "", "", "وسط", 95, "", ""],
  ["قهوة", "سبانش لاتيه", 95, "", "", "", "", "", "", "", "", "كبير", 115, "شوت إسبريسو إضافي", 25],
  ["شاي", "شاي نعناع", 35, "شاي بالنعناع الطازة", 8, "", "نعم", "نعم", "نعم", 1, "", "", "", "", ""],
];
