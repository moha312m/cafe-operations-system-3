import { test } from "node:test";
import assert from "node:assert/strict";
import { db, assertTestDatabase, tag, teardownTaggedCafe } from "./helpers/db";
import { getApprovalSettings } from "@/lib/qr-approval";

test("QR-002 concurrent first reads share one approval settings row and preserve an owner configuration", async () => {
  await assertTestDatabase();
  const marker = tag("QR002");
  const cafe = await db.cafe.create({
    data: { name: marker, slug: marker.toLowerCase(), settings: { create: {} }, branches: { create: [{ name: marker }] } },
    include: { branches: true },
  });
  const branchId = cafe.branches[0].id;
  try {
    const results = await Promise.allSettled(Array.from({ length: 32 }, () => getApprovalSettings(cafe.id, branchId)));
    const rejected = results.filter(r => r.status === "rejected");
    assert.equal(rejected.length, 0, "concurrent first QR reads must not fail on branchId uniqueness");
    const rows = await db.qrOrderApprovalSettings.findMany({ where: { branchId } });
    assert.equal(rows.length, 1);
    for (const result of results) if (result.status === "fulfilled") assert.equal(result.value.id, rows[0].id);
    await db.qrOrderApprovalSettings.update({ where: { branchId }, data: { enabled: false, approvalMode: "MANAGER_APPROVAL" } });
    const configured = await getApprovalSettings(cafe.id, branchId);
    assert.equal(configured.enabled, false);
    assert.equal(configured.approvalMode, "MANAGER_APPROVAL");
  } finally {
    await teardownTaggedCafe(cafe.id);
    await db.$disconnect();
  }
});
