import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_REASON_CODES, seedAllDefaultReasonCodesForCafe } from "../src/lib/default-reason-codes";

test("DEFAULT_REASON_CODES contains required handover reasons including miscount and other", () => {
  const handoverReasons = DEFAULT_REASON_CODES.HANDOVER;
  assert.ok(Array.isArray(handoverReasons));
  assert.ok(handoverReasons.length >= 4);

  const codes = handoverReasons.map((r) => r.code);
  assert.ok(codes.includes("SYS_HANDOVER_MISCOUNT"), "Contains miscount / something wrong");
  assert.ok(codes.includes("SYS_HANDOVER_VARIANCE"), "Contains unexplained variance");
  assert.ok(codes.includes("SYS_HANDOVER_DAMAGED"), "Contains damaged stock");
  assert.ok(codes.includes("SYS_HANDOVER_MISSING"), "Contains missing items");
  assert.ok(codes.includes("SYS_HANDOVER_OTHER"), "Contains other");

  // Verify labels are descriptive and in Arabic
  const miscount = handoverReasons.find((r) => r.code === "SYS_HANDOVER_MISCOUNT");
  assert.match(miscount?.label ?? "", /العد/);

  const other = handoverReasons.find((r) => r.code === "SYS_HANDOVER_OTHER");
  assert.match(other?.label ?? "", /سبب آخر/);
});

test("DEFAULT_REASON_CODES covers all supported domains", () => {
  assert.ok(DEFAULT_REASON_CODES.STOCK.length > 0);
  assert.ok(DEFAULT_REASON_CODES.CASH.length > 0);
  assert.ok(DEFAULT_REASON_CODES.TENDER.length > 0);
});

test("seedAllDefaultReasonCodesForCafe provisions all domains for a new cafe and is idempotent", async () => {
  const store: Array<{ id: string; cafeId: string; domain: string; code: string; label: string; isActive: boolean }> = [];

  const mockClient = {
    reasonCode: {
      findMany: async ({ where }: any) => {
        return store
          .filter(
            (r) =>
              r.cafeId === where.cafeId &&
              r.domain === where.domain &&
              (where.isActive === undefined || r.isActive === where.isActive)
          )
          .map((r) => ({ id: r.id, code: r.code, label: r.label, domain: r.domain }));
      },
      upsert: async ({ where, create, update }: any) => {
        const idx = store.findIndex(
          (r) =>
            r.cafeId === where.cafeId_domain_code.cafeId &&
            r.domain === where.cafeId_domain_code.domain &&
            r.code === where.cafeId_domain_code.code
        );
        if (idx >= 0) {
          store[idx] = { ...store[idx], ...update };
          return store[idx];
        } else {
          const item = { id: `rc_${store.length + 1}`, ...create };
          store.push(item);
          return item;
        }
      },
    },
  };

  const total = await seedAllDefaultReasonCodesForCafe(mockClient as any, "cafe_new_test_123");
  assert.ok(total >= 17, `Expected at least 17 default reasons, got ${total}`);
  assert.equal(store.length, total);

  // Check all domains are present
  const domainsInStore = new Set(store.map((s) => s.domain));
  assert.ok(domainsInStore.has("HANDOVER"));
  assert.ok(domainsInStore.has("STOCK"));
  assert.ok(domainsInStore.has("CASH"));
  assert.ok(domainsInStore.has("TENDER"));

  // Check idempotency: running again should not duplicate rows
  const total2 = await seedAllDefaultReasonCodesForCafe(mockClient as any, "cafe_new_test_123");
  assert.equal(total2, total);
  assert.equal(store.length, total);
});

