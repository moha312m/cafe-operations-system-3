// Server-side bounded recipe exchange. The workbook never writes catalog, prices or stock.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { InventoryUnit, Prisma } from "@prisma/client";
import { z } from "zod";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/api";
import { resolveAuthSecret } from "@/lib/auth";
import { auditInTransaction } from "@/lib/audit";
import { unitsCompatible } from "@/lib/costing";
import { recipeFingerprint } from "@/lib/recipes";

export const RECIPE_COLUMNS = ["recipeId", "scope", "productId", "productSku", "productName", "variantId", "variantName", "addOnId", "addOnName", "inventoryItemId", "ingredientName", "ingredientBranchId", "ingredientBranchName", "quantity", "unit", "wastePercentage", "appliesToAllVariants", "notApplicable", "notApplicableReason"] as const;
export const MAX_RECIPE_ROWS = 1000;
export const recipeImportSchema = z.object({
  rows: z.array(z.record(z.string().max(80), z.union([z.string().max(1000), z.number().finite(), z.boolean(), z.null()]))).min(1).max(MAX_RECIPE_ROWS),
  mode: z.enum(["replace", "new-only"]),
  cafeId: z.string().optional(),
  previewToken: z.string().max(3000).optional(),
  fileName: z.string().max(200).optional(),
});
export type RecipeImportInput = z.infer<typeof recipeImportSchema>;
type RawRow = RecipeImportInput["rows"][number];
type Connection = Prisma.TransactionClient;
export async function recipeCatalog(tx: Connection, cafeId: string) {
  const [products, addOns, ingredients, branches, recipes] = await Promise.all([
    tx.product.findMany({ where: { cafeId }, orderBy: { id: "asc" }, select: { id: true, sku: true, name: true, isActive: true, variants: { orderBy: { id: "asc" }, select: { id: true, name: true, isActive: true } } } }),
    tx.addOn.findMany({ where: { cafeId }, orderBy: { id: "asc" }, select: { id: true, name: true, isActive: true } }),
    tx.inventoryItem.findMany({ where: { cafeId }, orderBy: { id: "asc" }, select: { id: true, name: true, branchId: true, unit: true, isActive: true, archivedAt: true } }),
    tx.branch.findMany({ where: { cafeId }, orderBy: { id: "asc" }, select: { id: true, name: true, isActive: true } }),
    tx.recipe.findMany({ where: { cafeId }, orderBy: { id: "asc" }, include: { items: { orderBy: { inventoryItemId: "asc" } } } }),
  ]);
  return { products, addOns, ingredients, branches, recipes };
}
type Catalog = Awaited<ReturnType<typeof recipeCatalog>>;
type Recipe = Catalog["recipes"][number];
type Line = { inventoryItemId: string; quantity: number; unit: InventoryUnit; wastePercentage: number };
type Group = { key: string; scope: string; productId: string | null; variantId: string | null; addOnId: string | null; name: string; appliesToAllVariants: boolean; notApplicable: boolean; notApplicableReason: string | null; items: Line[]; rowIndexes: number[]; existing: Recipe | undefined };
const text = (value: unknown) => String(value ?? "").trim();
function bool(value: unknown, label: string, errors: string[]): boolean {
  const v = text(value).toLowerCase();
  if (["true", "1", "yes", "نعم"].includes(v)) return true;
  if (["false", "0", "no", "لا"].includes(v)) return false;
  errors.push(label + ": اكتب true أو false صراحة");
  return false;
}
function decimal(value: unknown, precision: number, minimum: number, maximum: number, label: string, errors: string[]) {
  const v = text(value).replace(/[٠-٩]/g, d => String("٠١٢٣٤٥٦٧٨٩".indexOf(d))).replace(/٫/g, ".");
  if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(v) || (v.split(".")[1]?.length ?? 0) > precision) {
    errors.push(label + ": قيمة رقمية مطلوبة بدقة لا تتجاوز " + precision); return 0;
  }
  const n = Number(v);
  if (!Number.isFinite(n) || n < minimum || n > maximum) errors.push(label + ": خارج النطاق المسموح");
  return n;
}
function resolve<T extends { id: string; name: string }>(entries: T[], id: unknown, name: unknown, label: string, errors: string[], required = true): T | undefined {
  const identity = text(id), title = text(name);
  if (!identity && !title) { if (required) errors.push(label + ": المعرف أو الاسم مطلوب"); return; }
  const matches = identity ? entries.filter(v => v.id === identity) : entries.filter(v => v.name === title);
  if (matches.length !== 1) { errors.push(label + ": غير موجود أو ملتبس داخل هذا الكافيه"); return; }
  const match = matches[0];
  if (title && match.name !== title) { errors.push(label + ": الاسم لا يطابق المعرف"); return; }
  return match;
}
function material(group: Pick<Group, "items" | "appliesToAllVariants" | "notApplicable" | "notApplicableReason">) {
  return recipeFingerprint(group.items, group) + "#na=" + group.notApplicable + "#reason=" + (group.notApplicableReason ?? "");
}
function changed(group: Group) { return !group.existing || material(group) !== material({ ...group.existing, items: group.existing.items.map(i => ({ inventoryItemId: i.inventoryItemId, quantity: Number(i.quantity), unit: i.unit, wastePercentage: Number(i.wastePercentage) })) }); }

