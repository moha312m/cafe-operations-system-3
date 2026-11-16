import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import XLSX from "xlsx";

const text = (value) => String(value ?? "").trim();
const number = (value, field, row) => {
  const parsed = Number(text(value).replaceAll(",", ""));
  if (!Number.isFinite(parsed)) throw new Error(`Invalid ${field} at source row ${row}`);
  return parsed;
};

export function readRows(path) {
  const book = XLSX.readFile(path, { raw: true });
  if (book.SheetNames.length !== 1) throw new Error(`Expected one sheet in ${path}`);
  return XLSX.utils.sheet_to_json(book.Sheets[book.SheetNames[0]], { header: 1, defval: "", raw: true });
}

export function sourceHash(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function decodeName(value) {
  return text(value).replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replaceAll("&amp;", "&").replaceAll("&nbsp;", " ");
}

export function parseProducts(rows) {
  const header = rows.findIndex(row => row[3] === "Product" && row[12] === "SKU");
  if (header < 0) throw new Error("Product workbook header not found");
  const products = [];
  const rejected = [];
  const seen = new Set();
  for (let i = header + 1; i < rows.length; i++) {
    const row = rows[i];
    const name = decodeName(row[3]), sku = text(row[12]);
    if (!name && !sku) continue;
    if (!/^\d+$/.test(sku) || !name || row[8] !== "Single") {
      rejected.push({ row: i + 1, reason: "invalid product, SKU, or product type" });
      continue;
    }
    if (seen.has(sku)) throw new Error(`Duplicate product SKU ${sku}`);
    seen.add(sku);
    const price = number(row[6], "selling price", i + 1);
    if (price < 0) throw new Error(`Negative selling price at row ${i + 1}`);
    const category = decodeName(row[9]) || "Uncategorized";
    products.push({ sku, name, category, price, sourceRow: i + 1 });
  }
  return { products, rejected };
}

export function parseSales(rows) {
  const header = rows[0];
  if (header?.[0] !== "Product" || header?.[1] !== "SKU" || header?.[14] !== "Total") {
    throw new Error("Sales CSV header not recognized");
  }
  const sales = [];
  let footerTotal = null;
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (row[0] === "Total:" && row[1] === "Total:") {
      if (i !== rows.length - 1) throw new Error("Sales total is not the final row");
      footerTotal = number(row[14], "footer total", i + 1);
      continue;
    }
    const date = text(row[7]);
    const match = /^(\d{2})-(\d{2})-(\d{4}) (\d{2}):(\d{2}) (AM|PM)$/.exec(date);
    if (!match) throw new Error(`Invalid sale date at row ${i + 1}`);
    const [, day, month, year, hour, minute] = match;
    if (Number(month) < 1 || Number(month) > 12 || Number(day) < 1 || Number(day) > 31 || Number(hour) < 1 || Number(hour) > 12 || Number(minute) > 59) {
      throw new Error(`Out-of-range sale date at row ${i + 1}`);
    }
    const quantityMatch = /^(\d+(?:\.\d+)?)\s+(.+)$/.exec(text(row[9]));
    if (!quantityMatch) throw new Error(`Invalid quantity at row ${i + 1}`);
    const sku = text(row[1]);
    if (!/^\d+$/.test(sku)) throw new Error(`Invalid sale SKU at row ${i + 1}`);
    const taxMatch = /^-?\d+(?:\.\d+)?/.exec(text(row[12]));
    if (!taxMatch) throw new Error(`Invalid tax at row ${i + 1}`);
    sales.push({
      sourceRow: i + 1, sku, productName: text(row[0]), customerName: text(row[2]) || null,
      contactId: text(row[3]) || null, contactNumber: text(row[4]) || null, email: text(row[5]) || null,
      invoiceNo: text(row[6]), saleLocalDate: date, saleDate: `${year}-${month}-${day}`,
      saleMonth: `${year}-${month}`, location: text(row[8]) || null,
      quantity: number(quantityMatch[1], "quantity", i + 1), quantityUnit: quantityMatch[2],
      unitPrice: number(row[10], "unit price", i + 1), discount: number(row[11], "discount", i + 1),
      tax: number(taxMatch[0], "tax", i + 1), priceIncTax: number(row[13], "tax-inclusive price", i + 1),
      total: number(row[14], "total", i + 1), paymentMethod: text(row[15]) || null,
    });
  }
  if (footerTotal === null) throw new Error("Sales total footer missing");
  const summed = Math.round(sales.reduce((sum, sale) => sum + sale.total, 0) * 100) / 100;
  if (Math.abs(summed - footerTotal) > 0.001) throw new Error(`Sales total mismatch: ${summed} vs ${footerTotal}`);
  return { sales, footerTotal };
}

