import test from "node:test";
import assert from "node:assert/strict";
import {
  mapHistoricalHeader,
  mapHistoricalRowHeaders,
  parseHistoricalDate,
  parseHistoricalNumber,
  validateHistoricalSaleRow,
  calculateHistoricalImportStats,
  HISTORICAL_SALES_TEMPLATE_HEADERS,
  HISTORICAL_SALES_TEMPLATE_EXAMPLE_ROWS,
} from "../src/lib/historical-sales-import";

test("mapHistoricalHeader recognizes Arabic and English synonyms", () => {
  assert.equal(mapHistoricalHeader("اسم المنتج"), "productName");
  assert.equal(mapHistoricalHeader("المنتج"), "productName");
  assert.equal(mapHistoricalHeader("Product Name"), "productName");
  assert.equal(mapHistoricalHeader("product_name"), "productName");
  assert.equal(mapHistoricalHeader("item"), "productName");

  assert.equal(mapHistoricalHeader("كود الصنف"), "sku");
  assert.equal(mapHistoricalHeader("الباركود"), "sku");
  assert.equal(mapHistoricalHeader("SKU"), "sku");
  assert.equal(mapHistoricalHeader("barcode"), "sku");

  assert.equal(mapHistoricalHeader("رقم الفاتورة"), "invoiceNo");
  assert.equal(mapHistoricalHeader("Invoice No."), "invoiceNo");
  assert.equal(mapHistoricalHeader("order_id"), "invoiceNo");

  assert.equal(mapHistoricalHeader("تاريخ البيع"), "saleDate");
  assert.equal(mapHistoricalHeader("Date"), "saleDate");
  assert.equal(mapHistoricalHeader("created_at"), "saleDate");

  assert.equal(mapHistoricalHeader("الكمية"), "quantity");
  assert.equal(mapHistoricalHeader("Qty"), "quantity");

  assert.equal(mapHistoricalHeader("سعر الوحدة"), "unitPrice");
  assert.equal(mapHistoricalHeader("Price"), "unitPrice");

  assert.equal(mapHistoricalHeader("الإجمالي"), "total");
  assert.equal(mapHistoricalHeader("Total"), "total");
  assert.equal(mapHistoricalHeader("Line Total"), "total");

  assert.equal(mapHistoricalHeader("طريقة الدفع"), "paymentMethod");
  assert.equal(mapHistoricalHeader("Payment Method"), "paymentMethod");
});

test("parseHistoricalNumber handles Arabic-Indic digits, commas, currencies", () => {
  assert.equal(parseHistoricalNumber("150.50"), 150.50);
  assert.equal(parseHistoricalNumber("١٥٠٫٥٠"), 150.50);
  assert.equal(parseHistoricalNumber("1,250.00 EGP"), 1250);
  assert.equal(parseHistoricalNumber("1250 ج.م"), 1250);
  assert.equal(parseHistoricalNumber("0"), 0);
  assert.equal(parseHistoricalNumber(""), null);
  assert.equal(parseHistoricalNumber("abc"), "invalid");
});

test("parseHistoricalDate handles various formats", () => {
  // DD-MM-YYYY
  const d1 = parseHistoricalDate("15-10-2025 09:30 AM");
  assert.deepEqual(d1, { saleDate: "2025-10-15", saleMonth: "2025-10", saleLocalDate: "15-10-2025 09:30 AM" });

  // YYYY-MM-DD
  const d2 = parseHistoricalDate("2025-10-15");
  assert.deepEqual(d2, { saleDate: "2025-10-15", saleMonth: "2025-10", saleLocalDate: "2025-10-15" });

  // DD/MM/YYYY
  const d3 = parseHistoricalDate("03/11/2026 14:00");
  assert.deepEqual(d3, { saleDate: "2026-11-03", saleMonth: "2026-11", saleLocalDate: "03/11/2026 14:00" });

  // Invalid date
  assert.equal(parseHistoricalDate("invalid-date-string-here"), null);
});

