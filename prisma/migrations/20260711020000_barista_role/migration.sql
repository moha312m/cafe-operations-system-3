-- Rename the KITCHEN role to BARISTA (spec wording), preserving users.
CREATE TYPE "Role_new" AS ENUM ('SUPER_ADMIN', 'CAFE_OWNER', 'BRANCH_MANAGER', 'WAITER', 'CASHIER', 'BARISTA', 'INVENTORY_MANAGER');
ALTER TABLE "User" ALTER COLUMN "role" TYPE "Role_new"
  USING (
    CASE "role"::text
      WHEN 'KITCHEN' THEN 'BARISTA'
      ELSE "role"::text
    END
  )::"Role_new";
DROP TYPE "Role";
ALTER TYPE "Role_new" RENAME TO "Role";