const normalizeName = value => text(value).toLocaleLowerCase("en").replace(/[^a-z0-9]+/g, "");

export function reconcileRecipes(rows, products) {
  const header = rows[0];
  if (header?.[0] !== "SKU" || header?.[1] !== "Product_Name") throw new Error("Recipe CSV header not recognized");
  const bySku = new Map(products.map(product => [product.sku, product]));
  const byName = new Map();
  for (const product of products) {
    const key = normalizeName(product.name);
    byName.set(key, [...(byName.get(key) ?? []), product]);
  }
  return rows.slice(1).filter(row => text(row[0])).map((row, index) => {
    const sku = text(row[0]), productName = text(row[1]);
    const skuProduct = bySku.get(sku);
    const nameMatches = byName.get(normalizeName(productName)) ?? [];
    return { sourceRow: index + 2, sku, productName, status: text(row[7]),
      ingredients: text(row[4]), packaging: text(row[5]), prepNotes: text(row[6]),
      skuProductName: skuProduct?.name ?? null,
      matchedProductSku: nameMatches.length === 1 ? nameMatches[0].sku : null,
      matchStatus: nameMatches.length === 1 ? "NAME_ONLY" : "UNMATCHED",
      skuMatchesName: Boolean(skuProduct && normalizeName(skuProduct.name) === normalizeName(productName)),
    };
  });
}

const canonicalIngredientName = (name) => {
  const normalized = text(name).toLowerCase();
  if (["steamed milk", "fresh milk", "cold milk foam", "milk foam"].includes(normalized)) return "Milk";
  return text(name);
};

/**
 * Converts the exact numeric portions in the provided BOM into stock rows.
 * Optional portions remain omitted rather than turning an unknown choice into
 * a fixed deduction. Packaging remains a single source-labelled item when the
 * export describes it as one combined set.
 */
export function recipeIngredientLines(recipe) {
  const lines = [];
  const skipped = [];
  for (const segment of recipe.ingredients.split(",").map(text).filter(Boolean)) {
    const match = /^(.+?):\s*(\d+(?:\.\d+)?)\s*(g|ml|pc|pcs|leaves)\b/i.exec(segment);
    if (!match) {
      skipped.push(segment);
      continue;
    }
    const [, rawName, rawQuantity, rawUnit] = match;
    const unit = /^g$/i.test(rawUnit) ? "GRAM" : /^ml$/i.test(rawUnit) ? "ML" : "PIECE";
    lines.push({ name: canonicalIngredientName(rawName), quantity: Number(rawQuantity), unit });
  }
  const packaging = text(recipe.packaging);
  if (packaging) {
    const explicit = /^(.+?):\s*(\d+(?:\.\d+)?)\s*Unit$/i.exec(packaging);
    lines.push({ name: explicit ? text(explicit[1]) : packaging, quantity: explicit ? Number(explicit[2]) : 1, unit: "PIECE" });
  }
  const combined = new Map();
  for (const line of lines) {
    const key = `${line.name}:${line.unit}`;
    const prior = combined.get(key);
    combined.set(key, prior ? { ...line, quantity: prior.quantity + line.quantity } : line);
  }
  return { lines: [...combined.values()], skipped };
}
