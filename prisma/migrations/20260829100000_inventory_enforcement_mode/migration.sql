-- Inventory & recipe enforcement policy, per café.
--
-- Replaces the `Cafe.allowNegativeStock` boolean, which could only answer
-- "may stock go below zero". Three behaviours are needed, and the one a
-- boolean cannot express is the important one: going below a balance we can
-- COMPUTE is a different risk from selling against a recipe nobody has
-- written. An owner may accept the first without the second.

CREATE TYPE "InventoryEnforcementMode" AS ENUM (
  'STRICT',
  'ALLOW_NEGATIVE_STOCK',
  'OVERRIDE_ALL'
);

-- The column default describes a NEW café: refuse what we cannot make.
ALTER TABLE "CafeSettings"
  ADD COLUMN "inventoryEnforcementMode" "InventoryEnforcementMode"
  NOT NULL DEFAULT 'STRICT';

-- Every EXISTING café keeps exactly the behaviour it already had. The column
-- default above applies only to rows inserted from now on; the rows that exist
-- at this moment are mapped from the boolean they were actually running under.
--
-- Note the direction of the join: the boolean lives on "Cafe" and the policy
-- now lives on "CafeSettings", so this reads across.
UPDATE "CafeSettings" s
   SET "inventoryEnforcementMode" = 'ALLOW_NEGATIVE_STOCK'
  FROM "Cafe" c
 WHERE c."id" = s."cafeId"
   AND c."allowNegativeStock" = true;

UPDATE "CafeSettings" s
   SET "inventoryEnforcementMode" = 'STRICT'
  FROM "Cafe" c
 WHERE c."id" = s."cafeId"
   AND c."allowNegativeStock" = false;

-- A café with no CafeSettings row has never expressed an opinion, so it gets
-- one at the safe end of the range rather than inheriting a permissive default.
-- "updatedAt" is supplied explicitly: Prisma manages it at the client
-- (@updatedAt), so the column is NOT NULL with no database-side default and an
-- INSERT that omits it fails. "createdAt" does carry a default.
INSERT INTO "CafeSettings" ("id", "cafeId", "inventoryEnforcementMode", "updatedAt")
SELECT gen_random_uuid()::text, c."id",
       CASE WHEN c."allowNegativeStock" THEN 'ALLOW_NEGATIVE_STOCK'::"InventoryEnforcementMode"
            ELSE 'STRICT'::"InventoryEnforcementMode" END,
       now()
  FROM "Cafe" c
 WHERE NOT EXISTS (SELECT 1 FROM "CafeSettings" s WHERE s."cafeId" = c."id");

-- NOTHING is migrated into OVERRIDE_ALL. It waives recipe completeness, and no
-- existing café has ever agreed to sell against consumption nobody has
-- written down. Reaching that mode is a deliberate act in the settings screen.

-- "Cafe"."allowNegativeStock" is deliberately NOT dropped here. Keeping it
-- makes this migration non-destructive and reversible; it is no longer read by
-- any application code (POLICY-005 pins that by scanning src/). Dropping it is
-- a separate migration, to be approved on its own.
