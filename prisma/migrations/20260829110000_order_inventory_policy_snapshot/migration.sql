-- The inventory policy an order was ACCEPTED under, recorded on the order.
--
-- An order's inventory lifecycle spans two moments that can be hours apart:
-- availability is judged when the customer is told yes, and ingredients are
-- deducted under a row lock when it reaches SERVED. Both read the café's
-- policy, and until now both read it FRESH — so an owner opening the settings
-- screen in between silently changed the rules for an order already sold.
--
-- Both directions were wrong:
--
--   accepted permissive, then tightened   the deduction refuses, stranding a
--                                         drink already made and paid for
--   accepted strict, then relaxed         the deduction waives a shortage the
--                                         till would never have accepted
--
-- The order now carries its own answer. This is the rule the order already
-- applies to money — "taxRateSnapshot"/"serviceRateSnapshot" exist so a later
-- settings edit never rewrites what a customer was charged — and enforcement
-- policy is the same kind of fact.
--
-- Additive by construction: one column on one table, reusing the enum the
-- previous migration created. Nothing is dropped, "Cafe"."allowNegativeStock"
-- included; retiring that column stays a separate, separately-approved change.

-- The default is the strict reading, so a row written by a path that forgets
-- the field fails CLOSED rather than being handed a waiver by accident. It
-- also does the whole backfill for rows that already exist: every historical
-- order lands on STRICT before the statement below moves any of them.
ALTER TABLE "Order"
  ADD COLUMN "inventoryEnforcementMode" "InventoryEnforcementMode"
  NOT NULL DEFAULT 'STRICT';

-- Historical orders get the regime they were ACTUALLY taken under, not the
-- one their café happens to be running today.
--
-- "Cafe"."allowNegativeStock" is the right source and the only honest one: it
-- was the single enforcement input in existence when these orders were placed,
-- it is still on the table because the previous migration deliberately did not
-- drop it, and it is exactly what that migration read to derive
-- "CafeSettings"."inventoryEnforcementMode". Reading it here keeps the two
-- backfills consistent with each other and independent of any policy change an
-- owner has made since.
--
-- Note what this statement CANNOT do, by construction rather than by promise:
-- it assigns one value, and that value is not the permissive one. The third
-- mode waives recipe completeness — it lets a sale go through against
-- consumption nobody has written down — and it did not exist as a choice when
-- any of these orders were taken. Inventing it retroactively would grant past
-- orders a waiver no owner ever agreed to for them, so no row reaches it here.
-- It is only ever reached by an order created after this migration, under a
-- café that has deliberately selected it.
UPDATE "Order" o
   SET "inventoryEnforcementMode" = 'ALLOW_NEGATIVE_STOCK'
  FROM "Cafe" c
 WHERE c."id" = o."cafeId"
   AND c."allowNegativeStock" = true;
