function deterministicSlug(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(36).toUpperCase().padStart(6, "0").slice(0, 6);
}

export type HistoricalSaleField =
  | "productName"
  | "sku"
  | "invoiceNo"
  | "saleDate"
  | "quantity"
  | "quantityUnit"
  | "unitPrice"
  | "discount"
  | "tax"
  | "total"
  | "paymentMethod"
  | "customerName"
  | "contactNumber"
  | "location";

export const HISTORICAL_HEADER_MAP: Record<string, HistoricalSaleField> = {
  // Product Name
  "اسم المنتج": "productName",
  "المنتج": "productName",
  "الصنف": "productName",
  "اسم الصنف": "productName",
  "product": "productName",
  "product_name": "productName",
  "productname": "productName",
  "product name": "productName",
  "item": "productName",
  "item_name": "productName",
  "itemname": "productName",
  "item name": "productName",

  // SKU / Barcode
  "كود المنتج": "sku",
  "كود الصنف": "sku",
  "الرمز": "sku",
  "الباركود": "sku",
  "باركود": "sku",
  "كود": "sku",
  "sku": "sku",
  "item_sku": "sku",
  "item-sku": "sku",
  "barcode": "sku",
  "code": "sku",

  // Invoice Number
  "رقم الفاتورة": "invoiceNo",
  "الفاتورة": "invoiceNo",
  "مرجع الطلب": "invoiceNo",
  "رقم الطلب": "invoiceNo",
  "الطلب": "invoiceNo",
  "كود الفاتورة": "invoiceNo",
  "invoice": "invoiceNo",
  "invoice_no": "invoiceNo",
  "invoiceno": "invoiceNo",
  "invoice no": "invoiceNo",
  "invoice no.": "invoiceNo",
  "order_id": "invoiceNo",
  "order id": "invoiceNo",
  "orderid": "invoiceNo",
  "order": "invoiceNo",
  "receipt": "invoiceNo",
  "receipt_no": "invoiceNo",
  "reference": "invoiceNo",

  // Sale Date / Time
  "تاريخ البيع": "saleDate",
  "التاريخ": "saleDate",
  "تاريخ الطلب": "saleDate",
  "وقت البيع": "saleDate",
  "تاريخ الفاتورة": "saleDate",
  "تاريخ": "saleDate",
  "date": "saleDate",
  "sale_date": "saleDate",
  "saledate": "saleDate",
  "sale date": "saleDate",
  "created_at": "saleDate",
  "createdat": "saleDate",
  "datetime": "saleDate",
  "timestamp": "saleDate",

  // Quantity
  "الكمية": "quantity",
  "العدد": "quantity",
  "عدد": "quantity",
  "كمية": "quantity",
  "qty": "quantity",
  "quantity": "quantity",
  "count": "quantity",
  "amount_sold": "quantity",

  // Unit
  "الوحدة": "quantityUnit",
  "وحدة القياس": "quantityUnit",
  "وحدة": "quantityUnit",
  "unit": "quantityUnit",
  "quantity_unit": "quantityUnit",
  "unit_name": "quantityUnit",
  "uom": "quantityUnit",

  // Unit Price
  "سعر الوحدة": "unitPrice",
  "السعر": "unitPrice",
  "سعر البيع": "unitPrice",
  "سعر الصنف": "unitPrice",
  "سعر": "unitPrice",
  "price": "unitPrice",
  "unit_price": "unitPrice",
  "unitprice": "unitPrice",
  "unit price": "unitPrice",
  "selling_price": "unitPrice",
  "rate": "unitPrice",

  // Discount
  "الخصم": "discount",
  "قيمة الخصم": "discount",
  "خصم": "discount",
  "تخفيض": "discount",
  "discount": "discount",
  "discount_amount": "discount",
  "discountamount": "discount",

  // Tax / VAT
  "الضريبة": "tax",
  "قيمة الضريبة": "tax",
  "ضريبة": "tax",
  "ضريبة القيمة المضافة": "tax",
  "tax": "tax",
  "tax_amount": "tax",
  "vat": "tax",

  // Total
  "الإجمالي": "total",
  "المبلغ": "total",
  "صافي البيع": "total",
  "المجموع": "total",
  "صافي المبلغ": "total",
  "إجمالي": "total",
  "مجموع": "total",
  "total": "total",
  "line_total": "total",
  "linetotal": "total",
  "line total": "total",
  "amount": "total",
  "net_total": "total",
  "net_amount": "total",

  // Payment Method
  "وسيلة الدفع": "paymentMethod",
  "طريقة الدفع": "paymentMethod",
  "نوع الدفع": "paymentMethod",
  "طريقة السداد": "paymentMethod",
  "الدفع": "paymentMethod",
  "سداد": "paymentMethod",
  "payment_method": "paymentMethod",
  "paymentmethod": "paymentMethod",
  "payment method": "paymentMethod",
  "payment_type": "paymentMethod",
  "payment": "paymentMethod",
  "tender": "paymentMethod",
  "tender_type": "paymentMethod",

  // Customer Name
  "اسم العميل": "customerName",
  "العميل": "customerName",
  "عميل": "customerName",
  "customer": "customerName",
  "customer_name": "customerName",
  "customername": "customerName",
  "client": "customerName",

  // Phone / Contact
  "رقم الهاتف": "contactNumber",
  "الهاتف": "contactNumber",
  "الموبايل": "contactNumber",
  "الجوال": "contactNumber",
  "phone": "contactNumber",
  "mobile": "contactNumber",
  "contact": "contactNumber",
  "contact_number": "contactNumber",

  // Branch / Location
  "الفرع": "location",
  "الموقع": "location",
  "اسم الفرع": "location",
  "المتجر": "location",
  "branch": "location",
  "location": "location",
  "store": "location",
};

