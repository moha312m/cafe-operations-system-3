-- Customer QR menu controls on products, public-menu settings on branches.

ALTER TABLE "Product" ADD COLUMN "showInCustomerMenu" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Product" ADD COLUMN "isAvailable" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Product" ADD COLUMN "sortOrder" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "Branch" ADD COLUMN "menuSlug" TEXT;
ALTER TABLE "Branch" ADD COLUMN "publicMenuEnabled" BOOLEAN NOT NULL DEFAULT true;

CREATE UNIQUE INDEX "Branch_cafeId_menuSlug_key" ON "Branch"("cafeId", "menuSlug");
