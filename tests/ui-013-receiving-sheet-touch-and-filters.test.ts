import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = (file: string) => readFileSync(path.join(root, file), "utf8");

describe("UI-013 receiving sheet touch controls, filters, and explicit zero", () => {
  test("ReceivingSheet provides filter tabs (all, undecided, critical) and next-undecided navigation", () => {
    const sheet = source("src/components/handovers/receiving-sheet.tsx");
    assert.match(sheet, /data-testid="receiving-filter-tabs"/);
    assert.match(sheet, /لم يُسجل بعد/);
    assert.match(sheet, /الأصناف الحرجة/);
    assert.match(sheet, /data-testid="receiving-next-undecided"/);
  });

  test("ReceivingSheet renders explicit zero button and touch step buttons per line while keeping atomic acknowledge submission", () => {
    const sheet = source("src/components/handovers/receiving-sheet.tsx");
    assert.match(sheet, /data-testid="receiving-line-zero"/);
    assert.match(sheet, /0 \(صفر فعلي\)/);
    assert.match(sheet, /data-testid="receiving-line-inc"/);
    assert.match(sheet, /data-testid="receiving-line-dec"/);
    assert.match(sheet, /\/api\/handovers\/\$\{handoverId\}\/acknowledge/);
  });
});
