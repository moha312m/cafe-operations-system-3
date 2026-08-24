-- Payment & serving policy, configured per order type by the owner.

CREATE TYPE "ServingPaymentPolicy" AS ENUM ('ALLOW_BEFORE_PAYMENT', 'REQUIRE_PAYMENT_FIRST');

-- The column defaults describe a NEW café: dine-in may be served before
-- payment, takeaway is handed over only once paid.
ALTER TABLE "CafeSettings"
  ADD COLUMN "dineInServingPolicy"   "ServingPaymentPolicy" NOT NULL DEFAULT 'ALLOW_BEFORE_PAYMENT',
  ADD COLUMN "takeawayServingPolicy" "ServingPaymentPolicy" NOT NULL DEFAULT 'REQUIRE_PAYMENT_FIRST';

-- Branch overrides. NULL = inherit the café setting.
ALTER TABLE "Branch"
  ADD COLUMN "dineInServingPolicyOverride"   "ServingPaymentPolicy",
  ADD COLUMN "takeawayServingPolicyOverride" "ServingPaymentPolicy";

-- Existing cafés were all pay-before-serving, and this feature must not
-- change how anyone's café already behaves. The column default above applies
-- only to rows inserted from now on; every row that exists at this moment is
-- pinned back to the behaviour it had before the feature landed.
UPDATE "CafeSettings" SET "dineInServingPolicy" = 'REQUIRE_PAYMENT_FIRST';
UPDATE "CafeSettings" SET "takeawayServingPolicy" = 'REQUIRE_PAYMENT_FIRST';
