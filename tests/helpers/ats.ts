// Fixtures for the Available-to-Sell suites (ATS-001 … ATS-008).
//
// Every suite here owns its café outright, because availability is a fact
// about ONE branch's shelf and a suite that borrowed the seeded café would
// read whatever the last manual UAT left behind. `countCafe` already builds
// that café with two branches and five signed-in accounts, which is exactly
// what the tenancy and HTTP suites need; everything below is the menu and
// the shelf laid on top of it.
//
// Ingredient names are made unique per fixture on purpose. Recipes name
// café-level ingredients and stock lives on a BRANCH row matched by
// name+unit, so two fixtures sharing a name would silently alias onto one
// another's stock and make an availability assertion mean nothing.

import { db, tag } from "./db";
import { countCafe, type CountCafe } from "./count";
import type { InventoryUnit } from "@prisma/client";

export type AtsCafe = CountCafe & { categoryId: string };

export async function atsCafe(finding: string): Promise<AtsCafe> {
  const fx = await countCafe(finding);
  const category = await db.menuCategory.create({
    data: { cafeId: fx.cafeId, name: `${fx.marker} drinks` },
  });
  return { ...fx, categoryId: category.id };
}

export async function setMode(
  cafeId: string,
  mode: "STRICT" | "ALLOW_NEGATIVE_STOCK" | "OVERRIDE_ALL"
) {
  await db.cafeSettings.upsert({
    where: { cafeId },
    create: { cafeId, inventoryEnforcementMode: mode },
    update: { inventoryEnforcementMode: mode },
  });
}

let seq = 0;
/** Distinct per process, so branch matching (name+unit) can never alias. */
export const uniq = (s: string) => `${s}-${process.pid}-${(seq += 1)}`;

/** An ingredient stocked at a branch of this café. */
export async function ingredient(
  fx: AtsCafe,
  name: string,
  opts: {
    stock?: number;
    unit?: InventoryUnit;
    branchId?: string;
    cafeId?: string;
    costPerUnit?: number;
    isActive?: boolean;
  } = {}
) {
  return db.inventoryItem.create({
    data: {
      cafeId: opts.cafeId ?? fx.cafeId,
      branchId: opts.branchId ?? fx.branchId,
      name: `${fx.marker} ${uniq(name)}`,
      unit: opts.unit ?? "KG",
      // Deliberately explicit and non-zero: MISSING_COST must not touch
      // availability, and a fixture that left it at 0 would prove that by
      // accident rather than on purpose.
      costPerUnit: opts.costPerUnit ?? 120,
      currentStock: String(opts.stock ?? 0),
      isActive: opts.isActive ?? true,
    },
  });
}

/**
 * An ingredient the CAFÉ knows and the branch under test does not carry.
 *
 * Parked on the café's other branch so the row is real — this is the
 * "recipe is known, the shelf is not configured" case, which must not be
 * reported as an unreadable recipe.
 */
export async function unstockedIngredient(
  fx: AtsCafe,
  name: string,
  unit: InventoryUnit = "KG"
) {
  return db.inventoryItem.create({
    data: {
      cafeId: fx.cafeId,
      branchId: fx.otherBranchId,
      name: `${fx.marker} ${uniq(name)}`,
      unit,
      costPerUnit: 120,
      currentStock: "999",
    },
  });
}

export async function product(
  fx: AtsCafe,
  name: string,
  opts: { variants?: string[]; price?: number } = {}
) {
  return db.product.create({
    data: {
      cafeId: fx.cafeId,
      categoryId: fx.categoryId,
      name: `${fx.marker} ${uniq(name)}`,
      basePrice: String(opts.price ?? 90),
      ...(opts.variants
        ? {
            variants: {
              create: opts.variants.map((v, i) => ({
                name: v,
                price: 90 + i * 10,
                sortOrder: i,
              })),
            },
          }
        : {}),
    },
    include: { variants: { orderBy: { sortOrder: "asc" } } },
  });
}

export async function addOn(fx: AtsCafe, name: string, productId: string, price = 10) {
  const a = await db.addOn.create({
    data: { cafeId: fx.cafeId, name: `${fx.marker} ${uniq(name)}`, price: String(price) },
  });
  await db.productAddOn.create({ data: { productId, addOnId: a.id } });
  return a;
}

export type RecipeLine = { itemId: string; qty: string | number; unit?: InventoryUnit };

