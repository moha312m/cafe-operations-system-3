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
    const input = html.match(/<input\b[^>]*type="date"[^>]*>/)?.[0];
    assert.ok(input, "the daily report renders its date picker");
    assert.ok(input.includes(`value="${expected}"`), input);
  });
}
