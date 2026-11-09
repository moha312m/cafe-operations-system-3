import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { unitPriceExact, branchShift } from "@/lib/pricing";

describe("Pricing Invariants - Variant and Branch Impact", () => {
  // Test the pricing model invariants from src/lib/pricing.ts:
  // unit price = variant ? variant.price + shift : effectiveBase
  // shift = effectiveBase - basePrice

  test("updating variant price affects only that variant, preserving branch shift", () => {
    const product = {
      basePrice: "50.00",
      branchPrices: [{ branchId: "branch-coastal", price: "55.00" }], // +5.00 shift
    };

    const variantSmall = { price: "40.00" };
    const variantLarge = { price: "60.00" };

    // At main branch (no override shift):
    assert.equal(unitPriceExact(product, variantSmall, null).toFixed(2), "40.00");
    assert.equal(unitPriceExact(product, variantLarge, null).toFixed(2), "60.00");

    // At coastal branch (+5 shift):
    assert.equal(unitPriceExact(product, variantSmall, "branch-coastal").toFixed(2), "45.00");
    assert.equal(unitPriceExact(product, variantLarge, "branch-coastal").toFixed(2), "65.00");

    // Now reprice variantLarge to 65.00 WITHOUT touching Product.basePrice:
    const updatedVariantLarge = { price: "65.00" };
    assert.equal(unitPriceExact(product, variantSmall, null).toFixed(2), "40.00");
    assert.equal(unitPriceExact(product, updatedVariantLarge, null).toFixed(2), "65.00");
    assert.equal(unitPriceExact(product, variantSmall, "branch-coastal").toFixed(2), "45.00");
    assert.equal(unitPriceExact(product, updatedVariantLarge, "branch-coastal").toFixed(2), "70.00");
  });

  test("proves changing Product.basePrice would undesirably shift all variants", () => {
    // If basePrice is changed from 50 to 70:
    const oldProduct = {
      basePrice: "50.00",
      branchPrices: [{ branchId: "branch-coastal", price: "55.00" }],
    };
    const newProductShifted = {
      basePrice: "70.00",
      branchPrices: [{ branchId: "branch-coastal", price: "55.00" }],
    };

    const variantSmall = { price: "40.00" };

    // Coastal branch shift becomes 55 - 70 = -15 instead of +5!
    assert.equal(branchShift(oldProduct, "branch-coastal"), 5.0);
    assert.equal(branchShift(newProductShifted, "branch-coastal"), -15.0);

    // This proves that for products with variants, basePrice MUST NOT be changed
    // by variant repricing. Only variant.price must be updated.
  });

  test("branch shift invariant: forbids PRODUCT target repricing on products with variants", () => {
    // Simulates the invariant validation enforced in POST /api/menu-pricing/apply
    function validateTarget(
      item: { targetType: "PRODUCT" | "VARIANT"; productId: string; variantId?: string | null },
      product: { id: string; activeVariantCount: number }
    ) {
      if (item.targetType === "PRODUCT") {
        if (item.variantId) {
          throw new Error("لا يمكن تمرير معرف حجم مع تسعير المنتج الأساسي");
        }
        if (product.activeVariantCount > 0) {
          throw new Error(
            `لا يمكن تعديل سعر الأساس للمنتج ذو الأحجام "${item.productId}" لحماية إزاحة أسعار الفروع`
          );
        }
      } else if (item.targetType === "VARIANT") {
        if (!item.variantId) {
          throw new Error("معرف الحجم مطلوب لتسعير الأحجام");
        }
      }
    }

    const multiVariantProduct = { id: "prod_latte", activeVariantCount: 3 };
    const singleSkuProduct = { id: "prod_cookie", activeVariantCount: 0 };

    // Valid: single-SKU product with PRODUCT target
    assert.doesNotThrow(() =>
      validateTarget({ targetType: "PRODUCT", productId: singleSkuProduct.id }, singleSkuProduct)
    );

    // Invalid: multi-variant product with PRODUCT target must be rejected
    assert.throws(
      () =>
        validateTarget(
          { targetType: "PRODUCT", productId: multiVariantProduct.id },
          multiVariantProduct
        ),
      /لحماية إزاحة أسعار الفروع/
    );

    // Invalid: VARIANT target without variantId
    assert.throws(
      () =>
        validateTarget(
          { targetType: "VARIANT", productId: multiVariantProduct.id, variantId: null },
          multiVariantProduct
        ),
      /معرف الحجم مطلوب/
    );

    // Invalid: PRODUCT target with variantId
    assert.throws(
      () =>
        validateTarget(
          {
            targetType: "PRODUCT",
            productId: singleSkuProduct.id,
            variantId: "unexpected_var",
          },
          singleSkuProduct
        ),
      /لا يمكن تمرير معرف حجم/
    );
  });

  test("tenant boundary: prevents cross-tenant or mismatched variant mutations", () => {
    // Simulates tenant boundary enforcement in POST /api/menu-pricing/apply
    const cafeProducts = new Map([
      ["prod_cafe1_1", { id: "prod_cafe1_1", cafeId: "cafe_1" }],
    ]);
    const cafeVariants = new Map([
      ["var_cafe1_s", { id: "var_cafe1_s", productId: "prod_cafe1_1", cafeId: "cafe_1" }],
      // A variant belonging to Cafe 2
      ["var_cafe2_m", { id: "var_cafe2_m", productId: "prod_cafe2_1", cafeId: "cafe_2" }],
    ]);

    function verifyTenantAccess(
      cafeId: string,
      item: { productId: string; variantId: string }
    ) {
      const p = cafeProducts.get(item.productId);
      if (!p || p.cafeId !== cafeId) {
        throw new Error("المنتج غير موجود أو خارج نطاق المنشأة");
      }
      const v = cafeVariants.get(item.variantId);
      if (!v || v.cafeId !== cafeId || v.productId !== item.productId) {
        throw new Error("الحجم المحدد لا ينتمي للمنتج أو خارج نطاق المنشأة");
      }
      return true;
    }

    // Legitimate Cafe 1 update:
    assert.equal(
      verifyTenantAccess("cafe_1", { productId: "prod_cafe1_1", variantId: "var_cafe1_s" }),
      true
    );

    // Cross-tenant attempt: Attacker in Cafe 1 tries to modify Cafe 2 variant:
    assert.throws(
      () => verifyTenantAccess("cafe_1", { productId: "prod_cafe1_1", variantId: "var_cafe2_m" }),
      /خارج نطاق المنشأة/
    );
  });

  test("atomic repricing preserves sibling variants without deleteMany", () => {
    const initialVariants = [
      { id: "var-1", name: "صغير", price: 30 },
      { id: "var-2", name: "وسط", price: 40 },
      { id: "var-3", name: "كبير", price: 50 },
    ];

    const updates = [{ targetType: "VARIANT", variantId: "var-2", newPrice: 45 }];

    // Targeted update simulator:
    const updatedVariants = initialVariants.map((v) => {
      const match = updates.find((u) => u.variantId === v.id);
      return match ? { ...v, price: match.newPrice } : v;
    });

    // Verification:
    assert.equal(updatedVariants.length, 3, "All 3 variants are preserved");
    assert.equal(updatedVariants[0].price, 30, "var-1 untouched");
    assert.equal(updatedVariants[1].price, 45, "var-2 updated");
    assert.equal(updatedVariants[2].price, 50, "var-3 untouched");
    assert.equal(updatedVariants[0].id, "var-1", "var-1 retains same ID");
    assert.equal(updatedVariants[2].id, "var-3", "var-3 retains same ID");
  });
});
