import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import {
  requirePermission,
  resolveCafeId,
  handleApiError,
  ApiError,
  requireFeature,
} from "@/lib/api";
import { audit } from "@/lib/audit";
import {
  validateRow,
  groupRows,
  MAX_IMPORT_ROWS,
  type ImportMode,
  type RawImportRow,
  type ValidatedRow,
} from "@/lib/menu-import";

const bodySchema = z.object({
  rows: z.array(z.record(z.string(), z.unknown())).min(1, "الملف فارغ"),
  mode: z.enum(["create", "update", "upsert"]),
  fileName: z.string().max(200).default("menu-import"),
  ignoredRowNumbers: z.array(z.number().int()).default([]),
  cafeId: z.string().optional(), // super admin only
});

type FailedRow = { rowNumber: number; productName: string; reason: string };

// Performs the import. Everything is re-validated server-side — the
// preview response is never trusted, and cafeId always comes from the
// session (the uploaded file can never target another cafe).
export async function POST(request: NextRequest) {
  try {
    const session = await requirePermission("menu:manage");
    await requireFeature(session, "excelImportEnabled");
    const body = bodySchema.parse(await request.json());
    const cafeId = resolveCafeId(session, body.cafeId);
    const mode: ImportMode = body.mode;

    if (body.rows.length > MAX_IMPORT_ROWS) {
      throw new ApiError(400, `الحد الأقصى ${MAX_IMPORT_ROWS} صف في الملف الواحد`);
    }

    await audit({
      cafeId,
      userId: session.id,
      action: "MENU_IMPORT_STARTED",
      entity: "Cafe",
      entityId: cafeId,
      details: { fileName: body.fileName, importMode: mode, rows: body.rows.length },
    });

    // ── Validate ────────────────────────────────────────────────
    const branches = await db.branch.findMany({
      where: { cafeId },
      select: { id: true, name: true },
    });
    const branchIdByName = new Map(branches.map((b) => [b.name.trim(), b.id]));
    const ignored = new Set(body.ignoredRowNumbers);

    const failedRows: FailedRow[] = [];
    let skippedCount = 0;
    const validRows: ValidatedRow[] = [];

    body.rows.forEach((raw, i) => {
      const row = validateRow(raw as RawImportRow, i + 1);
      if (ignored.has(row.rowNumber)) {
        skippedCount++;
        return;
      }
      if (row.branchName && !branchIdByName.has(row.branchName)) {
        row.errors.push("الفرع غير موجود");
      }
      if (row.errors.length > 0) {
        failedRows.push({
          rowNumber: row.rowNumber,
          productName: row.productName || "—",
          reason: row.errors.join(" · "),
        });
        return;
      }
      validRows.push(row);
    });

    // ── Categories (create missing) ─────────────────────────────
    const categoryNames = [...new Set(validRows.map((r) => r.category))];
    const existingCategories = await db.menuCategory.findMany({
      where: { cafeId, name: { in: categoryNames } },
    });
    const categoryIdByName = new Map(existingCategories.map((c) => [c.name, c.id]));
    let newCategories = 0;
    for (const name of categoryNames) {
      if (!categoryIdByName.has(name)) {
        const created = await db.menuCategory.create({
          data: { cafeId, name, sortOrder: existingCategories.length + newCategories },
        });
        categoryIdByName.set(name, created.id);
        newCategories++;
      }
    }

    // ── Products (grouped rows) ─────────────────────────────────
    const groups = groupRows(validRows);
    let created = 0;
    let updated = 0;
    let newVariants = 0;
    let newAddOns = 0;
    const priceChanges: { productName: string; oldPrice: number; newPrice: number }[] = [];

    for (const group of groups) {
      const head = group.rows[0];
      const categoryId = categoryIdByName.get(group.category)!;
      const existing = await db.product.findFirst({
        where: { cafeId, name: group.productName, categoryId },
        include: { variants: true, addOns: { include: { addOn: true } } },
      });

      if (existing && mode === "create") {
        skippedCount += group.rows.length;
        continue;
      }
      if (!existing && mode === "update") {
        skippedCount += group.rows.length;
        continue;
      }

      // Collect variants / add-ons / branch prices from every row.
      const variantRows = group.rows.filter(
        (r) => r.variantName && r.variantPrice !== undefined
      );
      const addonRows = group.rows.filter(
        (r) => r.addonName && r.addonPrice !== undefined
      );
      const branchPriceRows = group.rows.filter((r) => r.branchName && r.price !== null);

      let productId: string;

      if (!existing) {
        const product = await db.product.create({
          data: {
            cafeId,
            categoryId,
            name: group.productName,
            description: head.description,
            basePrice: head.price!,
            costPrice: head.costPrice ?? null,
            imageUrl: head.imageUrl ?? null,
            isAvailable: head.isAvailable ?? true,
            showInCustomerMenu: head.showInCustomerMenu ?? true,
            showInPOS: head.showInPOS ?? true,
            sortOrder: head.sortOrder ?? 0,
            variants: {
              create: variantRows.map((r, i) => ({
                name: r.variantName!,
                price: r.variantPrice!,
                sortOrder: i,
              })),
            },
          },
        });
        productId = product.id;
        created++;
        newVariants += variantRows.length;
        await audit({
          cafeId,
          userId: session.id,
          action: "PRODUCT_CREATED_FROM_IMPORT",
          entity: "Product",
          entityId: productId,
          details: { name: group.productName, basePrice: head.price, fileName: body.fileName },
        });
      } else {
        productId = existing.id;
        const oldPrice = Number(existing.basePrice);
        await db.product.update({
          where: { id: existing.id },
          data: {
            description: head.description ?? undefined,
            basePrice: head.price!,
            costPrice: head.costPrice ?? undefined,
            imageUrl: head.imageUrl ?? undefined,
            isAvailable: head.isAvailable ?? undefined,
            showInCustomerMenu: head.showInCustomerMenu ?? undefined,
            showInPOS: head.showInPOS ?? undefined,
            sortOrder: head.sortOrder ?? undefined,
          },
        });
        // Upsert variants by name (never delete ones not in the file).
        for (const [i, r] of variantRows.entries()) {
          const match = existing.variants.find((v) => v.name === r.variantName);
          if (match) {
            await db.productVariant.update({
              where: { id: match.id },
              data: { price: r.variantPrice! },
            });
          } else {
            await db.productVariant.create({
              data: {
                productId: existing.id,
                name: r.variantName!,
                price: r.variantPrice!,
                sortOrder: existing.variants.length + i,
              },
            });
            newVariants++;
          }
        }
        updated++;
        if (head.price !== null && head.price !== oldPrice) {
          priceChanges.push({
            productName: group.productName,
            oldPrice,
            newPrice: head.price,
          });
          await audit({
            cafeId,
            userId: session.id,
            action: "PRODUCT_PRICE_CHANGED_FROM_IMPORT",
            entity: "Product",
            entityId: existing.id,
            details: {
              productName: group.productName,
              oldPrice,
              newPrice: head.price,
              currency: "EGP",
              fileName: body.fileName,
            },
          });
        }
        await audit({
          cafeId,
          userId: session.id,
          action: "PRODUCT_UPDATED_FROM_IMPORT",
          entity: "Product",
          entityId: existing.id,
          details: { name: group.productName, fileName: body.fileName },
        });
      }

      // Add-ons: ensure the cafe-level add-on exists (update its price
      // if it changed), then link it to the product.
      for (const r of addonRows) {
        let addOn = await db.addOn.findFirst({
          where: { cafeId, name: r.addonName! },
        });
        if (!addOn) {
          addOn = await db.addOn.create({
            data: { cafeId, name: r.addonName!, price: r.addonPrice! },
          });
          newAddOns++;
        } else if (Number(addOn.price) !== r.addonPrice) {
          await db.addOn.update({
            where: { id: addOn.id },
            data: { price: r.addonPrice! },
          });
        }
        await db.productAddOn.upsert({
          where: { productId_addOnId: { productId, addOnId: addOn.id } },
          create: { productId, addOnId: addOn.id },
          update: {},
        });
      }

      // Branch prices: upsert per named branch.
      for (const r of branchPriceRows) {
        const branchId = branchIdByName.get(r.branchName!)!;
        await db.productBranchPrice.upsert({
          where: { productId_branchId: { productId, branchId } },
          create: { productId, branchId, price: r.price! },
          update: { price: r.price! },
        });
      }
    }

    const summary = {
      createdProducts: created,
      updatedProducts: updated,
      newCategories,
      newVariants,
      newAddOns,
      skippedRows: skippedCount,
      failedRows: failedRows.length,
      priceChanges: priceChanges.length,
    };

    await audit({
      cafeId,
      userId: session.id,
      action: "MENU_IMPORT_COMPLETED",
      entity: "Cafe",
      entityId: cafeId,
      details: { fileName: body.fileName, importMode: mode, ...summary },
    });

    return NextResponse.json({ summary, failedRows });
  } catch (error) {
    return handleApiError(error);
  }
}
