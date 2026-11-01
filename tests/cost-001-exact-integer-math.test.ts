import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { lineTotalCents, roundHalf, weightedAverageMicro } from "@/lib/cost-math";

// Pure arithmetic on bigint: quantities in thousandths, unit costs in
// millionths, line totals in cents. No database, server or application state.
// Expected values are worked by hand (and checked with plain BigInt outside
// this repository's code) rather than derived from the implementation.

const b = (value: number | string) => BigInt(value);
const abs = (value: bigint) => (value < b(0) ? -value : value);
const sign = (value: bigint) => (value < b(0) ? -1 : value > b(0) ? 1 : 0);
// 1 followed by `zeros` zeros, built from a string so it never touches Number.
const pow10 = (zeros: number) => BigInt("1" + "0".repeat(zeros));

describe("roundHalf", () => {
  test("zero and exact division", () => {
    assert.equal(roundHalf(b(0), b(5)), b(0));
    assert.equal(roundHalf(b(0), b(-5)), b(0));
    assert.equal(roundHalf(b(10), b(5)), b(2));
    assert.equal(roundHalf(b(-10), b(5)), b(-2));
    assert.equal(roundHalf(b(10), b(-5)), b(-2));
    assert.equal(roundHalf(b(-10), b(-5)), b(2));
    assert.equal(roundHalf(b(7), b(1)), b(7));
  });

  test("exact ties round away from zero, whatever the signs", () => {
    const ties: [number, number, number][] = [
      [1, 2, 1], [3, 2, 2], [5, 2, 3], [7, 2, 4],
      [-1, 2, -1], [-3, 2, -2], [-5, 2, -3],
      [1, -2, -1], [5, -2, -3],
      [-1, -2, 1], [-5, -2, 3],
      [50, 100, 1], [-50, 100, -1], [150, 100, 2], [-150, 100, -2],
    ];
    for (const [n, d, expected] of ties) {
      assert.equal(roundHalf(b(n), b(d)), b(expected), `${n}/${d}`);
    }
  });

  test("values just either side of a tie round to the nearer integer", () => {
    const near: [number, number, number][] = [
      [49, 100, 0], [51, 100, 1], [-49, 100, 0], [-51, 100, -1],
      [149, 100, 1], [151, 100, 2], [-149, 100, -1], [-151, 100, -2],
      [4, 3, 1], [5, 3, 2], [-4, 3, -1], [-5, 3, -2],
      [4, -3, -1], [5, -3, -2],
    ];
    for (const [n, d, expected] of near) {
      assert.equal(roundHalf(b(n), b(d)), b(expected), `${n}/${d}`);
    }
  });

  test("a zero denominator is a RangeError", () => {
    assert.throws(() => roundHalf(b(1), b(0)), RangeError);
    assert.throws(() => roundHalf(b(0), b(0)), RangeError);
    assert.throws(() => roundHalf(b(-7), b(0)), RangeError);
  });

  test("always returns a bigint", () => {
    assert.equal(typeof roundHalf(b(3), b(2)), "bigint");
    assert.equal(typeof roundHalf(b(0), b(2)), "bigint");
  });

  test("numerators beyond Number.MAX_SAFE_INTEGER keep every digit", () => {
    const twoPow53Plus1 = b("9007199254740993"); // 2^53 + 1, not representable as a Number
    assert.equal(roundHalf(twoPow53Plus1, b(2)), b("4503599627370497"), "tie at 4503599627370496.5");
    assert.equal(roundHalf(-twoPow53Plus1, b(2)), b("-4503599627370497"));
    assert.equal(roundHalf(b("9007199254740992"), b(2)), b("4503599627370496"));
    assert.equal(roundHalf(twoPow53Plus1, b(3)), b("3002399751580331"), "exact: 3 x 3002399751580331");
    // 10^30 / 3 = 333...3.33 and 2 x 10^30 / 3 = 666...6.67
    assert.equal(roundHalf(pow10(30), b(3)), BigInt("3".repeat(30)));
    assert.equal(roundHalf(b("2" + "0".repeat(30)), b(3)), BigInt("6".repeat(29) + "7"));
  });

  test("large integers one unit either side of a tie", () => {
    const d = pow10(20);
    const k = "123456789012345678901";
    const tie = b(k + "50000000000000000000"); // k.5 exactly
    const below = b(k + "49999999999999999999");
    const above = b(k + "50000000000000000001");
    const lower = b(k);
    const upper = b("123456789012345678902");
    assert.equal(roundHalf(tie, d), upper);
    assert.equal(roundHalf(below, d), lower);
    assert.equal(roundHalf(above, d), upper);
    assert.equal(roundHalf(-tie, d), -upper);
    assert.equal(roundHalf(-below, d), -lower);
    assert.equal(roundHalf(-above, d), -upper);
    assert.equal(roundHalf(tie, -d), -upper);
    assert.equal(roundHalf(-tie, -d), upper);
    // 10^30 + 5 over 10 is 10^29 + 0.5 (a tie); + 4 is below it.
    assert.equal(roundHalf(b("1" + "0".repeat(29) + "5"), b(10)), b("1" + "0".repeat(28) + "1"));
    assert.equal(roundHalf(b("1" + "0".repeat(29) + "4"), b(10)), b("1" + "0".repeat(29)));
  });

  test("invariants over a grid of small values", () => {
    const denominators = [-7, -4, -3, -2, -1, 1, 2, 3, 4, 7, 10].map(b);
    for (let n = -60; n <= 60; n++) {
      for (const d of denominators) {
        const numerator = b(n);
        const r = roundHalf(numerator, d);
        const error = abs(r * d - numerator);
        // Nearest integer: the remainder is never more than half the divisor.
        assert.ok(error * b(2) <= abs(d), `${n}/${d}: nearest`);
        // On an exact tie the result moves away from zero.
        if (error * b(2) === abs(d)) assert.ok(abs(r * d) > abs(numerator), `${n}/${d}: tie goes away from zero`);
        // Sign symmetry.
        assert.equal(roundHalf(-numerator, d), -r, `${n}/${d}: odd in the numerator`);
        assert.equal(roundHalf(numerator, -d), -r, `${n}/${d}: odd in the denominator`);
        assert.equal(roundHalf(-numerator, -d), r, `${n}/${d}: both signs flipped`);
        // An exact multiple is returned unchanged.
        assert.equal(roundHalf(r * d, d), r, `${n}/${d}: idempotent on multiples`);
      }
    }
  });
});

