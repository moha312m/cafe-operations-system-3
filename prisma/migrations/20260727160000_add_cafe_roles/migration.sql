-- Custom cafe roles & per-user permission overrides.

-- AlterTable
ALTER TABLE "User" ADD COLUMN "cafeRoleId" TEXT;

-- CreateTable
CREATE TABLE "CafeRole" (
    "id" TEXT NOT NULL,
    "cafeId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "description" TEXT,
    "isSystemDefault" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CafeRole_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CafeRolePermission" (
    "id" TEXT NOT NULL,
    "cafeRoleId" TEXT NOT NULL,
    "permissionKey" TEXT NOT NULL,
    "allowed" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CafeRolePermission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserPermissionOverride" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "permissionKey" TEXT NOT NULL,
    "allowed" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserPermissionOverride_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "User_cafeRoleId_idx" ON "User"("cafeRoleId");

-- CreateIndex
CREATE INDEX "CafeRole_cafeId_idx" ON "CafeRole"("cafeId");

-- CreateIndex
CREATE UNIQUE INDEX "CafeRole_cafeId_code_key" ON "CafeRole"("cafeId", "code");

-- CreateIndex
CREATE INDEX "CafeRolePermission_cafeRoleId_idx" ON "CafeRolePermission"("cafeRoleId");

-- CreateIndex
CREATE UNIQUE INDEX "CafeRolePermission_cafeRoleId_permissionKey_key" ON "CafeRolePermission"("cafeRoleId", "permissionKey");

-- CreateIndex
CREATE INDEX "UserPermissionOverride_userId_idx" ON "UserPermissionOverride"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "UserPermissionOverride_userId_permissionKey_key" ON "UserPermissionOverride"("userId", "permissionKey");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_cafeRoleId_fkey" FOREIGN KEY ("cafeRoleId") REFERENCES "CafeRole"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CafeRole" ADD CONSTRAINT "CafeRole_cafeId_fkey" FOREIGN KEY ("cafeId") REFERENCES "Cafe"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CafeRolePermission" ADD CONSTRAINT "CafeRolePermission_cafeRoleId_fkey" FOREIGN KEY ("cafeRoleId") REFERENCES "CafeRole"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserPermissionOverride" ADD CONSTRAINT "UserPermissionOverride_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
