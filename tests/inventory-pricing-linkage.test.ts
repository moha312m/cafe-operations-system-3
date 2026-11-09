import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  validateDirectSaleParams,
  getLinkedRecipes,
  getDirectSaleInfo,
  syncDirectSale,
  directSaleFingerprint,
} from "@/lib/inventory-pricing-linkage";
import { suggestPrice } from "@/lib/menu-pricing";
import { ApiError } from "@/lib/api";

describe("Inventory Menu Pricing Linkage", () => {
  describe("validateDirectSaleParams", () => {
    test("succeeds when isSoldDirectly is false, even if price/portion are empty", () => {
      assert.doesNotThrow(() => {
        validateDirectSaleParams({
          isSoldDirectly: false,
          unit: "GRAM",
          portionSize: null,
          sellingPrice: null,
        });
      });
      assert.doesNotThrow(() => {
        validateDirectSaleParams({
          isSoldDirectly: undefined,
          unit: "PIECE",
        });
      });
    });

    test("succeeds for valid PIECE item with selling price", () => {
      assert.doesNotThrow(() => {
        validateDirectSaleParams({
          isSoldDirectly: true,
          unit: "PIECE",
          sellingPrice: 25.5,
        });
      });
    });

    test("succeeds for valid GRAM item with portion size and selling price", () => {
      assert.doesNotThrow(() => {
        validateDirectSaleParams({
          isSoldDirectly: true,
          unit: "GRAM",
          portionSize: 80,
          sellingPrice: 35,
        });
      });
    });

    test("succeeds for valid ML item with portion size and selling price", () => {
      assert.doesNotThrow(() => {
        validateDirectSaleParams({
          isSoldDirectly: true,
          unit: "ML",
          portionSize: 250,
          sellingPrice: 15,
        });
      });
    });

    test("rejects missing or negative selling price when isSoldDirectly is true", () => {
      assert.throws(
        () => {
          validateDirectSaleParams({
            isSoldDirectly: true,
            unit: "PIECE",
            sellingPrice: undefined,
          });
        },
        (err: unknown) => err instanceof ApiError && err.status === 400
      );

      assert.throws(
        () => {
          validateDirectSaleParams({
            isSoldDirectly: true,
            unit: "PIECE",
            sellingPrice: -5,
          });
        },
        (err: unknown) => err instanceof ApiError && err.status === 400
      );

      assert.throws(
        () => {
          validateDirectSaleParams({
            isSoldDirectly: true,
            unit: "PIECE",
            sellingPrice: NaN,
          });
        },
        (err: unknown) => err instanceof ApiError && err.status === 400
      );
    });

    test("rejects missing, zero, or negative portion size for GRAM and ML", () => {
      // GRAM with missing portion
      assert.throws(
        () => {
          validateDirectSaleParams({
            isSoldDirectly: true,
            unit: "GRAM",
            sellingPrice: 50,
            portionSize: undefined,
          });
        },
        (err: unknown) =>
          err instanceof ApiError &&
          err.status === 400 &&
          err.message.includes("حجم الحصة")
      );

      // GRAM with zero portion
      assert.throws(
        () => {
          validateDirectSaleParams({
            isSoldDirectly: true,
            unit: "GRAM",
            sellingPrice: 50,
            portionSize: 0,
          });
        },
        (err: unknown) =>
          err instanceof ApiError &&
          err.status === 400 &&
          err.message.includes("حجم الحصة")
      );

      // ML with negative portion
      assert.throws(
        () => {
          validateDirectSaleParams({
            isSoldDirectly: true,
            unit: "ML",
            sellingPrice: 30,
            portionSize: -50,
          });
        },
        (err: unknown) =>
          err instanceof ApiError &&
          err.status === 400 &&
          err.message.includes("حجم الحصة")
      );
    });
  });

  describe("Quick Price Calculator math for portion costs", () => {
    test("calculates correct suggested price and margins for portion of raw material", () => {
      // Ice cream cost: 0.05 EGP per gram (50 EGP per kg)
      // Portion: 80 grams scoop -> portion cost = 4.00 EGP
      const costPerGram = 0.05;
      const portionGrams = 80;
      const portionCost = costPerGram * portionGrams; // 4.00 EGP

      // Multiplier 2.5 -> suggested price = 10.00 EGP
      const calc25 = suggestPrice(portionCost, 2.5);
      assert.equal(calc25.suggestedPrice.toNumber(), 10);
      assert.equal(calc25.profit.toNumber(), 6);
      assert.equal(calc25.margin.toNumber(), 60);
      assert.equal(calc25.tier, "high");

      // Multiplier 3.0 -> suggested price = 12.00 EGP
      const calc30 = suggestPrice(portionCost, 3.0);
      assert.equal(calc30.suggestedPrice.toNumber(), 12);
      assert.equal(calc30.profit.toNumber(), 8);
      assert.equal(calc30.margin.toNumber(), 66.67);
      assert.equal(calc30.tier, "high");
    });

    test("handles finished goods discrete piece pricing", () => {
      // Can of Cola cost: 12.50 EGP per piece
      const unitCost = 12.5;

      // Multiplier 2.0 with step 5 rounding
      const calc = suggestPrice(unitCost, 2.0, "NEAREST", 5);
      // 12.50 * 2 = 25.00
      assert.equal(calc.suggestedPrice.toNumber(), 25);
      assert.equal(calc.profit.toNumber(), 12.5);
      assert.equal(calc.margin.toNumber(), 50);
      assert.equal(calc.tier, "medium");
    });
  });

  describe("getLinkedRecipes mapping", () => {
    test("maps recipe items and extracts menu details cleanly, excluding direct sale item", async () => {
      const mockClient: any = {
        recipeItem: {
          findMany: async (args: any) => {
            assert.equal(args.where.inventoryItemId, "item-123");
            assert.equal(args.where.recipe.cafeId, "cafe-abc");
            assert.deepEqual(args.where.recipe.NOT, {
              verifiedFingerprint: directSaleFingerprint("item-123"),
            });
            return [
              {
                id: "ri-1",
                quantity: "120.000",
                unit: "GRAM",
                recipe: {
                  id: "rec-1",
                  product: {
                    id: "prod-1",
                    name: "ميلك شيك لوتس",
                    basePrice: "70.00",
                    category: { name: "ميلك شيك" },
                  },
                  variant: null,
                },
              },
              {
                id: "ri-2",
                quantity: "80.000",
                unit: "GRAM",
                recipe: {
                  id: "rec-2",
                  product: {
                    id: "prod-2",
                    name: "صنداي كراميل",
                    basePrice: "30.00",
                    category: { name: "آيس كريم" },
                  },
                  variant: {
                    id: "var-1",
                    name: "كبير",
                    price: "35.00",
                  },
                },
              },
            ];
          },
        },
      };

      const linked = await getLinkedRecipes(mockClient, "item-123", "cafe-abc");
      assert.equal(linked.length, 2);

      assert.equal(linked[0].id, "prod-1");
      assert.equal(linked[0].name, "ميلك شيك لوتس");
      assert.equal(linked[0].category, "ميلك شيك");
      assert.equal(linked[0].quantity, 120);
      assert.equal(linked[0].unit, "GRAM");
      assert.equal(linked[0].sellingPrice, 70);

      assert.equal(linked[1].id, "prod-2");
      assert.equal(linked[1].name, "صنداي كراميل (كبير)");
      assert.equal(linked[1].category, "آيس كريم");
      assert.equal(linked[1].quantity, 80);
      assert.equal(linked[1].unit, "GRAM");
      assert.equal(linked[1].sellingPrice, 35);
    });
  });

  describe("getDirectSaleInfo detection", () => {
    test("detects ProductStockBinding for finished goods (PIECE)", async () => {
      const mockClient: any = {
        productStockBinding: {
          findFirst: async () => ({
            id: "psb-1",
            productId: "prod-cola",
            product: {
              id: "prod-cola",
              basePrice: "25.00",
              categoryId: "cat-drinks",
            },
          }),
        },
      };

      const info = await getDirectSaleInfo(mockClient, "inv-cola", "cafe-abc");
      assert.equal(info.isSoldDirectly, true);
      assert.equal(info.productId, "prod-cola");
      assert.equal(info.sellingPrice, 25);
      assert.equal(info.menuCategoryId, "cat-drinks");
      assert.equal(info.portionSize, 1);
    });

    test("detects dedicated direct recipe by fingerprint for raw materials (GRAM/ML)", async () => {
      const mockClient: any = {
        productStockBinding: {
          findFirst: async () => null,
        },
        recipe: {
          findFirst: async (args: any) => {
            assert.equal(
              args.where.verifiedFingerprint,
              directSaleFingerprint("inv-icecream")
            );
            return {
              id: "rec-scoop",
              productId: "prod-scoop",
              product: {
                id: "prod-scoop",
                basePrice: "30.00",
                categoryId: "cat-desserts",
              },
              items: [
                {
                  id: "ri-scoop",
                  inventoryItemId: "inv-icecream",
                  quantity: "80.000",
                },
              ],
            };
          },
        },
      };

      const info = await getDirectSaleInfo(mockClient, "inv-icecream", "cafe-abc");
      assert.equal(info.isSoldDirectly, true);
      assert.equal(info.productId, "prod-scoop");
      assert.equal(info.sellingPrice, 30);
      assert.equal(info.menuCategoryId, "cat-desserts");
      assert.equal(info.portionSize, 80);
    });

    test("returns isSoldDirectly false when no binding or direct recipe exists", async () => {
      const mockClient: any = {
        productStockBinding: {
          findFirst: async () => null,
        },
        recipe: {
          findFirst: async () => null,
        },
      };

      const info = await getDirectSaleInfo(mockClient, "inv-milk", "cafe-abc");
      assert.equal(info.isSoldDirectly, false);
    });
  });

  describe("syncDirectSale atomic execution", () => {
    test("creates Product and ProductStockBinding for PIECE item", async () => {
      const createdProducts: any[] = [];
      const createdBindings: any[] = [];
      const deletedBindings: any[] = [];

      const mockTx: any = {
        menuCategory: {
          findFirst: async () => ({ id: "cat-softdrinks", name: "مشروبات" }),
        },
        productStockBinding: {
          findFirst: async () => null,
          deleteMany: async (args: any) => {
            deletedBindings.push(args);
          },
          create: async (args: any) => {
            createdBindings.push(args.data);
            return { id: "psb-created", ...args.data };
          },
        },
        product: {
          create: async (args: any) => {
            const row = { id: "prod-new-cola", ...args.data };
            createdProducts.push(row);
            return row;
          },
        },
      };

      await syncDirectSale(mockTx, {
        inventoryItemId: "inv-cola",
        cafeId: "cafe-1",
        branchId: "branch-1",
        name: "كانز كولا",
        unit: "PIECE",
        costPerUnit: 15,
        isSoldDirectly: true,
        sellingPrice: 30,
        portionSize: 1,
        menuCategoryId: "cat-softdrinks",
      });

      assert.equal(createdProducts.length, 1);
      assert.equal(createdProducts[0].name, "كانز كولا");
      assert.equal(createdProducts[0].stockMode, "FINISHED_GOOD");
      assert.equal(createdProducts[0].basePrice, 30);
      assert.equal(createdProducts[0].categoryId, "cat-softdrinks");

      assert.equal(createdBindings.length, 1);
      assert.equal(createdBindings[0].inventoryItemId, "inv-cola");
      assert.equal(createdBindings[0].productId, "prod-new-cola");
      assert.equal(createdBindings[0].unit, "PIECE");
    });

    test("creates Product with Recipe and fingerprint for portioned GRAM item", async () => {
      const createdProducts: any[] = [];
      const createdRecipes: any[] = [];

      const mockTx: any = {
        menuCategory: {
          findFirst: async () => ({ id: "cat-sweets", name: "حلويات" }),
        },
        recipe: {
          findFirst: async () => null,
          create: async (args: any) => {
            createdRecipes.push(args.data);
            return { id: "rec-new", ...args.data };
          },
        },
        product: {
          create: async (args: any) => {
            const row = { id: "prod-icecream-scoop", ...args.data };
            createdProducts.push(row);
            return row;
          },
        },
      };

      await syncDirectSale(mockTx, {
        inventoryItemId: "inv-icecream",
        cafeId: "cafe-1",
        branchId: "branch-1",
        name: "بولة آيس كريم",
        unit: "GRAM",
        costPerUnit: 0.05,
        isSoldDirectly: true,
        sellingPrice: 20,
        portionSize: 80,
        menuCategoryId: "cat-sweets",
      });

      assert.equal(createdProducts.length, 1);
      assert.equal(createdProducts[0].name, "بولة آيس كريم");
      assert.equal(createdProducts[0].stockMode, "RECIPE");
      assert.equal(createdProducts[0].basePrice, 20);

      assert.equal(createdRecipes.length, 1);
      assert.equal(createdRecipes[0].productId, "prod-icecream-scoop");
      assert.equal(
        createdRecipes[0].verifiedFingerprint,
        directSaleFingerprint("inv-icecream")
      );
      assert.equal(createdRecipes[0].items.create.quantity, 80);
      assert.equal(createdRecipes[0].items.create.unit, "GRAM");
    });

    test("does NOT corrupt or overwrite existing multi-ingredient recipes when syncing raw material", async () => {
      const updatedProducts: any[] = [];
      const createdProducts: any[] = [];
      const createdRecipes: any[] = [];

      // Existing multi-ingredient recipe (e.g. Lotus Milkshake) consuming this ingredient
      const mockTx: any = {
        menuCategory: {
          findFirst: async () => ({ id: "cat-shakes", name: "شيكات" }),
        },
        recipe: {
          // Look up for direct recipe ONLY queries verifiedFingerprint
          findFirst: async (args: any) => {
            assert.equal(
              args.where.verifiedFingerprint,
              directSaleFingerprint("inv-icecream")
            );
            return null; // No direct recipe exists yet, even though milkshake recipe exists!
          },
          create: async (args: any) => {
            createdRecipes.push(args.data);
            return { id: "rec-direct-icecream", ...args.data };
          },
        },
        product: {
          update: async (args: any) => {
            updatedProducts.push(args);
          },
          create: async (args: any) => {
            const row = { id: "prod-icecream-new", ...args.data };
            createdProducts.push(row);
            return row;
          },
        },
      };

      await syncDirectSale(mockTx, {
        inventoryItemId: "inv-icecream",
        cafeId: "cafe-1",
        branchId: "branch-1",
        name: "بولة آيس كريم فانيليا",
        unit: "GRAM",
        costPerUnit: 0.05,
        isSoldDirectly: true,
        sellingPrice: 25,
        portionSize: 80,
        menuCategoryId: "cat-shakes",
      });

      // Crucial assertion: Existing product (Lotus Milkshake) was NOT updated!
      assert.equal(updatedProducts.length, 0);
      // New product was created specifically for the direct sale item
      assert.equal(createdProducts.length, 1);
      assert.equal(createdProducts[0].name, "بولة آيس كريم فانيليا");
      assert.equal(createdRecipes.length, 1);
      assert.equal(
        createdRecipes[0].verifiedFingerprint,
        directSaleFingerprint("inv-icecream")
      );
    });

    test("unlinks direct sale without deleting unrelated 1-ingredient recipes", async () => {
      const deletedRecipes: any[] = [];
      const updatedProducts: any[] = [];

      const mockTx: any = {
        productStockBinding: {
          findMany: async () => [],
        },
        recipe: {
          findFirst: async (args: any) => {
            // Looking for dedicated direct sale recipe
            if (
              args.where.verifiedFingerprint ===
              directSaleFingerprint("inv-beans")
            ) {
              return {
                id: "rec-direct-beans",
                productId: "prod-beans-bag",
              };
            }
            return null;
          },
          delete: async (args: any) => {
            deletedRecipes.push(args);
          },
        },
        product: {
          updateMany: async (args: any) => {
            updatedProducts.push(args);
          },
        },
      };

      await syncDirectSale(mockTx, {
        inventoryItemId: "inv-beans",
        cafeId: "cafe-1",
        branchId: "branch-1",
        name: "حبوب بن",
        unit: "GRAM",
        costPerUnit: 0.5,
        isSoldDirectly: false,
      });

      // Only the dedicated direct sale recipe was deleted
      assert.equal(deletedRecipes.length, 1);
      assert.equal(deletedRecipes[0].where.id, "rec-direct-beans");
      assert.equal(updatedProducts.length, 1);
      assert.equal(updatedProducts[0].where.id, "prod-beans-bag");
      assert.deepEqual(updatedProducts[0].data, {
        isActive: false,
        isAvailable: false,
      });
    });

    test("unlinks PIECE bindings safely and respects other branch bindings", async () => {
      const deletedBindings: any[] = [];
      const updatedProducts: any[] = [];

      const mockTx: any = {
        productStockBinding: {
          findMany: async () => [{ id: "psb-branch1", productId: "prod-cola" }],
          deleteMany: async (args: any) => {
            deletedBindings.push(args);
          },
          // Another branch still has a binding for prod-cola!
          count: async (args: any) => {
            if (args.where.productId === "prod-cola") return 1;
            return 0;
          },
        },
        product: {
          updateMany: async (args: any) => {
            updatedProducts.push(args);
          },
        },
        recipe: {
          findFirst: async () => null,
        },
      };

      await syncDirectSale(mockTx, {
        inventoryItemId: "inv-cola-branch1",
        cafeId: "cafe-1",
        branchId: "branch-1",
        name: "كانز كولا",
        unit: "PIECE",
        costPerUnit: 15,
        isSoldDirectly: false,
      });

      assert.equal(deletedBindings.length, 1);
      // Because another branch still sells prod-cola (count === 1), prod-cola MUST NOT be deactivated!
      assert.equal(updatedProducts.length, 0);
    });
  });
});