test("validateHistoricalSaleRow validates rows, computes fallbacks and captures errors", () => {
  // Valid row
  const row1 = validateHistoricalSaleRow({
    productName: "كابتشينو كبير",
    sku: "2467",
    invoiceNo: "INV-100",
    saleDate: "2025-10-15",
    quantity: 2,
    unitPrice: 75,
    total: 150,
    paymentMethod: "كاش",
  }, 1);

  assert.equal(row1.status, "ready");
  assert.equal(row1.errors.length, 0);
  assert.equal(row1.sku, "2467");
  assert.equal(row1.total, 150);
  assert.equal(row1.quantityUnit, "قطعة");

  // Row without SKU and without invoice: auto-generates fallbacks
  const row2 = validateHistoricalSaleRow({
    productName: "لاتيه كراميل",
    saleDate: "2025-11-01",
    quantity: 1,
    unitPrice: 80,
  }, 2);

  assert.equal(row2.status, "ready");
  assert.ok(row2.sku.startsWith("AUTO-"));
  assert.ok(row2.invoiceNo.startsWith("INV-2025-11-01"));
  assert.equal(row2.total, 80);

  // Row with missing product name and bad date
  const row3 = validateHistoricalSaleRow({
    quantity: -5,
    unitPrice: -10,
  }, 3);

  assert.equal(row3.status, "error");
  assert.ok(row3.errors.includes("اسم المنتج مفقود"));
  assert.ok(row3.errors.includes("تاريخ البيع غير صالح أو مفقود"));
  assert.ok(row3.errors.includes("الكمية غير صالحة"));
  assert.ok(row3.errors.includes("سعر الوحدة غير صالح"));
});

test("calculateHistoricalImportStats aggregates ready lines and computes statistics", () => {
  const rows = [
    validateHistoricalSaleRow({
      productName: "قهوة تركي",
      sku: "101",
      invoiceNo: "INV-1",
      saleDate: "2025-01-10",
      quantity: 2,
      unitPrice: 50,
      total: 100,
      paymentMethod: "كاش",
    }, 1),
    validateHistoricalSaleRow({
      productName: "شاي كرك",
      sku: "102",
      invoiceNo: "INV-2",
      saleDate: "2025-06-20",
      quantity: 1,
      unitPrice: 40,
      total: 40,
      paymentMethod: "فيزا",
    }, 2),
    validateHistoricalSaleRow({
      productName: "",
      saleDate: "invalid",
    }, 3),
  ];

  const stats = calculateHistoricalImportStats(rows);
  assert.equal(stats.total, 3);
  assert.equal(stats.ready, 2);
  assert.equal(stats.errors, 1);
  assert.equal(stats.totalRevenue, 140);
  assert.equal(stats.minDate, "2025-01-10");
  assert.equal(stats.maxDate, "2025-06-20");
  assert.equal(stats.uniqueProducts, 2);
  assert.equal(stats.uniqueInvoices, 2);
  assert.deepEqual(stats.years, [2025]);
  assert.equal(stats.paymentMethods.length, 2);
});

test("Template headers and example rows are well-formed", () => {
  assert.ok(HISTORICAL_SALES_TEMPLATE_HEADERS.includes("اسم المنتج"));
  assert.ok(HISTORICAL_SALES_TEMPLATE_HEADERS.includes("تاريخ البيع"));
  assert.ok(HISTORICAL_SALES_TEMPLATE_HEADERS.includes("الإجمالي"));
  assert.ok(HISTORICAL_SALES_TEMPLATE_EXAMPLE_ROWS.length >= 3);
});

test("parseHistoricalDate handles Excel serial numbers", () => {
  // 45230 is approx 2023-10-31
  const d = parseHistoricalDate(45230);
  assert.ok(d !== null);
  assert.match(d.saleDate, /^2023-\d{2}-\d{2}$/);
  assert.match(d.saleMonth, /^2023-\d{2}$/);
});

test("validateHistoricalSaleRow calculates unit price from total when price is 0", () => {
  const row = validateHistoricalSaleRow({
    productName: "مشروب خاص",
    saleDate: "2025-05-10",
    quantity: 2,
    unitPrice: 0,
    total: 100,
  }, 1);

  assert.equal(row.status, "ready");
  assert.equal(row.unitPrice, 50);
  assert.equal(row.total, 100);
});

test("mapHistoricalRowHeaders handles mixed casing and Arabic synonyms", () => {
  const raw = {
    "  اسم المنتج  ": "كرواسون شوكولاتة",
    "SKU / كود": "5501",
    "QTY": "3",
    "السعر": "45.00",
    "تاريخ الفاتورة": "2025-08-12 11:30",
    "طريقة السداد": "فيزا بنك مصر",
  };

  const mapped = mapHistoricalRowHeaders(raw);
  assert.equal(mapped.productName, "كرواسون شوكولاتة");
  assert.equal(mapped.sku, "5501");
  assert.equal(mapped.quantity, "3");
  assert.equal(mapped.unitPrice, "45.00");
  assert.equal(mapped.saleDate, "2025-08-12 11:30");
  assert.equal(mapped.paymentMethod, "فيزا بنك مصر");
});