export function validateRecipeImport(input: RecipeImportInput, catalog: Catalog) {
  const rows = input.rows.map((raw, index) => ({ rowNumber: index + 2, errors: [] as string[], raw }));
  const groups = new Map<string, Group>();
  for (const [index, row] of rows.entries()) {
    const r = row.raw, errors = row.errors, scope = text(r.scope);
    for (const key of Object.keys(r)) if (!(RECIPE_COLUMNS as readonly string[]).includes(key)) errors.push("عمود غير معروف: " + key);
    if (!["PRODUCT_DEFAULT", "VARIANT", "ADDON"].includes(scope)) errors.push("scope: اختر PRODUCT_DEFAULT أو VARIANT أو ADDON");
    const all = bool(r.appliesToAllVariants, "appliesToAllVariants", errors), na = bool(r.notApplicable, "notApplicable", errors);
    const reason = text(r.notApplicableReason) || null;
    let product: Catalog["products"][number] | undefined, variant: Catalog["products"][number]["variants"][number] | undefined, addon: Catalog["addOns"][number] | undefined;
    if (scope === "ADDON") {
      addon = resolve(catalog.addOns, r.addOnId, r.addOnName, "الإضافة", errors);
      if (text(r.productId) || text(r.productSku) || text(r.productName) || text(r.variantId) || text(r.variantName)) errors.push("وصفة الإضافة لا تقبل منتجًا أو حجمًا");
    } else {
      const sku = text(r.productSku);
      const skuProduct = sku ? catalog.products.find(p => p.sku === sku) : undefined;
      if (sku && !skuProduct) errors.push("المنتج: SKU غير موجود داخل هذا الكافيه");
      product = resolve(catalog.products, text(r.productId) || skuProduct?.id, r.productName, "المنتج", errors);
      if (sku && product && product.sku !== sku) errors.push("المنتج: SKU لا يطابق المعرف أو الاسم");
      if (text(r.addOnId) || text(r.addOnName)) errors.push("وصفة المنتج لا تقبل إضافة");
      if (scope === "VARIANT") variant = resolve(product?.variants ?? [], r.variantId, r.variantName, "الحجم التابع للمنتج", errors);
      else if (text(r.variantId) || text(r.variantName)) errors.push("الوصفة الافتراضية لا تقبل حجمًا");
    }
    if (all && scope !== "PRODUCT_DEFAULT") errors.push("تعميم الأحجام متاح للوصفة الافتراضية فقط");
    if (product && !product.isActive || variant && !variant.isActive || addon && !addon.isActive) errors.push("الصنف غير نشط");
    let line: Line | undefined;
    if (na) {
      if (!reason) errors.push("سبب عدم انطباق الوصفة مطلوب");
      if (["inventoryItemId", "ingredientName", "ingredientBranchId", "ingredientBranchName", "quantity", "unit", "wastePercentage"].some(k => text(r[k]))) errors.push("الوصفة غير المنطبقة لا تقبل مكونات أو كميات");
    } else {
      if (reason) errors.push("سبب عدم الانطباق يتطلب notApplicable=true");
      const branchProvided = !!(text(r.ingredientBranchId) || text(r.ingredientBranchName));
      const branch = branchProvided ? resolve(catalog.branches, r.ingredientBranchId, r.ingredientBranchName, "فرع المكون", errors) : undefined;
      if (!text(r.inventoryItemId) && !branchProvided) errors.push("فرع المكون مطلوب عند المطابقة بالاسم");
      const ingredient = resolve(branch ? catalog.ingredients.filter(i => i.branchId === branch.id) : catalog.ingredients, r.inventoryItemId, r.ingredientName, "المكون", errors);
      if (branch && !branch.isActive || ingredient && (!ingredient.isActive || ingredient.archivedAt)) errors.push("المكون أو فرعه غير نشط");
      if (ingredient && !catalog.branches.some(b => b.id === ingredient.branchId && b.isActive)) errors.push("فرع المكون غير نشط");
      const unit = text(r.unit) as InventoryUnit;
      if (!Object.values(InventoryUnit).includes(unit)) errors.push("وحدة المكون غير معروفة");
      else if (ingredient && !unitsCompatible(unit, ingredient.unit)) errors.push("الوحدة غير متوافقة مع وحدة تخزين المكون");
      const quantity = decimal(r.quantity, 3, 0.001, 999999999.999, "الكمية", errors);
      const wastePercentage = decimal(r.wastePercentage, 2, 0, 100, "الهدر", errors);
      if (ingredient) line = { inventoryItemId: ingredient.id, quantity, unit, wastePercentage };
    }
    const productId = product?.id ?? null, variantId = variant?.id ?? null, addOnId = addon?.id ?? null;
    const key = scope + ":" + (scope === "ADDON" ? addOnId : productId) + ":" + (variantId ?? "");
    const existingMatches = catalog.recipes.filter(r => r.productId === productId && r.variantId === variantId && r.addOnId === addOnId);
    if (existingMatches.length > 1) errors.push("نطاق الوصفة ملتبس");
    const existing = existingMatches[0];
    if (text(r.recipeId) && (!existing || existing.id !== text(r.recipeId))) errors.push("معرف الوصفة لا يطابق النطاق المحدد");
    const previous = groups.get(key);
    if (previous) {
      if (previous.appliesToAllVariants !== all || previous.notApplicable !== na || previous.notApplicableReason !== reason) errors.push("خصائص الوصفة متعارضة بين الصفوف");
      if (na || line && previous.items.some(i => i.inventoryItemId === line.inventoryItemId)) errors.push("صف مكرر داخل الوصفة");
      if (line) previous.items.push(line);
      previous.rowIndexes.push(index);
    } else {
      groups.set(key, { key, scope, productId, variantId, addOnId, name: addon?.name ?? [product?.name, variant?.name].filter(Boolean).join(" / "), appliesToAllVariants: all, notApplicable: na, notApplicableReason: reason, items: line ? [line] : [], rowIndexes: [index], existing });
    }
  }
  return { rows, groups: [...groups.values()] };
}
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    if ("toJSON" in value && typeof value.toJSON === "function") return stable(value.toJSON());
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, stable(v)]));
  }
  return value;
}
function digest(value: unknown) { return createHash("sha256").update(JSON.stringify(stable(value))).digest("hex"); }
function signature(payload: string) { return createHmac("sha256", resolveAuthSecret()).update("recipe-import-v1:" + payload).digest("base64url"); }
function makeToken(userId: string, cafeId: string, input: RecipeImportInput, catalog: Catalog) {
  const payload = Buffer.from(JSON.stringify({ userId, cafeId, mode: input.mode, rows: digest(input.rows), state: digest(catalog), expires: Date.now() + 15 * 60 * 1000 })).toString("base64url");
  return payload + "." + signature(payload);
}
function checkToken(userId: string, cafeId: string, input: RecipeImportInput, catalog: Catalog) {
  try {
    const [payload, supplied, extra] = (input.previewToken ?? "").split(".");
    const want = Buffer.from(signature(payload || "")), got = Buffer.from(supplied || "");
    if (extra || want.length !== got.length || !timingSafeEqual(want, got)) throw new Error();
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (data.userId !== userId || data.cafeId !== cafeId || data.mode !== input.mode || data.rows !== digest(input.rows) || !Number.isFinite(data.expires) || data.expires < Date.now()) throw new Error();
    if (data.state !== digest(catalog)) throw new ApiError(409, "تغيرت بيانات الوصفات أو المراجع؛ أعد المعاينة قبل الاستيراد");
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, "معاينة مفقودة أو منتهية أو لا تطابق الملف وطريقة الاستيراد");
  }
}
function previewShape(input: RecipeImportInput, catalog: Catalog, userId: string, cafeId: string) {
  const validated = validateRecipeImport(input, catalog);
  const errors = validated.rows.filter(r => r.errors.length > 0).length;
  return {
    rows: validated.rows.map(r => ({ rowNumber: r.rowNumber, errors: r.errors })),
    groups: validated.groups.map(g => ({ name: g.name, scope: g.scope, recipeId: g.existing?.id ?? null, action: g.rowIndexes.some(i => validated.rows[i].errors.length) ? "ERROR" : g.existing && input.mode === "new-only" ? "SKIP" : !changed(g) ? "UNCHANGED" : g.existing ? "REPLACE" : "CREATE", requiresConfirmation: !g.notApplicable && changed(g) })),
    stats: { total: input.rows.length, errors, recipes: validated.groups.length },
    previewToken: errors ? "" : makeToken(userId, cafeId, input, catalog),
  };
}
export async function previewRecipes(cafeId: string, userId: string, input: RecipeImportInput) {
  return db.$transaction(async tx => previewShape(input, await recipeCatalog(tx, cafeId), userId, cafeId), { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}
export async function importRecipes(cafeId: string, userId: string, input: RecipeImportInput) {
  try {
    return await db.$transaction(async tx => {
      const catalog = await recipeCatalog(tx, cafeId);
      checkToken(userId, cafeId, input, catalog);
      const { rows, groups } = validateRecipeImport(input, catalog);
      if (rows.some(r => r.errors.length)) throw new ApiError(400, "صحح كل أخطاء الملف قبل الاستيراد");
      const summary = { created: 0, replaced: 0, unchanged: 0, skipped: 0 };
      for (const group of groups) {
        if (group.existing && input.mode === "new-only") { summary.skipped++; continue; }
        if (!changed(group)) { summary.unchanged++; continue; }
        const data = { appliesToAllVariants: group.appliesToAllVariants, notApplicable: group.notApplicable, notApplicableReason: group.notApplicableReason, updatedById: userId, verifiedAt: null, verifiedById: null, verifiedFingerprint: null };
        let id: string;
        if (group.existing) {
          id = group.existing.id;
          // Parent updatedAt is an optimistic check as well as the serializable snapshot.
          const guarded = await tx.recipe.updateMany({ where: { id, updatedAt: group.existing.updatedAt }, data });
          if (guarded.count !== 1) throw new ApiError(409, "تغيرت الوصفة؛ أعد المعاينة");
          await tx.recipeItem.deleteMany({ where: { recipeId: id } });
          if (group.items.length) await tx.recipeItem.createMany({ data: group.items.map(i => ({ recipeId: id, ...i })) });
          summary.replaced++;
        } else {
          const created = await tx.recipe.create({ data: { cafeId, productId: group.productId, variantId: group.variantId, addOnId: group.addOnId, createdById: userId, ...data, items: { create: group.items } } });
          id = created.id; summary.created++;
        }
        await auditInTransaction(tx, { cafeId, userId, action: "RECIPE_IMPORTED", entity: "Recipe", entityId: id, details: { mode: input.mode, fileName: input.fileName ?? null, scope: group.scope, productId: group.productId, variantId: group.variantId, addOnId: group.addOnId, appliesToAllVariants: group.appliesToAllVariants, notApplicable: group.notApplicable, notApplicableReason: group.notApplicableReason, beforeItems: group.existing?.items.map(i => ({ inventoryItemId: i.inventoryItemId, quantity: Number(i.quantity), unit: i.unit, wastePercentage: Number(i.wastePercentage) })) ?? [], afterItems: group.items, invalidatedConfirmation: !!group.existing?.verifiedAt, before: group.existing ? material({ ...group.existing, items: group.existing.items.map(i => ({ inventoryItemId: i.inventoryItemId, quantity: Number(i.quantity), unit: i.unit, wastePercentage: Number(i.wastePercentage) })) }) : null, after: material(group) } });
      }
      return { summary };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 20000 });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && ["P2034", "P2002"].includes(error.code)) throw new ApiError(409, "تغيرت الوصفات أثناء الاستيراد؛ أعد المعاينة");
    throw error;
  }
}
export function exportedRecipeRows(catalog: Catalog): RawRow[] {
  return catalog.recipes.flatMap(recipe => {
    const product = catalog.products.find(p => p.id === recipe.productId), variant = product?.variants.find(v => v.id === recipe.variantId), addon = catalog.addOns.find(a => a.id === recipe.addOnId);
    const base: RawRow = { recipeId: recipe.id, scope: recipe.addOnId ? "ADDON" : recipe.variantId ? "VARIANT" : "PRODUCT_DEFAULT", productId: recipe.productId ?? "", productSku: product?.sku ?? "", productName: product?.name ?? "", variantId: recipe.variantId ?? "", variantName: variant?.name ?? "", addOnId: recipe.addOnId ?? "", addOnName: addon?.name ?? "", appliesToAllVariants: recipe.appliesToAllVariants, notApplicable: recipe.notApplicable, notApplicableReason: recipe.notApplicableReason ?? "" };
    if (!recipe.items.length) return [base];
    return recipe.items.map(item => {
      const ingredient = catalog.ingredients.find(i => i.id === item.inventoryItemId), branch = catalog.branches.find(b => b.id === ingredient?.branchId);
      return { ...base, inventoryItemId: item.inventoryItemId, ingredientName: ingredient?.name ?? "", ingredientBranchId: ingredient?.branchId ?? "", ingredientBranchName: branch?.name ?? "", quantity: Number(item.quantity), unit: item.unit, wastePercentage: Number(item.wastePercentage) };
    });
  });
}