describe("lineTotalCents", () => {
  test("1000 units at 0.004 is 4.00", () => {
    assert.equal(lineTotalCents(b(1000000), b(4000)), b(400));
  });

  test("0.5 units at 2.01 is 1.005, which rounds half up to 1.01", () => {
    assert.equal(lineTotalCents(b(500), b(2010000)), b(101));
  });

  test("1.235 units at 10.00 is 12.35", () => {
    assert.equal(lineTotalCents(b(1235), b(10000000)), b(1235));
  });

  test("zero quantity or zero cost is zero", () => {
    assert.equal(lineTotalCents(b(0), b(4000)), b(0));
    assert.equal(lineTotalCents(b(1000), b(0)), b(0));
    assert.equal(lineTotalCents(b(0), b(0)), b(0));
  });

  test("results below half a cent round to zero; exactly half a cent rounds up", () => {
    assert.equal(lineTotalCents(b(1), b(1)), b(0));
    assert.equal(lineTotalCents(b(1), b(4999999)), b(0), "0.001 x 4.999999 = 0.004999999");
    assert.equal(lineTotalCents(b(1), b(5000000)), b(1), "0.001 x 5.00 = 0.005 exactly");
    assert.equal(lineTotalCents(b(1), b(5000001)), b(1));
    assert.equal(lineTotalCents(b(2), b(5000000)), b(1), "exactly one cent");
    assert.equal(lineTotalCents(b(3), b(5000000)), b(2), "1.5 cents rounds to 2");
  });

  test("the sign of the product is preserved", () => {
    assert.equal(lineTotalCents(b(-500), b(2010000)), b(-101));
    assert.equal(lineTotalCents(b(500), b(-2010000)), b(-101));
    assert.equal(lineTotalCents(b(-500), b(-2010000)), b(101));
    assert.equal(lineTotalCents(b(-1), b(5000000)), b(-1), "a negative tie rounds away from zero");
    assert.equal(lineTotalCents(b(-1), b(4999999)), b(0));
  });

  test("products beyond Number.MAX_SAFE_INTEGER are exact", () => {
    // (10^12 - 1) x (10^16 - 1) = 9999999999989999000000000001; its last seven
    // digits are 0000001, so the quotient by 10^7 rounds down.
    const q = b("999999999999");
    const c = b("9999999999999999");
    const expected = b("999999999998999900000");
    assert.equal(lineTotalCents(q, c), expected);
    assert.equal(lineTotalCents(-q, c), -expected);
    assert.equal(lineTotalCents(-q, -c), expected);
    // Invariant, written without the module: |cents x 10^7 - product| <= 5 x 10^6.
    assert.ok(abs(expected * pow10(7) - q * c) * b(2) <= pow10(7));
    // A product that lands exactly on a half cent, with 22 digits.
    const halfQ = b("1000000000001"); // 10^12 + 1 thousandths
    const halfC = b("5000000"); // 5.00
    // product = 5,000,000,000,005,000,000 -> /10^7 = 500000000000.5 -> tie
    assert.equal(lineTotalCents(halfQ, halfC), b("500000000001"));
    assert.equal(lineTotalCents(-halfQ, halfC), b("-500000000001"));
  });

  test("symmetry and a half-away-from-zero floor over a grid", () => {
    for (let q = -9; q <= 9; q++) {
      for (const c of [0, 1, 4999999, 5000000, 5000001, 2010000, -2010000, 12345678]) {
        const cents = lineTotalCents(b(q), b(c));
        const product = b(q) * b(c);
        assert.ok(abs(cents * pow10(7) - product) * b(2) <= pow10(7), `${q} x ${c}`);
        assert.equal(sign(cents) === 0 || sign(cents) === sign(product), true, `${q} x ${c}: sign`);
        assert.equal(lineTotalCents(b(-q), b(c)), -cents);
      }
    }
  });
});

