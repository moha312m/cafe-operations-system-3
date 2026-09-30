import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const panel = path.join(root, "src/components/settings/handover-config-panel.tsx");
const settings = path.join(root, "src/app/(app)/settings/page.tsx");
const i18n = path.join(root, "src/lib/i18n.ts");

function source(file: string) {
  return readFileSync(file, "utf8");
}

describe("CONFIG-003 handover configuration UI", () => {
  test("the settings page mounts a dedicated handover panel behind stock_count.configure", () => {
    assert.ok(existsSync(panel), "the dedicated panel module must exist");
    const page = source(settings);
    assert.match(page, /HandoverConfigPanel/);
    assert.match(page, /canKey\("stock_count\.configure"\)/);
  });

  test("the panel uses the SH-8 API and inventory option endpoint rather than a client-side data store", () => {
    const code = source(panel);
    assert.match(code, /\/api\/branches\/\$\{branchId\}\/handover-config/);
    assert.match(code, /\/api\/inventory\?branchId=\$\{branchId\}/);
    assert.doesNotMatch(code, /@\/lib\/db|PrismaClient|HYBRID|CRITICAL|NO_SHIFT_COUNT/);
  });

  test("the panel preserves SH-8 state semantics and translates every owner-facing label", () => {
    const code = source(panel);
    assert.match(code, /AbortController|requestGeneration/);
    assert.match(code, /selectedItemIds/);
    assert.match(code, /CYCLE_POLICY_UNSUPPORTED/);
    assert.match(code, /SELECTED_WITH_NO_ITEMS/);
    assert.match(code, /WEEKLY_WITHOUT_WEEKDAY/);
    assert.match(code, /t\.handoverConfig/);
    assert.match(source(i18n), /handoverConfig:/);
  });
});
