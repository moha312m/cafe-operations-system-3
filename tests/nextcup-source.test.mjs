import test from "node:test";
import assert from "node:assert/strict";
import { parseProducts, parseSales, reconcileRecipes, recipeIngredientLines } from "../scripts/nextcup-source.mjs";

test("product import preserves leading-zero SKU and rejects spreadsheet controls", () => {
  const rows = [
    ["Products - Next Cup"],
    [null, "Product image", "Action", "Product", "Business Location", "Unit Purchase Price", "Selling Price", "Current stock", "Product Type", "Category", "Brand", "Tax", "SKU"],
    [null, null, null, "cups", "Next Cup", 0, 75, 0, "Single", "Additions", null, null, "0001"],
    [null, null, null, "Toolbar text", "", "", "Toolbar", "", "Toolbar", "Toolbar", "", "", "Toolbar"],
  ];
  const parsed = parseProducts(rows);
  assert.equal(parsed.products[0].sku, "0001");
  assert.equal(parsed.products.length, 1);
  assert.deepEqual(parsed.rejected.map(row => row.row), [4]);
});

test("sales import preserves line evidence and rejects altered footer totals", () => {
  const header = ["Product", "SKU", "Customer name", "Contact ID", "Contact Number", "Email", "Invoice No.", "Date", "Location", "Quantity", "Unit Price", "Discount", "Tax", "Price inc. tax", "Total", "Payment Method"];
  const line = ["Small Water", "2580", "Walk-In Customer", "CO0001", "", "", "16117", "01-10-2026 10:40 AM", "Next Cup", "1.00 Pc(s)", "10.00", "0.00", "0.00()", "10.00", "10.00", "Cash"];
  const footer = ["Total:", "Total:", "Total:", "Total:", "Total:", "Total:", "Total:", "Total:", "Total:", "1.00 Pc(s)", "", "", ": 0.00", "", "10.00", ""];
  const parsed = parseSales([header, line, footer]);
  assert.equal(parsed.sales.length, 1);
  assert.equal(parsed.sales[0].saleDate, "2026-10-01");
  assert.equal(parsed.sales[0].invoiceNo, "16117");
  assert.throws(() => parseSales([header, line, [...footer.slice(0, 14), "11.00", ""]]), /total mismatch/i);
});

test("recipe reconciliation never treats a conflicting SKU as a match", () => {
  const products = [{ sku: "2548", name: "Guava" }, { sku: "9999", name: "Red Bull Mix" }];
  const recipes = [["SKU", "Product_Name", "Category", "Size", "Ingredients", "Packaging", "Prep_Notes", "Status"],
    ["2548", "Red Bull Mix", "Juice", "14 oz", "Red Bull: 1 can", "Cup: 1", "", "Active"]];
  const [row] = reconcileRecipes(recipes, products);
  assert.equal(row.skuMatchesName, false);
  assert.equal(row.matchedProductSku, "9999");
  assert.equal(row.skuProductName, "Guava");
});

test("recipe ingredient lines preserve cappuccino and latte portions without fixing optional choices", () => {
  const cappuccino = recipeIngredientLines({
    productName: "Cappuccino (M)",
    ingredients: "Espresso Beans: 18g (Double Shot), Steamed Milk: 150ml (with dense froth)",
    packaging: "8oz Hot Cup + Lid: 1 Unit",
  });
  assert.deepEqual(cappuccino, { lines: [
    { name: "Espresso Beans", quantity: 18, unit: "GRAM" },
    { name: "Milk", quantity: 150, unit: "ML" },
    { name: "8oz Hot Cup + Lid", quantity: 1, unit: "PIECE" },
  ], skipped: [] });
  const turkish = recipeIngredientLines({
    productName: "Turkish Coffee (S)",
    ingredients: "Turkish Coffee Powder: 8g, Water: 60ml, Sugar: Optional (0-15g)",
    packaging: "4oz Hot Cup + Lid: 1 Unit",
  });
  assert.equal(turkish.lines.length, 3);
  assert.deepEqual(turkish.skipped, ["Sugar: Optional (0-15g)"]);
  const icedCappuccino = recipeIngredientLines({
    productName: "Iced Cappuccino",
    ingredients: "Espresso Beans: 18g, Fresh Milk: 150ml, Cold Milk Foam: 40ml, Ice: 150g",
    packaging: "14oz Clear Cold Cup + Flat/Dome Lid + Straw",
  });
  assert.ok(icedCappuccino.lines.some(line => line.name === "Milk" && line.unit === "ML" && line.quantity === 190));
});