describe("weightedAverageMicro", () => {
  test("a receipt into empty stock keeps the incoming cost exactly", () => {
    assert.equal(weightedAverageMicro(b(0), b(999000000), b(1000), b(12345678)), b(12345678));
  });

  test("old stock -3 at 10.00 plus 5 at 12.00 gives 15.000000 (the existing negative-stock behavior)", () => {
    // (-3000 x 10,000,000 + 5000 x 12,000,000) / 2000 = 30,000,000,000 / 2000
    assert.equal(weightedAverageMicro(b(-3000), b(10000000), b(5000), b(12000000)), b(15000000));
  });

  test("a combined quantity of zero or less falls back to the incoming cost", () => {
    assert.equal(weightedAverageMicro(b(-5000), b(7000000), b(5000), b(3000000)), b(3000000), "exactly zero");
    assert.equal(weightedAverageMicro(b(-6000), b(7000000), b(5000), b(3000000)), b(3000000), "below zero");
    assert.equal(weightedAverageMicro(b(0), b(7000000), b(0), b(3000000)), b(3000000), "both empty");
    assert.equal(weightedAverageMicro(b(-1), b(7000000), b(0), b(3000000)), b(3000000));
  });

  test("cancellation between a negative balance and a receipt keeps its sign", () => {
    // (-9000 x 100,000,000 + 10000 x 50,000,000) / 1000 = -400,000,000,000 / 1000
    assert.equal(weightedAverageMicro(b(-9000), b(100000000), b(10000), b(50000000)), b(-400000000));
  });

  test("negative internal costs are averaged like any other value", () => {
    // (1000 x -2,000,000 + 1000 x 4,000,000) / 2000 = 1,000,000
    assert.equal(weightedAverageMicro(b(1000), b(-2000000), b(1000), b(4000000)), b(1000000));
    // (1000 x -5,000,000 + 1000 x -1,000,000) / 2000 = -3,000,000
    assert.equal(weightedAverageMicro(b(1000), b(-5000000), b(1000), b(-1000000)), b(-3000000));
  });

  test("half-way results round away from zero", () => {
    // (1 x 1 + 1 x 0) / 2 = 0.5
    assert.equal(weightedAverageMicro(b(1), b(1), b(1), b(0)), b(1));
    // (-1 x 1 + 3 x 0) / 2 = -0.5
    assert.equal(weightedAverageMicro(b(-1), b(1), b(3), b(0)), b(-1));
    // (1 x 2 + 3 x 0) / 4 = 0.5
    assert.equal(weightedAverageMicro(b(1), b(2), b(3), b(0)), b(1));
    // (1 x 1 + 3 x 0) / 4 = 0.25
    assert.equal(weightedAverageMicro(b(1), b(1), b(3), b(0)), b(0));
  });

  test("duplicate invoice lines are valued one at a time, not merged", () => {
    // Item A starts at 10 units costing 450.00; the invoice lists 2 at 460.00,
    // then (after another item) 3 at 470.00.
    const first = weightedAverageMicro(b(10000), b(450000000), b(2000), b(460000000));
    // 5,420,000,000,000 / 12,000 = 451,666,666.67
    assert.equal(first, b(451666667));
    const second = weightedAverageMicro(b(12000), first, b(3000), b(470000000));
    // (12,000 x 451,666,667 + 3,000 x 470,000,000) / 15,000 = 6,830,000,004,000 / 15,000 = 455,333,333.6
    assert.equal(second, b(455333334));
    // The same two lines merged into 5 units at 466.00 (2 x 460 + 3 x 470 = 2,330).
    const merged = weightedAverageMicro(b(10000), b(450000000), b(5000), b(466000000));
    // 6,830,000,000,000 / 15,000 = 455,333,333.33
    assert.equal(merged, b(455333333));
    assert.notEqual(second, merged, "merging the lines would change the stored cost");
  });

  test("numerators beyond Number.MAX_SAFE_INTEGER are exact", () => {
    // 10^9 units at cost 9,999,999.999999, receiving the same again: the
    // average is that cost, from a 2 x 10^28-sized numerator.
    const q = b("1000000000000"); // 10^9 units in thousandths
    const c = b("9999999999999999");
    assert.equal(weightedAverageMicro(q, c, q, c), c);
    // One micro-unit apart: the mean sits on a tie and goes away from zero.
    assert.equal(weightedAverageMicro(q, b("9999999999999998"), q, c), b("9999999999999999"));
    assert.equal(weightedAverageMicro(q, b("-9999999999999998"), q, b("-9999999999999999")), b("-9999999999999999"));
  });

  test("the result is the nearest integer to the exact weighted mean", () => {
    const quantities = [1, 2, 3, 1000, 7777].map(b);
    const costs = [-5, 0, 1, 4000, 12345678].map(b);
    for (const oq of quantities) for (const oc of costs) for (const nq of quantities) for (const nc of costs) {
      const combined = oq + nq;
      const exact = oq * oc + nq * nc;
      const r = weightedAverageMicro(oq, oc, nq, nc);
      assert.ok(abs(r * combined - exact) * b(2) <= combined, `${oq}@${oc} + ${nq}@${nc}`);
    }
  });

  test("always returns a bigint", () => {
    assert.equal(typeof weightedAverageMicro(b(1), b(2), b(3), b(4)), "bigint");
    assert.equal(typeof weightedAverageMicro(b(-3), b(2), b(1), b(4)), "bigint");
  });
});
