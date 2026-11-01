import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = (file: string) => readFileSync(path.join(root, file), "utf8");

describe("UI-015 client-side Decimal cash denomination calculator", () => {
  test("computeDenominationTotal calculates exact Decimal totals for 200, 100, 50, 20, 10, 5, 1 and coins", async () => {
    const mod = await import("../src/components/pos/cash-denomination-calculator").catch(() => null);
    assert.ok(mod, "cash-denomination-calculator module must exist");
    assert.deepEqual(mod.CASH_DENOMINATIONS, [200, 100, 50, 20, 10, 5, 1]);

    const res = mod.computeDenominationTotal(
      { 200: "3", 100: "2", 50: "1", 20: "4", 10: "1", 5: "2", 1: "7" },
      "3.75"
    );
    // 600 + 200 + 50 + 80 + 10 + 10 + 7 + 3.75 = 960.75
    assert.equal(res.valid, true);
    assert.equal(res.total, "960.75");

    // Rejects negative or fractional bill counts and invalid coin strings
    assert.equal(mod.computeDenominationTotal({ 200: "-1" }, "").valid, false);
    assert.equal(mod.computeDenominationTotal({ 100: "1.5" }, "").valid, false);
    assert.equal(mod.computeDenominationTotal({}, "-0.50").valid, false);
    assert.equal(mod.computeDenominationTotal({}, "1.234").valid, false);
  });

  test("calculator uses @/lib/money Decimal, never references expected cash, and wires into shift-controls", () => {
    const calc = source("src/components/pos/cash-denomination-calculator.tsx");
    assert.match(calc, /from\s+"@\/lib\/money"/);
    assert.doesNotMatch(calc, /expectedCash|expectedDrawer|variance/i, "calculator must never disclose expected cash");

    // HND-UX-004: the drawer count lives on the close screen now.
    const controls = source("src/components/pos/shift-close-flow.tsx");
    assert.match(controls, /CashDenominationCalculator/);
    assert.match(controls, /onApply=\{\(value\) => setCash\(value\)\}/);
  });
});
