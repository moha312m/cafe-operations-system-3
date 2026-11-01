import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const panel = path.join(root, "src/components/handovers/opening-cash-panel.tsx");
const card = path.join(root, "src/components/settings/branch-opening-settings-card.tsx");

function source(file: string) {
  return readFileSync(file, "utf8");
}

describe("UI-005 branch ref lifecycle in cash receipt and opening settings", () => {
  test("both components update currentBranch in a commit-phase layout effect, never during render", () => {
    for (const file of [panel, card]) {
      const code = source(file);
      assert.match(code, /useLayoutEffect\(\(\)=>\{currentBranch\.current=branchId;\},\[branchId\]\)/, file);
      assert.doesNotMatch(code, /useRef\(branchId\);currentBranch\.current=branchId/, file);
    }
  });

  test("the layout effect is registered before any conditional return so hook order stays stable", () => {
    const code = source(panel);
    const effectIndex = code.indexOf("useLayoutEffect(()=>{currentBranch.current=branchId;}");
    const earlyReturnIndex = code.indexOf("if(!mayView)return null;");
    assert.ok(effectIndex > -1 && earlyReturnIndex > -1, "both markers must exist");
    assert.ok(effectIndex < earlyReturnIndex, "the layout effect must be declared before the mayView early return");
  });

  test("stale-response guards against branch switches are retained in both components", () => {
    const panelCode = source(panel);
    const cardCode = source(card);
    assert.match(panelCode, /currentBranch\.current===context/);
    assert.match(panelCode, /currentBranch\.current!==context/);
    assert.match(cardCode, /currentBranch\.current===context/);
  });

  test("the data-loading effects still reset state and reload when branchId changes", () => {
    assert.match(source(panel), /useEffect\(\(\)=>\{setStorages\(\[\]\);[\s\S]*?\},\[load\]\)/);
    assert.match(source(card), /\},\[branchId\]\)/);
  });
});