export function mapHistoricalHeader(header: string): HistoricalSaleField | null {
  const clean = header.trim().toLowerCase();
  if (HISTORICAL_HEADER_MAP[clean]) return HISTORICAL_HEADER_MAP[clean];
  const normalized = clean.replace(/[\-_./\\]/g, " ").replace(/\s+/g, " ");
  if (HISTORICAL_HEADER_MAP[normalized]) return HISTORICAL_HEADER_MAP[normalized];
  const parts = clean.split(/[/|\\-]+/).map((p) => p.trim());
  for (const part of parts) {
    if (HISTORICAL_HEADER_MAP[part]) return HISTORICAL_HEADER_MAP[part];
  }
  return null;
}

export type RawHistoricalSaleRow = Partial<Record<HistoricalSaleField, unknown>>;

export function mapHistoricalRowHeaders(row: Record<string, unknown>): RawHistoricalSaleRow {
  const mapped: RawHistoricalSaleRow = {};
  for (const [header, val] of Object.entries(row)) {
    const field = mapHistoricalHeader(header);
    if (field && val !== undefined && val !== null && String(val).trim() !== "") {
      mapped[field] = val;
    }
  }
  return mapped;
}

/** Parses numeric strings with Arabic-Indic digits, commas, currencies. */
export function parseHistoricalNumber(value: unknown): number | null | "invalid" {
  if (value === undefined || value === null || String(value).trim() === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : "invalid";
  const rawStr = String(value).trim();
  if (!/[\d٠-٩]/.test(rawStr)) return "invalid";
  const str = rawStr
    .replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)))
    .replace(/٫/g, ".")
    .replace(/[^\d.-]/g, "");
  if (str === "" || str === "." || str === "-") return "invalid";
  const n = Number(str);
  return Number.isFinite(n) ? n : "invalid";
}

/** Parses various date formats into { saleDate: YYYY-MM-DD, saleMonth: YYYY-MM, saleLocalDate: string } */
export function parseHistoricalDate(value: unknown): {
  saleDate: string;
  saleMonth: string;
  saleLocalDate: string;
} | null {
  if (!value) return null;

  // Handle Excel serial date numbers (e.g. 45230 or 45230.5)
  if (typeof value === "number" || (/^\d{5}(\.\d+)?$/.test(String(value).trim()) && Number(value) > 20000 && Number(value) < 60000)) {
    const serial = Number(value);
    const utcDays = Math.floor(serial - 25569);
    const date = new Date(utcDays * 86400 * 1000);
    if (!isNaN(date.getTime())) {
      const y = date.getUTCFullYear();
      const m = String(date.getUTCMonth() + 1).padStart(2, "0");
      const d = String(date.getUTCDate()).padStart(2, "0");
      return {
        saleDate: `${y}-${m}-${d}`,
        saleMonth: `${y}-${m}`,
        saleLocalDate: `${y}-${m}-${d}`,
      };
    }
  }

  const str = String(value).trim();

  // Pattern: DD-MM-YYYY or DD/MM/YYYY with optional time
  const dmyMatch = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s*(AM|PM))?)?$/i.exec(str);
  if (dmyMatch) {
    const [, day, month, year] = dmyMatch;
    const d = String(Number(day)).padStart(2, "0");
    const m = String(Number(month)).padStart(2, "0");
    const y = year;
    if (Number(m) >= 1 && Number(m) <= 12 && Number(d) >= 1 && Number(d) <= 31) {
      return {
        saleDate: `${y}-${m}-${d}`,
        saleMonth: `${y}-${m}`,
        saleLocalDate: str,
      };
    }
  }

  // Pattern: YYYY-MM-DD or YYYY/MM/DD with optional time
  const ymdMatch = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[T\s](\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?$/i.exec(str);
  if (ymdMatch) {
    const [, year, month, day] = ymdMatch;
    const y = year;
    const m = String(Number(month)).padStart(2, "0");
    const d = String(Number(day)).padStart(2, "0");
    if (Number(m) >= 1 && Number(m) <= 12 && Number(d) >= 1 && Number(d) <= 31) {
      return {
        saleDate: `${y}-${m}-${d}`,
        saleMonth: `${y}-${m}`,
        saleLocalDate: str,
      };
    }
  }

  // Fallback: Date.parse
  const parsed = new Date(str);
  if (!isNaN(parsed.getTime())) {
    const y = parsed.getFullYear();
    if (y >= 2000 && y <= 2100) {
      const m = String(parsed.getMonth() + 1).padStart(2, "0");
      const d = String(parsed.getDate()).padStart(2, "0");
      return {
        saleDate: `${y}-${m}-${d}`,
        saleMonth: `${y}-${m}`,
        saleLocalDate: str,
      };
    }
  }

  return null;
}

