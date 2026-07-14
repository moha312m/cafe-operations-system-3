-- Waiter tracking: indexes for querying orders by who created/approved them
-- (fields and relations already existed; this is index-only and additive).

CREATE INDEX "Order_createdById_idx" ON "Order"("createdById");
CREATE INDEX "Order_approvedById_idx" ON "Order"("approvedById");
CREATE INDEX "Order_source_idx" ON "Order"("source");
