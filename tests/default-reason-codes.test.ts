import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_REASON_CODES } from "../src/lib/default-reason-codes";

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
