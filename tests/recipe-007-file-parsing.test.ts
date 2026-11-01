// Real workbook/CSV parsing: ambiguous headers must never overwrite recipe values.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as XLSX from "xlsx";
import { parseRecipeFile } from "@/lib/recipe-file";

const columns = ["scope", "productId", "productName", "inventoryItemId", "ingredientName", "ingredientBranchId", "ingredientBranchName", "quantity", "unit", "wastePercentage", "appliesToAllVariants", "notApplicable"];
// These are explicit test quantities, not values inferred by the importer.
const values: Array<string | number | boolean> = ["PRODUCT_DEFAULT", "product-one", "قهوة عربية", "ingredient-one", "بن محمص", "branch-one", "فرع النيل", 18.125, "GRAM", 2.5, false, false];
function workbook(headers: string[], row: Array<string | number | boolean>, referencesFirst = false): ArrayBuffer {
  const book = XLSX.utils.book_new();
  if (referencesFirst) XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([["ingredientName"], ["مرجع فقط"]]), "Ingredients");
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([headers, row]), "Recipes");
  return XLSX.write(book, { bookType: "xlsx", type: "array" }) as ArrayBuffer;
}
function csv(headers: string[], row: Array<string | number | boolean>): ArrayBuffer {
  const quote = (value: string | number | boolean) => '"' + String(typeof value === "boolean" ? value ? "TRUE" : "FALSE" : value).replaceAll('"', '""') + '"';
  const contents = headers.map(quote).join(",") + "\r\n" + row.map(quote).join(",") + "\r\n";
  return new TextEncoder().encode(contents).buffer as ArrayBuffer; // Intentionally UTF-8 without a BOM.
}
for (const [format, encode] of [["XLSX", workbook], ["CSV", csv]] as const) {
  test(format + " preserves lexical SKU identity including leading zeros", () => {
    for (const sku of ["00123", "123", "1E10", "2026-10-09"]) {
      assert.equal(parseRecipeFile(encode([...columns, "productSku"], [...values, sku]))[0].productSku, sku);
    }
  });
  test(format + " canonicalizes product SKU and refuses duplicate SKU headers", () => {
    assert.equal(parseRecipeFile(encode([...columns, " PRODUCTSKU "], [...values, "SKU-ONE"]))[0].productSku, "SKU-ONE");
    assert.throws(() => parseRecipeFile(encode([...columns, "productSku", " PRODUCTSKU "], [...values, "SKU-ONE", "SKU-TWO"])));
  });
  for (const [field, competingHeader, competingValue] of [
    ["quantity", "quantity", 99.999],
    ["quantity", " Quantity ", 99.999],
    ["inventoryItemId", "inventoryItemId", "ingredient-two"],
    ["inventoryItemId", " INVENTORYITEMID ", "ingredient-two"],
  ] as const) {
    test(format + " rejects conflicting " + field + " headers " + JSON.stringify(competingHeader) + " before overwriting values", () => {
      const bytes = encode([...columns, competingHeader], [...values, competingValue]);
      assert.throws(() => parseRecipeFile(bytes), "duplicate canonical or exact headers must be rejected before row mapping");
    });
  }
}
function assertValid(rows: ReturnType<typeof parseRecipeFile>) {
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.scope, "PRODUCT_DEFAULT");
  assert.equal(row.productId, "product-one");
  assert.equal(row.productName, "قهوة عربية");
  assert.equal(row.inventoryItemId, "ingredient-one");
  assert.equal(row.ingredientName, "بن محمص");
  assert.equal(row.ingredientBranchName, "فرع النيل");
  assert.equal(row.quantity, 18.125, "preserve the explicitly supplied three-decimal quantity");
  assert.equal(row.wastePercentage, 2.5);
  assert.equal(row.appliesToAllVariants, false, "explicit false must not become true or blank");
  assert.equal(row.notApplicable, false);
}
test("valid XLSX preserves Arabic names, explicit false and decimal quantity from Recipes rather than references", () => {
  assertValid(parseRecipeFile(workbook(columns, values, true)));
});
test("valid UTF-8 CSV without BOM preserves Arabic names, explicit false and decimal quantity", () => {
  assertValid(parseRecipeFile(csv(columns, values)));
});
