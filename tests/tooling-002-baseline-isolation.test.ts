// TOOLING-002 — name what was already broken, so new breakage stands out.
//
// A milestone this size runs against a repository that is not perfectly
// green: the lint baseline exits 1, and environmental failures come and go
// with the machine. Two bad things happen if that is left implicit.
//
// Cleaning them up inflates the diff with changes nobody reviewed and nobody
// asked for. Ignoring them means "the suite is red" stops carrying
// information, and a real regression hides among the noise it was supposed
// to stand out from.
//
// So the pre-existing failures are recorded once, at a named commit, and
// completion is defined against that record rather than against zero:
// a NEW regression is a suite that passed at base and fails at head.
// Nothing else blocks.
//
// `newRegressions` is pure, so it is tested on synthetic reports. That is
// deliberate — a comparison function tested only against whatever the
// machine happened to produce today asserts the machine, not the function.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { failingSuitesFrom, newRegressions } from "../scripts/baseline.mjs";

type BaselineReport = {
  commit: string;
  failingSuites: string[];
  lintClean: boolean;
  buildClean: boolean;
  typecheckClean: boolean;
  capturedAt: string;
};

/** A report with the given failing suites; the rest of the shape is fixed. */
function report(
  commit: string,
  failingSuites: string[],
  extra: Partial<BaselineReport> = {}
): BaselineReport {
  return {
    commit,
    failingSuites,
    lintClean: false,   // the repository's real lint baseline exits 1
    buildClean: true,
    typecheckClean: true,
    capturedAt: "2026-08-27T00:00:00.000Z",
    ...extra,
  };
}

describe("TOOLING-002 baseline isolation", () => {
  test("a suite failing in both is not a regression", () => {
    const base = report("40f25b3", ["tests/flaky-timezone.test.ts"]);
    const head = report("deadbee", ["tests/flaky-timezone.test.ts"]);
    assert.deepEqual(
      newRegressions(base, head), [],
      "a failure that predates the work is not caused by the work"
    );
  });

  test("a suite that passed at base and fails at head is a regression", () => {
    const base = report("40f25b3", []);
    const head = report("deadbee", ["tests/shift-001-expected-cash.test.ts"]);
    assert.deepEqual(
      newRegressions(base, head),
      ["tests/shift-001-expected-cash.test.ts"]
    );
  });

  test("a newly added suite that fails is a regression", () => {
    // It did not exist at base, so it cannot have been failing at base.
    // Treating "absent" as "was already broken" would let a task ship a
    // red suite of its own and call it pre-existing.
    const base = report("40f25b3", ["tests/flaky-timezone.test.ts"]);
    const head = report("deadbee", [
      "tests/flaky-timezone.test.ts",
      "tests/ledger-002-single-writer.test.ts",
    ]);
    assert.deepEqual(
      newRegressions(base, head),
      ["tests/ledger-002-single-writer.test.ts"]
    );
  });

  test("a suite that was failing and now passes is not reported", () => {
    const base = report("40f25b3", ["tests/flaky-timezone.test.ts"]);
    const head = report("deadbee", []);
    assert.deepEqual(
      newRegressions(base, head), [],
      "a fix is not a regression, and this function reports regressions only"
    );
  });

  test("a failing suite is read from the TAP location, not the describe name", () => {
    // The defect this pins: the runner names the *describe* on the `not ok`
    // line, so a filename matcher over those lines finds nothing and every
    // capture reports a clean slate — a baseline that records no failures no
    // matter how much is failing. `location:` carries the real path.
    const tap = [
      "TAP version 13",
      "# Subtest: LEDGER-002 single guarded writer",
      "    not ok 1 - a mutation advances ledgerVersion by exactly one",
      "      ---",
      "      duration_ms: 12.5",
      "      type: 'test'",
      "      location: 'C:\\\\Dev\\\\cafe-operations-system-3\\\\tests\\\\ledger-002-single-writer.test.ts:2:1417'",
      "      failureType: 'testCodeFailure'",
      "      ...",
      "not ok 1 - LEDGER-002 single guarded writer",
      "  ---",
      "  duration_ms: 13.0",
      "  type: 'suite'",
      "  location: 'C:\\\\Dev\\\\cafe-operations-system-3\\\\tests\\\\ledger-002-single-writer.test.ts:2:1339'",
      "  failureType: 'subtestsFailed'",
      "  ...",
    ].join("\n");

    assert.deepEqual(
      failingSuitesFrom(tap), ["tests/ledger-002-single-writer.test.ts"],
      "the file must be recorded once, from its location"
    );
    assert.deepEqual(
      failingSuitesFrom("TAP version 13\nok 1 - everything passed\n"), [],
      "a clean run records nothing"
    );
  });

  test("identical reports yield an empty list", () => {
    const both = ["tests/a.test.ts", "tests/b.test.ts"];
    assert.deepEqual(
      newRegressions(report("40f25b3", both), report("40f25b3", [...both])), []
    );
    assert.deepEqual(newRegressions(report("x", []), report("y", [])), []);
  });
});
