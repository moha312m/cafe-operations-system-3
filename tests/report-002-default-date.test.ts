// Render the real page with a frozen clock; only its app context is supplied.
import { afterEach, mock, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

const require = createRequire(import.meta.url);
const pageUrl = new URL("../src/app/(app)/reports/page.tsx", import.meta.url);
const compiled = ts.transpileModule(readFileSync(pageUrl, "utf8"), { compilerOptions: {
  module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true,
} }).outputText;
const pageModule = { exports: {} as { default: ComponentType } };
// Child components (reporting controls, touch select) import AppShell themselves through the real
// require; give them the same stub as the page via the module cache.
const appShellStub = { useApp: () => ({ cafe: null, user: { id: "u1", name: "Test User", role: "BRANCH_MANAGER", cafeId: "c1", branchId: "b1" }, canKey: () => false }) };
const appShellPath = require.resolve(fileURLToPath(new URL("../src/components/app-shell.tsx", import.meta.url)));
require.cache[appShellPath] = { id: appShellPath, filename: appShellPath, loaded: true, exports: appShellStub } as unknown as NodeJS.Module;
new Function("require", "module", "exports", compiled)((name: string) => {
  if (name === "@/components/app-shell") return { useApp: () => ({
    // AppShell guarantees a non-null SessionUser; the page reads user.role.
    cafe: null,
    user: { id: "u1", name: "Test User", role: "BRANCH_MANAGER", cafeId: "c1", branchId: "b1" },
    canKey: () => false,
  }) };
  return require(name.startsWith("@/")
    ? fileURLToPath(new URL(`../src/${name.slice(2)}`, import.meta.url)) : name);
}, pageModule, pageModule.exports);

afterEach(() => mock.timers.reset());
for (const { now, expected } of [
  { now: "2026-08-04T22:30:00Z", expected: "2026-08-05" },
  { now: "2026-01-14T22:30:00Z", expected: "2026-01-15" },
  { now: "2026-08-05T12:00:00Z", expected: "2026-08-05" },
]) {
  test(`report picker defaults to Cairo ${expected} at ${now}`, () => {
    mock.timers.enable({ apis: ["Date"], now: new Date(now).getTime() });
    const html = renderToStaticMarkup(createElement(pageModule.exports.default));
    for (const label of ["\u0628\u062f\u0627\u064a\u0629 \u0623\u064a\u0627\u0645 \u0627\u0644\u0639\u0645\u0644", "\u0646\u0647\u0627\u064a\u0629 \u0623\u064a\u0627\u0645 \u0627\u0644\u0639\u0645\u0644"]) {
      const picker = html.match(new RegExp(`<button\\b[^>]*aria-label="${label}"[^>]*>[\\s\\S]*?</button>`))?.[0];
      assert.ok(picker, `the daily report renders its ${label} date picker`);
      assert.ok(picker.includes(`>${expected}</button>`), picker);
    }
  });
}