export type ValidatedHistoricalSaleRow = {
  sourceRow: number;
  productName: string;
  sku: string;
  invoiceNo: string;
  saleDate: string;
  saleMonth: string;
  saleLocalDate: string;
  quantity: number;
  quantityUnit: string;
  unitPrice: number;
  discount: number;
  tax: number;
  priceIncTax: number;
  total: number;
  paymentMethod: string | null;
  customerName: string | null;
  contactNumber: string | null;
  location: string | null;
  status: "ready" | "error";
  errors: string[];
};

export function validateHistoricalSaleRow(raw: RawHistoricalSaleRow, rowIndex: number): ValidatedHistoricalSaleRow {
  const errors: string[] = [];

  // Product Name
  const productName = String(raw.productName ?? "").trim();
  if (!productName) {
    errors.push("اسم المنتج مفقود");
  }

  // SKU (fallback to deterministic slug if not present)
  let sku = String(raw.sku ?? "").trim();
  if (!sku && productName) {
    // Generate clean fallback SKU: SKU-HASH
    const hash = deterministicSlug(productName);
    sku = `AUTO-${hash}`;
  }

  // Date
  const parsedDate = parseHistoricalDate(raw.saleDate);
  if (!parsedDate) {
    errors.push("تاريخ البيع غير صالح أو مفقود");
  }

  // Quantity
  const qtyParsed = parseHistoricalNumber(raw.quantity);
  let quantity = 1;
  if (qtyParsed === "invalid" || (qtyParsed !== null && qtyParsed <= 0)) {
    errors.push("الكمية غير صالحة");
  } else if (qtyParsed !== null) {
    quantity = Math.round(qtyParsed * 1000) / 1000;
  }

  const quantityUnit = String(raw.quantityUnit ?? "").trim() || "قطعة";

  // Unit Price
  const priceParsed = parseHistoricalNumber(raw.unitPrice);
  let unitPrice = 0;
  if (priceParsed === "invalid" || (priceParsed !== null && priceParsed < 0)) {
    errors.push("سعر الوحدة غير صالح");
  } else if (priceParsed !== null) {
    unitPrice = Math.round(priceParsed * 100) / 100;
  }

  // Discount
  const discParsed = parseHistoricalNumber(raw.discount);
  let discount = 0;
  if (discParsed === "invalid") {
    errors.push("قيمة الخصم غير صالحة");
  } else if (discParsed !== null && discParsed > 0) {
    discount = Math.round(discParsed * 100) / 100;
  }

  // Tax
  const taxParsed = parseHistoricalNumber(raw.tax);
  let tax = 0;
  if (taxParsed === "invalid") {
    errors.push("قيمة الضريبة غير صالحة");
  } else if (taxParsed !== null && taxParsed > 0) {
    tax = Math.round(taxParsed * 100) / 100;
  }

  // Total
  const totalParsed = parseHistoricalNumber(raw.total);
  let total = 0;
  if (totalParsed === "invalid") {
    errors.push("الإجمالي غير صالح");
  } else if (totalParsed !== null) {
    total = Math.round(totalParsed * 100) / 100;
  } else {
    // Auto-compute total
    total = Math.round(((quantity * unitPrice) - discount + tax) * 100) / 100;
  }

  if (unitPrice === 0 && total > 0 && quantity > 0) {
    unitPrice = Math.round((total / quantity) * 100) / 100;
  }

  const priceIncTax = quantity > 0 ? Math.round((unitPrice + (tax / quantity)) * 100) / 100 : unitPrice;

  // Invoice Number (fallback to row-based if missing)
  const invoiceNo = String(raw.invoiceNo ?? "").trim() || `INV-${parsedDate?.saleDate ?? "HIST"}-${rowIndex}`;

  // Optional string fields
  const paymentMethod = String(raw.paymentMethod ?? "").trim() || null;
  const customerName = String(raw.customerName ?? "").trim() || null;
  const contactNumber = String(raw.contactNumber ?? "").trim() || null;
  const location = String(raw.location ?? "").trim() || null;

  return {
    sourceRow: rowIndex,
    productName,
    sku,
    invoiceNo,
    saleDate: parsedDate?.saleDate ?? "",
    saleMonth: parsedDate?.saleMonth ?? "",
    saleLocalDate: parsedDate?.saleLocalDate ?? "",
    quantity,
    quantityUnit,
    unitPrice,
    discount,
    tax,
    priceIncTax,
    total,
    paymentMethod,
    customerName,
    contactNumber,
    location,
    status: errors.length > 0 ? "error" : "ready",
    errors,
  };
}

