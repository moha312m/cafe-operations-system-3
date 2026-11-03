import { InventoryUnit } from "@prisma/client";
import { ApiError } from "@/lib/api";
import { exportBaseline, type Catalog } from "@/lib/recipe-import";
import { RECIPE_TEMPLATE_HEADERS, RECIPE_TEMPLATE_SLOTS } from "@/lib/recipe-template-columns";
import { buildXlsx, xlsxColumn, type XlsxCell } from "@/lib/xlsx";

export function buildRecipeTemplate(catalog: Catalog) {
  const ingredients = catalog.ingredients.filter(item => item.isActive && !item.archivedAt &&
    catalog.branches.some(branch => branch.id === item.branchId && branch.isActive));
  const ingredientLabels = new Map(ingredients.map(item => [
    item.id, `${item.name} — ${catalog.branches.find(branch => branch.id === item.branchId)?.name} [${item.id}]`,
  ]));
  const units = Object.values(InventoryUnit);
  const products = catalog.products.filter(product => product.isActive && product.isAvailable && product.stockMode === "RECIPE" && product.sku);
  if (products.length > 1000) throw new ApiError(400, "يتجاوز القالب 1000 صنف. استخدم التصدير المحدد للوصفات.");
  const rows: XlsxCell[][] = products.map(product => {
    const recipe = catalog.recipes.find(item => item.productId === product.id && !item.variantId && !item.addOnId);
    if ((recipe?.items.length ?? 0) > RECIPE_TEMPLATE_SLOTS) {
      throw new ApiError(400, `وصفة ${product.name} تتجاوز 12 مكونًا. استخدم ملف الوصفات التفصيلي.`);
    }
    const row: XlsxCell[] = [product.sku, product.name];
    for (const item of recipe?.items ?? []) {
      if (!ingredientLabels.has(item.inventoryItemId)) {
        throw new ApiError(400, `وصفة ${product.name} تحتوي مكونًا غير نشط. راجعها في شاشة الوصفات.`);
      }
      row.push(ingredientLabels.get(item.inventoryItemId), Number(item.quantity), item.unit);
    }
    row[RECIPE_TEMPLATE_HEADERS.length - 1] = recipe ? exportBaseline(recipe, recipe.cafeId) : "";
    return row;
  });
  const lists = Array.from({ length: RECIPE_TEMPLATE_SLOTS }, (_, index) => {
    const ingredient = xlsxColumn(2 + index * 3), unit = xlsxColumn(4 + index * 3);
    const end = Math.max(rows.length + 1, 2);
    return [{ range: `${ingredient}2:${ingredient}${end}`, name: "RecipeIngredients" },
      { range: `${unit}2:${unit}${end}`, name: "RecipeUnits" }];
  }).flat();
  return buildXlsx([
    { name: "Recipes", rows: [RECIPE_TEMPLATE_HEADERS, ...rows], headerRows: [0], readable: true,
      frozenColumns: 2, hiddenColumns: [RECIPE_TEMPLATE_HEADERS.length - 1], lists },
    { name: "Ingredients", rows: [["Ingredient", "Inventory Item ID", "Inventory Unit"], ...ingredients.map(item => [
      ingredientLabels.get(item.id), item.id, item.unit,
    ])], headerRows: [0], readable: true },
    { name: "Units", rows: [["Unit"], ...units.map(unit => [unit])], headerRows: [0], readable: true },
    { name: "Instructions", rows: [
      ["تعليمات قالب الوصفة"],
      ["كل صف يمثل SKU واحدًا ووصفته الافتراضية. استخدم التصدير التفصيلي للوصفات الخاصة بالأحجام والإضافات."],
      ["اختر المكون ووحدة إدخال الكمية من القوائم. اكتب كمية موجبة. احتفظ بكود SKU كنص."],
      ["اترك الصف فارغًا لتجاوزه. الاستبدال الصريح بعد المعاينة يحفظ قائمة المكونات الظاهرة في الصف."],
      ["مثال في هذه الورقة فقط: 0.25 KG يعادل 250 GRAM للخامات المقاسة بالوزن."],
    ], headerRows: [0], readable: true },
  ], { RecipeIngredients: `Ingredients!$A$2:$A$${Math.max(2, ingredients.length + 1)}`, RecipeUnits: `Units!$A$2:$A$${units.length + 1}` });
}
