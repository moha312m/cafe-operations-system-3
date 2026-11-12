// Stock handover v2 — the pure comparison (owner decision 2026-11-12).
// raw = incoming − outgoing; net = recorded movement between the two cursors;
// expected = outgoing + net; adjusted = incoming − expected. Missing counts are
// never zero; units are never mixed; arithmetic is exact to 0.001.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { compareItem, fromMilli, toMilli, type CountObservation, type LedgerMovement } from "../src/lib/stock-handover-compare";

const t0 = new Date("2026-11-12T08:00:00.000Z");
const later = (minutes: number) => new Date(t0.getTime() + minutes * 60_000);
const obs = (quantity: string, version: number | null, at = t0, unit = "GRAM" as CountObservation["unit"]): CountObservation => ({
  quantityMilli: toMilli(quantity), unit, countedAt: at, itemVersion: version === null ? null : BigInt(version), counterId: "u",
});
const move = (version: number, quantity: string, at = t0): LedgerMovement => ({ itemVersion: BigInt(version), quantityMilli: toMilli(quantity), createdAt: at });

describe("exact quantities", () => {
  test("parses and prints at three decimals without floating point", () => {
    assert.equal(toMilli("0.1") + toMilli("0.2"), toMilli("0.3"));
    assert.equal(fromMilli(toMilli("1.005")), "1.005");
    assert.equal(fromMilli(toMilli("-0.250")), "-0.250");
    assert.equal(fromMilli(BigInt(0)), "0.000");
    assert.equal(toMilli(12), BigInt(12000));
  });
  test("refuses more precision than the column holds, and non-numbers", () => {
    for (const bad of ["1.2345", "abc", "", "1e3", null, undefined]) assert.throws(() => toMilli(bad), String(bad));
  });
});

describe("one item", () => {
  test("no difference: same figure, no movement", () => {
    const c = compareItem(obs("10", 5), obs("10", 5), []);
    assert.equal(c.label, "NO_DIFFERENCE");
    assert.equal(c.reliability, "CONFIRMED");
    assert.equal(c.rawMilli, BigInt(0)); assert.equal(c.adjustedMilli, BigInt(0));
  });

  test("a sale between the counts explains the whole raw difference", () => {
    // outgoing counted 10 at v5; a sale of 2 was written at v6; incoming counted 8 at v6.
    const c = compareItem(obs("10", 5), obs("8", 6), [move(6, "-2")]);
    assert.equal(fromMilli(c.rawMilli!), "-2.000");
    assert.equal(fromMilli(c.netMilli!), "-2.000");
    assert.equal(fromMilli(c.expectedMilli!), "8.000");
    assert.equal(fromMilli(c.adjustedMilli!), "0.000");
    assert.equal(c.label, "EXPLAINED_BY_MOVEMENTS");
    assert.equal(c.movementCount, 1);
  });

  test("an unexplained shortage survives the movement adjustment", () => {
    const c = compareItem(obs("10", 5), obs("7.5", 7), [move(6, "-2"), move(7, "+0.5".replace("+", ""))]);
    // expected = 10 − 2 + 0.5 = 8.5; adjusted = 7.5 − 8.5 = −1
    assert.equal(fromMilli(c.expectedMilli!), "8.500");
    assert.equal(fromMilli(c.adjustedMilli!), "-1.000");
    assert.equal(c.label, "UNEXPLAINED");
  });

  test("raw zero but a movement happened: an unexplained difference, not a match", () => {
    // Both counted 10, but 3 were sold between them — 3 are unaccounted for.
    const c = compareItem(obs("10", 5), obs("10", 6), [move(6, "-3")]);
    assert.equal(c.rawMilli, BigInt(0));
    assert.equal(fromMilli(c.adjustedMilli!), "3.000");
    assert.equal(c.label, "UNEXPLAINED");
  });

  test("the window is (earlier cursor, later cursor]: boundary movements are counted once", () => {
    const moves = [move(5, "-100"), move(6, "-1"), move(8, "-1"), move(9, "-100")];
    const c = compareItem(obs("10", 5), obs("8", 8), moves);
    assert.equal(c.movementCount, 2, "v5 is already inside the outgoing figure; v9 is after the incoming one");
    assert.equal(c.adjustedMilli, BigInt(0));
  });

  test("an incoming count taken BEFORE the outgoing one subtracts the window", () => {
    // incoming 12 at v4; a purchase of +2 at v5; outgoing 14 at v5.
    const c = compareItem(obs("14", 5), obs("12", 4), [move(5, "2")]);
    assert.equal(fromMilli(c.netMilli!), "-2.000");
    assert.equal(c.adjustedMilli, BigInt(0));
    assert.equal(c.label, "EXPLAINED_BY_MOVEMENTS");
  });

  test("a missing count is unavailable, never zero", () => {
    for (const [o, i] of [[null, obs("1", 1)], [obs("1", 1), null]] as const) {
      const c = compareItem(o, i, [move(2, "-1")]);
      assert.equal(c.label, "UNAVAILABLE");
      assert.equal(c.reliability, "UNAVAILABLE");
      assert.equal(c.rawMilli, null); assert.equal(c.adjustedMilli, null);
    }
  });

  test("incompatible units are never totalled", () => {
    const c = compareItem(obs("1", 1, t0, "KILOGRAM" as CountObservation["unit"]), obs("1000", 1, t0, "GRAM" as CountObservation["unit"]), []);
    assert.equal(c.label, "UNAVAILABLE");
    assert.equal(c.adjustedMilli, null);
  });

  test("a line without a cursor falls back to time and says so", () => {
    const c = compareItem(obs("10", null, t0), obs("9", 9, later(30)), [move(3, "-1", later(10)), move(4, "-5", later(40))]);
    assert.equal(c.reliability, "PROVISIONAL");
    assert.ok(c.note);
    assert.equal(c.movementCount, 1);
    assert.equal(c.adjustedMilli, BigInt(0));
  });

  test("the same inputs always give the same answer", () => {
    const a = compareItem(obs("3.333", 2), obs("3.334", 3), [move(3, "0.001")]);
    const b = compareItem(obs("3.333", 2), obs("3.334", 3), [move(3, "0.001")]);
    assert.deepEqual(a, b);
    assert.equal(a.adjustedMilli, BigInt(0));
  });
});
