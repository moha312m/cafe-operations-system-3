import { NextResponse, type NextRequest } from "next/server";
import * as XLSX from "xlsx";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { handleApiError, resolveCafeId } from "@/lib/api";
import { requireRecipeCafe } from "@/lib/recipe-access";
import { exportedRecipeRows, recipeCatalog, RECIPE_COLUMNS } from "@/lib/recipe-import";
export async function GET(request: NextRequest) {
  try {
    const session = await requireRecipeCafe();
    const cafeId = resolveCafeId(session, request.nextUrl.searchParams.get("cafeId"));
    const template = request.nextUrl.searchParams.get("template") === "1";
    const catalog = await db.$transaction(tx => recipeCatalog(tx, cafeId), { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
    const book = XLSX.utils.book_new();
    const rows: Record<string, unknown>[] = template ? [...catalog.products.flatMap(p => [
      { scope: "PRODUCT_DEFAULT", productId: p.id, productName: p.name, appliesToAllVariants: false, notApplicable: false },
      ...p.variants.map(v => ({ scope: "VARIANT", productId: p.id, productName: p.name, variantId: v.id, variantName: v.name, appliesToAllVariants: false, notApplicable: false })),
    ]), ...catalog.addOns.map(a => ({ scope: "ADDON", addOnId: a.id, addOnName: a.name, appliesToAllVariants: false, notApplicable: false }))] : exportedRecipeRows(catalog);
    const sheet = XLSX.utils.json_to_sheet(rows, { header: [...RECIPE_COLUMNS] });
    sheet["!cols"] = RECIPE_COLUMNS.map(k => ({ wch: k.endsWith("Id") ? 28 : 24 }));
    XLSX.utils.book_append_sheet(book, sheet, "Recipes");
    XLSX.utils.book_append_sheet(book, XLSX.utils.json_to_sheet(catalog.ingredients.map(i => ({ inventoryItemId: i.id, ingredientName: i.name, ingredientBranchId: i.branchId, ingredientBranchName: catalog.branches.find(b => b.id === i.branchId)?.name ?? "", storageUnit: i.unit, active: i.isActive && !i.archivedAt }))), "Ingredients");
    XLSX.utils.book_append_sheet(book, XLSX.utils.json_to_sheet(catalog.products.flatMap(p => [ { productId: p.id, productName: p.name, variantId: "", variantName: "", active: p.isActive }, ...p.variants.map(v => ({ productId: p.id, productName: p.name, variantId: v.id, variantName: v.name, active: p.isActive && v.isActive })) ])), "Products");
    XLSX.utils.book_append_sheet(book, XLSX.utils.json_to_sheet(catalog.addOns.map(a => ({ addOnId: a.id, addOnName: a.name, active: a.isActive }))), "AddOns");
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([
      ["تعليمات"],
      ["عدّل ورقة Recipes فقط. أوراق Ingredients وProducts وAddOns مراجع للمعرفات والأسماء."],
      ["الكمية لكل وحدة مباعة، ودقتها 3 منازل عشرية. الهدر من 0 إلى 100 بدقة منزلتين. أدخل القيم الفعلية ولا تخمّن الكميات."],
      ["الوحدات: GRAM, KG, ML, LITER, PIECE, BOX, BAG. اختر وحدة متوافقة مع وحدة تخزين المكون."],
      ["اختر PRODUCT_DEFAULT أو VARIANT أو ADDON. اسم ومعرف الحجم يجب أن يتبعا المنتج."],
      ["استخدم معرف المكون وفرعه. عند استخدام الاسم فقط يجب تحديد الفرع؛ الأسماء الملتبسة مرفوضة."],
      ["appliesToAllVariants وnotApplicable يقبلان true أو false. التعميم متاح للوصفة الافتراضية فقط."],
      ["إذا كانت notApplicable=true، اكتب السبب واترك المكون والفرع والكمية والوحدة والهدر فارغة."],
      ["احذف صفوف القالب التي لا تريد استيرادها. الصفوف الخالية من الكمية تحتاج إكمالًا ولا تنشئ وصفة بالتخمين."],
      ["الوصفات المتغيرة تحتاج تأكيدًا جديدًا. الوصفات غير المتغيرة تحتفظ بتأكيدها. الأسعار والتكاليف والمخزون لا تتغير."],
      ["استبدال الموجود يغيّر الوصفات الموجودة في الملف فقط؛ الجديد فقط يتجاوز الوصفات الموجودة."],
      ["التصدير يحتوي الوصفات المحفوظة الفعلية فقط؛ لا يكرر الوصفة الافتراضية لكل حجم."],
    ]), "Instructions");
    const bytes = new Uint8Array(XLSX.write(book, { type: "buffer", bookType: "xlsx" }));
    return new NextResponse(bytes, { headers: { "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "Content-Disposition": 'attachment; filename="recipes-' + (template ? 'template' : 'export') + '.xlsx"', "Cache-Control": "no-store" } });
  } catch (error) { return handleApiError(error); }
}
