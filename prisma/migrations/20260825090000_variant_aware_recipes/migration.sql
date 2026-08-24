-- Variant-aware recipes, add-on recipes, and recipe verification.
--
-- The old ProductRecipeItem hung ingredients off a product and nothing else,
-- so every size of a drink deducted the same stock and reported the same
-- cost. Recipe/RecipeItem replaces it with a scope: a product default, a
-- specific variant, or an add-on.

CREATE TABLE "Recipe" (
  "id"                   TEXT NOT NULL,
  "cafeId"               TEXT NOT NULL,
  "productId"            TEXT,
  "variantId"            TEXT,
  "addOnId"              TEXT,
  "appliesToAllVariants" BOOLEAN NOT NULL DEFAULT false,
  "notApplicable"        BOOLEAN NOT NULL DEFAULT false,
  "notApplicableReason"  TEXT,
  "verifiedById"         TEXT,
  "verifiedAt"           TIMESTAMP(3),
  "verifiedFingerprint"  TEXT,
  "createdById"          TEXT,
  "updatedById"          TEXT,
  "createdAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"            TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Recipe_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RecipeItem" (
  "id"              TEXT NOT NULL,
  "recipeId"        TEXT NOT NULL,
  "inventoryItemId" TEXT NOT NULL,
  "quantity"        DECIMAL(12,3) NOT NULL,
  "unit"            "InventoryUnit" NOT NULL,
  "wastePercentage" DECIMAL(5,2) NOT NULL DEFAULT 0,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL,
  CONSTRAINT "RecipeItem_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Recipe_cafeId_idx"    ON "Recipe"("cafeId");
CREATE INDEX "Recipe_productId_idx" ON "Recipe"("productId");
CREATE INDEX "Recipe_variantId_idx" ON "Recipe"("variantId");
CREATE INDEX "Recipe_addOnId_idx"   ON "Recipe"("addOnId");
CREATE INDEX "RecipeItem_recipeId_idx"        ON "RecipeItem"("recipeId");
CREATE INDEX "RecipeItem_inventoryItemId_idx" ON "RecipeItem"("inventoryItemId");

CREATE UNIQUE INDEX "RecipeItem_recipeId_inventoryItemId_key"
  ON "RecipeItem"("recipeId", "inventoryItemId");

-- A plain UNIQUE(productId, variantId) would NOT stop two product-level rows:
-- PostgreSQL treats each NULL as distinct, so ("p1", NULL) and ("p1", NULL)
-- would both be accepted and the product would have two conflicting default
-- recipes. Partial indexes state each rule explicitly instead.
CREATE UNIQUE INDEX "Recipe_product_default_key"
  ON "Recipe"("productId")
  WHERE "variantId" IS NULL AND "addOnId" IS NULL AND "productId" IS NOT NULL;

CREATE UNIQUE INDEX "Recipe_product_variant_key"
  ON "Recipe"("productId", "variantId")
  WHERE "variantId" IS NOT NULL;

CREATE UNIQUE INDEX "Recipe_addon_key"
  ON "Recipe"("addOnId")
  WHERE "addOnId" IS NOT NULL;

-- Exactly one scope, always. A row targeting nothing (or two things at once)
-- has no determinate meaning and must not exist.
ALTER TABLE "Recipe" ADD CONSTRAINT "Recipe_single_scope_check" CHECK (
  ("productId" IS NOT NULL AND "addOnId" IS NULL)
  OR
  ("productId" IS NULL AND "variantId" IS NULL AND "addOnId" IS NOT NULL)
);

ALTER TABLE "Recipe" ADD CONSTRAINT "Recipe_cafeId_fkey"
  FOREIGN KEY ("cafeId") REFERENCES "Cafe"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Recipe" ADD CONSTRAINT "Recipe_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Recipe" ADD CONSTRAINT "Recipe_variantId_fkey"
  FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Recipe" ADD CONSTRAINT "Recipe_addOnId_fkey"
  FOREIGN KEY ("addOnId") REFERENCES "AddOn"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Recipe" ADD CONSTRAINT "Recipe_verifiedById_fkey"
  FOREIGN KEY ("verifiedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "RecipeItem" ADD CONSTRAINT "RecipeItem_recipeId_fkey"
  FOREIGN KEY ("recipeId") REFERENCES "Recipe"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RecipeItem" ADD CONSTRAINT "RecipeItem_inventoryItemId_fkey"
  FOREIGN KEY ("inventoryItemId") REFERENCES "InventoryItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── Carry the existing recipes across ────────────────────────────────
-- Every existing row becomes part of its product's DEFAULT recipe. It is
-- NOT marked as applying to variants and NOT marked verified: the old model
-- could not express per-size quantities, so nobody has ever stated that the
-- same preparation is right for a large as for a small. Claiming otherwise
-- here would manufacture confidence that was never given.
INSERT INTO "Recipe" ("id", "cafeId", "productId", "createdAt", "updatedAt")
SELECT
  'mig_' || p."id",
  p."cafeId",
  p."id",
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "Product" p
WHERE EXISTS (SELECT 1 FROM "ProductRecipeItem" pri WHERE pri."productId" = p."id");

INSERT INTO "RecipeItem" ("id", "recipeId", "inventoryItemId", "quantity", "unit", "wastePercentage", "createdAt", "updatedAt")
SELECT
  'migi_' || pri."id",
  'mig_' || pri."productId",
  pri."inventoryItemId",
  pri."quantity",
  pri."unit",
  pri."wastePercentage",
  pri."createdAt",
  CURRENT_TIMESTAMP
FROM "ProductRecipeItem" pri;

DROP TABLE "ProductRecipeItem";
