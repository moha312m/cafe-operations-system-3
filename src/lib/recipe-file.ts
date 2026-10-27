// Browser-compatible XLSX/CSV decoding; server validates identity and values.
import * as XLSX from "xlsx";
export type RecipeFileRow = Record<string, string | number | boolean | null>;
const fields = ["recipeId", "scope", "productId", "productSku", "productName", "variantId", "variantName", "addOnId", "addOnName", "inventoryItemId", "ingredientName", "ingredientBranchId", "ingredientBranchName", "quantity", "unit", "wastePercentage", "appliesToAllVariants", "notApplicable", "notApplicableReason"];
export function parseRecipeFile(bytes: ArrayBuffer): RecipeFileRow[] {
  const signature = new Uint8Array(bytes, 0, Math.min(bytes.byteLength, 4));
  const isXlsx = signature[0] === 0x50 && signature[1] === 0x4b && signature[2] === 0x03 && signature[3] === 0x04;
  const csvText = isXlsx ? null : new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  // XLSX is a ZIP container; CSV bytes need explicit UTF-8 decoding because
  // SheetJS otherwise treats BOM-less array input as legacy single-byte text.
  const workbook = isXlsx
    ? XLSX.read(bytes, { type: "array" })
    : XLSX.read(csvText!, { type: "string" });
  const sheet = workbook.Sheets[workbook.SheetNames.includes("Recipes") ? "Recipes" : workbook.SheetNames[0]];
  if (!sheet) throw new Error("الملف لا يحتوي ورقة وصفات");
  const range = XLSX.utils.decode_range(sheet["!ref"] ?? "A1");
  const headers = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1, raw: false, defval: "",
    range: { s: range.s, e: { r: range.s.r, c: range.e.c } },
  })[0] ?? [];
  const seen = new Set<string>();
  // Inspect original cells before sheet_to_json renames exact duplicates and
  // before canonical mapping can overwrite quantity or identity columns.
  for (const header of headers) {
    const key = String(header).trim().toLowerCase();
    if (!key) continue;
    if (seen.has(key)) throw new Error("عمود مكرر بعد توحيد الاسم: " + String(header).trim());
    seen.add(key);
  }
  const parsed = XLSX.utils.sheet_to_json<RecipeFileRow>(sheet, { defval: "" });
  if (!parsed.length || parsed.length > 1000) throw new Error("اختر ملفًا يحتوي من 1 إلى 1000 صف");
  // SKU is an identifier: CSV numeric/date inference must not change it.
  // Keep existing numeric/boolean decoding for the recipe's measured values.
  const lexical = csvText === null ? parsed : (() => {
    const raw = XLSX.read(csvText, { type: "string", raw: true });
    return XLSX.utils.sheet_to_json<RecipeFileRow>(raw.Sheets[raw.SheetNames[0]], { defval: "" });
  })();
  return parsed.map((row, index) => Object.fromEntries(Object.entries(row).map(([header, value]) => {
    const key = fields.find(k => k.toLowerCase() === header.trim().toLowerCase()) ?? header.trim();
    return [key, key === "productSku" ? String(lexical[index]?.[header] ?? "") : value];
  })) as RecipeFileRow);
}
