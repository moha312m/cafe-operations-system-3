import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = (file: string) => readFileSync(path.join(root, file), "utf8");

describe("UI-014 handover 1280x640 wide layout, internal table scroll, and sticky action bar", () => {
  test("HandoverDetail uses a 12-column wide responsive grid separating count/receiving from overview", () => {
    const detail = source("src/components/handovers/handover-detail.tsx");
    assert.match(detail, /data-testid="handover-wide-grid"/);
    // Step 5 replaced the two fixed columns with a header, summary cards and accessible tabs; the wide container keeps its hook.
    assert.match(detail, /data-testid="handover-cards"/);
    assert.match(detail, /<TabBar active=\{tab\}/);
    assert.match(detail, /role="tabpanel"/);
    assert.match(detail, /max-h-\[55vh\]\s+overflow-auto/);
  });

  test("StockCountDetail table wrapper has internal scroll and HandoverActionBar is sticky at bottom", () => {
    const countDetail = source("src/components/stock-counts/stock-count-detail.tsx");
    const actionBar = source("src/components/handovers/handover-action-bar.tsx");
    assert.match(countDetail, /max-h-\[55vh\]\s+overflow-auto\s+rounded-xl\s+border/);
    assert.match(actionBar, /data-testid="handover-sticky-actions"/);
    assert.match(actionBar, /sticky\s+bottom-0/);
  });
});
