import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const src = fs.readFileSync(path.join(root, "src/components/pos/payment-summary.tsx"), "utf8");

// A TouchNumberInput holds 48px touch controls. A fixed-height utility on its wrapper (h-7 = 28px) made the controls paint over the neighbouring
// totals row (reported as the discount control covering "الإجمالي قبل الخصم"). Rows must be allowed to grow: min-h-*, never h-*.
test("contract: no TouchNumberInput in the payment summary has a fixed-height wrapper class", () => {
  const usages = [...src.matchAll(/<TouchNumberInput[\s\S]*?\/>/g)].map((m) => m[0]);
  assert.ok(usages.length >= 3, "discount, partial and mixed inputs are present");
  for (const u of usages) assert.doesNotMatch(u, /className="(?:[^"]*\s)?h-\d/, "fixed height on a touch-number wrapper:\n" + u.slice(0, 160));
  assert.equal([...src.matchAll(/min-h-7 w-2[48] text-end text-sm/g)].length, 3, "the three row inputs use min-h-7");
});