export type HistoricalImportStats = {
  total: number;
  ready: number;
  errors: number;
  totalRevenue: number;
  minDate: string | null;
  maxDate: string | null;
  uniqueProducts: number;
  uniqueInvoices: number;
  years: number[];
  paymentMethods: { method: string; count: number; total: number }[];
};

export function calculateHistoricalImportStats(rows: ValidatedHistoricalSaleRow[]): HistoricalImportStats {
  const readyRows = rows.filter((r) => r.status === "ready");
  let totalRevenue = 0;
  let minDate: string | null = null;
  let maxDate: string | null = null;
  const products = new Set<string>();
  const invoices = new Set<string>();
  const years = new Set<number>();
  const methodsMap = new Map<string, { count: number; total: number }>();

  for (const r of readyRows) {
    totalRevenue += r.total;
    if (!minDate || r.saleDate < minDate) minDate = r.saleDate;
    if (!maxDate || r.saleDate > maxDate) maxDate = r.saleDate;
    products.add(r.productName);
    invoices.add(r.invoiceNo);
    const yr = Number(r.saleDate.slice(0, 4));
    if (Number.isFinite(yr)) years.add(yr);

    const m = r.paymentMethod || "غير محدد";
    const cur = methodsMap.get(m) ?? { count: 0, total: 0 };
    cur.count += 1;
    cur.total += r.total;
    methodsMap.set(m, cur);
  }

  const paymentMethods = [...methodsMap.entries()].map(([method, v]) => ({
    method,
    count: v.count,
    total: Math.round(v.total * 100) / 100,
  })).sort((a, b) => b.total - a.total);

  return {
    total: rows.length,
    ready: readyRows.length,
    errors: rows.length - readyRows.length,
    totalRevenue: Math.round(totalRevenue * 100) / 100,
    minDate,
    maxDate,
    uniqueProducts: products.size,
    uniqueInvoices: invoices.size,
    years: [...years].sort((a, b) => a - b),
    paymentMethods,
  };
}

export const HISTORICAL_SALES_TEMPLATE_HEADERS = [
  "اسم المنتج",
  "كود الصنف / SKU",
  "رقم الفاتورة",
  "تاريخ البيع",
  "الكمية",
  "الوحدة",
  "سعر الوحدة",
  "الخصم",
  "الضريبة",
  "الإجمالي",
  "وسيلة الدفع",
  "اسم العميل",
  "رقم الهاتف",
  "الفرع",
];

export const HISTORICAL_SALES_TEMPLATE_EXAMPLE_ROWS = [
  [
    "كابتشينو كبير",
    "2467",
    "INV-1001",
    "2025-10-15 09:30 AM",
    2,
    "كوب",
    75.0,
    0.0,
    0.0,
    150.0,
    "نقدي",
    "أحمد محمد",
    "01012345678",
    "الفرع الرئيسي",
  ],
  [
    "إسبريسو سينجل",
    "2480",
    "INV-1001",
    "2025-10-15 09:30 AM",
    1,
    "كوب",
    50.0,
    5.0,
    0.0,
    45.0,
    "نقدي",
    "أحمد محمد",
    "01012345678",
    "الفرع الرئيسي",
  ],
  [
    "تشيز كيك لوتس",
    "3105",
    "INV-1002",
    "2025-10-15 11:15 AM",
    1,
    "قطعة",
    90.0,
    0.0,
    0.0,
    90.0,
    "بطاقة بنكية",
    "سارة علي",
    "01198765432",
    "الفرع الرئيسي",
  ],
  [
    "آيس لاتيه",
    "2510",
    "INV-1003",
    "2025-10-16 04:45 PM",
    3,
    "كوب",
    80.0,
    0.0,
    0.0,
    240.0,
    "محفظة إلكترونية",
    "محمود حسن",
    "01234567890",
    "الفرع الرئيسي",
  ],
];
