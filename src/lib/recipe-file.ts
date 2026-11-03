// Browser-compatible XLSX/CSV decoding; server validates identity and values.
import * as XLSX from "xlsx";
import { RECIPE_TEMPLATE_HEADERS, RECIPE_TEMPLATE_SLOTS } from "./recipe-template-columns";
export type RecipeFileRow = Record<string, string | number | boolean | null>;
const fields = ["exportBaseline", "recipeId", "scope", "productId", "productSku", "productName", "variantId", "variantName", "addOnId", "addOnName", "inventoryItemId", "ingredientName", "ingredientBranchId", "ingredientBranchName", "quantity", "unit", "wastePercentage", "appliesToAllVariants", "notApplicable", "notApplicableReason"];
export function parseRecipeFile(bytes: ArrayBuffer): RecipeFileRow[] {
  if (bytes.byteLength > 5 * 1024 * 1024) throw new Error("الحد الأقصى لحجم الملف 5 ميجابايت");
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
  if (range.e.r - range.s.r > 1000 || range.e.c >= RECIPE_TEMPLATE_HEADERS.length) throw new Error("تجاوز الملف حد الصفوف أو الأعمدة");
  if (isXlsx && Object.values(sheet).some(cell => cell && typeof cell === "object" && "f" in cell)) throw new Error("احذف الصيغ من ورقة الوصفات واستخدم القيم فقط");
  const headers = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1, raw: false, defval: "",
    range: { s: range.s, e: { r: range.s.r, c: range.e.c } },
  })[0] ?? [];
  if (isXlsx && String(headers[0]).trim() === "SKU") {
    if (!workbook.Sheets.Recipes) throw new Error("ورقة Recipes مطلوبة");
    if (range.s.r !== 0 || range.s.c !== 0 || RECIPE_TEMPLATE_HEADERS.slice(0, -1).some((name, index) => headers[index] !== name) ||
        (headers[RECIPE_TEMPLATE_HEADERS.length - 1] && headers[RECIPE_TEMPLATE_HEADERS.length - 1] !== "Export Baseline")) {
      throw new Error("عناوين قالب الوصفة غير مطابقة. استخدم قالبًا جديدًا.");
    }
    const cell = (r: number, c: number) => sheet[XLSX.utils.encode_cell({ r, c })];
    const value = (r: number, c: number) => cell(r, c)?.v ?? "";
    const rows: RecipeFileRow[] = [];
    const skus = new Set<string>();
    for (let r = 1; r <= range.e.r; r++) {
      const slots = Array.from({ length: RECIPE_TEMPLATE_SLOTS }, (_, index) => {
        const col = 2 + index * 3;
        return [value(r, col), value(r, col + 1), value(r, col + 2)];
      });
      if (slots.every(slot => slot.every(v => String(v).trim() === ""))) continue;
      const sku = value(r, 0);
      if (typeof sku !== "string" || !sku.trim()) throw new Error(`صف ${r + 1}: أدخل SKU كنص`);
      if (skus.has(sku.trim())) throw new Error(`صف ${r + 1}: SKU مكرر`);
      skus.add(sku.trim());
      slots.forEach(([ingredient, quantity, unit], index) => {
        if ([ingredient, quantity, unit].every(v => String(v).trim() === "")) return;
        const id = /\[([A-Za-z0-9_-]+)\]$/.exec(String(ingredient))?.[1] ?? "";
        rows.push({ excelRow: r + 1, excelSlot: index + 1, scope: "PRODUCT_DEFAULT",
          productSku: sku.trim(), inventoryItemId: id, quantity, unit, wastePercentage: 0,
          appliesToAllVariants: false, notApplicable: false,
          exportBaseline: String(value(r, RECIPE_TEMPLATE_HEADERS.length - 1)) });
      });
    }
    if (!rows.length || rows.length > 1000) throw new Error("اختر ملفًا يحتوي من 1 إلى 1000 مكون");
    return rows;
  }
  if (range.e.c - range.s.c >= 32) throw new Error("الحد 32 عمودًا");
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
  if (isXlsx && parsed.some(row => Object.entries(row).some(([key, value]) => key.trim().toLowerCase() === "productsku" && typeof value === "number"))) {
    throw new Error("عمود productSku يجب أن يكون نصًا للحفاظ على الأصفار في بداية الكود");
  }
  return parsed.map((row, index) => Object.fromEntries(Object.entries(row).map(([header, value]) => {
    const key = fields.find(k => k.toLowerCase() === header.trim().toLowerCase()) ?? header.trim();
    return [key, key === "productSku" ? String(lexical[index]?.[header] ?? "") : value];
  })) as RecipeFileRow);
}
