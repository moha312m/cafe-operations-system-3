import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = (file: string) => readFileSync(path.join(root, file), "utf8");

describe("UI-011 touch viewport on handovers/stock-counts and semantic theme tokens", () => {
  test("AppShell enables CashierTouchViewport on /handovers and /stock-counts", () => {
    const shell = source("src/components/app-shell.tsx");
    const touchLine = shell.split(/\r?\n/).find((line) => line.includes("const cashierTouch ="));
    assert.ok(touchLine, "cashierTouch declaration must exist in app-shell.tsx");
    assert.match(touchLine, /"\/handovers"/);
    assert.match(touchLine, /"\/stock-counts"/);
  });

  test("globals.css defines semantic --success and --warning tokens and preserves compact laptop sidebar on short screens", () => {
    const css = source("src/app/globals.css");
    assert.match(css, /--success:\s*#10b981/i);
    assert.match(css, /--warning:\s*#f59e0b/i);
    assert.match(css, /--color-success:\s*var\(--success\)/);
    assert.match(css, /--color-warning:\s*var\(--warning\)/);
    assert.match(
      css,
      /@media\s*\(max-height:\s*760px\)[\s\S]*html\[data-cashier-touch="true"\]\s*aside\s+nav/,
      "short laptop screens (1280x640) must keep compact sidebar navigation even when data-cashier-touch is active"
    );
  });
});