export async function recipe(
  fx: AtsCafe,
  scope: { productId?: string; variantId?: string; addOnId?: string },
  lines: RecipeLine[],
  opts: { notApplicable?: boolean; appliesToAllVariants?: boolean } = {}
) {
  return db.recipe.create({
    data: {
      cafeId: fx.cafeId,
      ...scope,
      notApplicable: opts.notApplicable ?? false,
      appliesToAllVariants: opts.appliesToAllVariants ?? false,
      items: {
        create: lines.map((l) => ({
          inventoryItemId: l.itemId,
          quantity: String(l.qty),
          unit: l.unit ?? "KG",
        })),
      },
    },
  });
}

/** Change a recipe's ingredient quantity, the way the owner's editor does. */
export async function setRecipeQuantity(
  recipeId: string,
  inventoryItemId: string,
  qty: string | number
) {
  await db.recipeItem.update({
    where: { recipeId_inventoryItemId: { recipeId, inventoryItemId } },
    data: { quantity: String(qty) },
  });
}

/**
 * An order written straight into the database, in whatever state the test
 * needs, WITHOUT going through the API.
 *
 * Used by the suites that are about what an EXISTING order does to
 * availability rather than about how one is created. `commitments` decides
 * whether it carries an inventory commitment snapshot; leaving it out is how
 * a legacy pre-feature open order is expressed.
 */
export async function rawOrder(
  fx: AtsCafe,
  opts: {
    status?:
      | "PENDING_WAITER_APPROVAL"
      | "CONFIRMED"
      | "PREPARING"
      | "READY"
      | "SERVED"
      | "CANCELLED";
    branchId?: string;
    cafeId?: string;
    items: {
      productId: string;
      variantId?: string | null;
      quantity: number;
      addOnIds?: string[];
    }[];
    commitments?: { inventoryItemId: string; quantity: number; unit?: InventoryUnit }[];
    committedAt?: Date | null;
  }
) {
  const branchId = opts.branchId ?? fx.branchId;
  const cafeId = opts.cafeId ?? fx.cafeId;
  const last = await db.order.aggregate({ where: { branchId }, _max: { orderNumber: true } });
  const products = await db.product.findMany({
    where: { id: { in: opts.items.map((i) => i.productId) } },
    include: { variants: true },
  });
  const byId = new Map(products.map((p) => [p.id, p]));

  const order = await db.order.create({
    data: {
      cafeId,
      branchId,
      orderNumber: (last._max.orderNumber ?? 0) + 1,
      type: "TAKEAWAY",
      status: opts.status ?? "CONFIRMED",
      source: "CASHIER_POS",
      customerName: fx.marker,
      subtotal: 0,
      taxAmount: 0,
      discountAmount: 0,
      serviceChargeAmount: 0,
      total: 0,
      remainingAmount: 0,
      paymentStatus: "PENDING_COLLECTION",
      inventoryEnforcementMode: "STRICT",
      ...(opts.committedAt !== undefined
        ? { inventoryCommittedAt: opts.committedAt }
        : opts.commitments
          ? { inventoryCommittedAt: new Date() }
          : {}),
      items: {
        create: opts.items.map((i) => {
          const p = byId.get(i.productId)!;
          const v = i.variantId ? p.variants.find((x) => x.id === i.variantId) : null;
          return {
            productId: i.productId,
            variantId: i.variantId ?? null,
            productName: p.name,
            variantName: v?.name ?? null,
            unitPrice: 0,
            quantity: i.quantity,
            lineTotal: 0,
            ...(i.addOnIds?.length
              ? {
                  addOns: {
                    create: i.addOnIds.map((id) => ({
                      addOnId: id,
                      addOnName: "add-on",
                      price: 0,
                    })),
                  },
                }
              : {}),
          };
        }),
      },
    },
  });

  if (opts.commitments?.length) {
    const rows = await db.inventoryItem.findMany({
      where: { id: { in: opts.commitments.map((c) => c.inventoryItemId) } },
      select: { id: true, unit: true },
    });
    const unitOf = new Map(rows.map((r) => [r.id, r.unit]));
    await db.orderInventoryCommitment.createMany({
      data: opts.commitments.map((c) => ({
        orderId: order.id,
        cafeId,
        branchId,
        inventoryItemId: c.inventoryItemId,
        quantity: String(c.quantity),
        unit: c.unit ?? unitOf.get(c.inventoryItemId) ?? "KG",
      })),
    });
  }
  return order;
}

/** A fresh marker, for suites that want a second scope inside one café. */
export const marker = (finding: string) => tag(finding);
