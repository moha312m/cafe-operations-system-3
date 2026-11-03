export const RECIPE_TEMPLATE_SLOTS = 12;
export const RECIPE_TEMPLATE_HEADERS = [
  "SKU", "Product Name",
  ...Array.from({ length: RECIPE_TEMPLATE_SLOTS }, (_, i) => [`Ingredient ${i + 1}`, `Qty ${i + 1}`, `Unit ${i + 1}`]).flat(),
  "Export Baseline",
];
