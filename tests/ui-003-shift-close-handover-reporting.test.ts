// UI-003 — a close that settles the cash must not claim to have finished.
//
// `POST /api/shifts/:id/close` answers with two things: the reconciled shift
// and a `handover` object saying whether custody is still owed. Its own
// route comment states the stake plainly — "a response that said only
// 'closed' would send a custodian home believing they were discharged of
// stock they are still answerable for" — and until SH-24 the client typed
// only the first half and toasted "تم قفل الشيفت بنجاح" either way.
//
// The refusal has the same shape of problem: `HandoverBlockedError` carries
// a `blockers` list naming every obstacle, and the shared `api()` helper
// threw away everything except `error`, so a closer was told one reason at a
// time for a refusal that had four.
//
// Source-reading, like CONFIG-003: what is under test is whether the client
// reads fields the server already sends.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file: string) => readFileSync(path.join(root, file), "utf8");

const CONTROLS = "src/components/pos/shift-controls.tsx";
const CLIENT = "src/lib/client.ts";

describe("UI-003 the two-stage close is reported honestly", () => {
  test("the client helper keeps the server's error payload, additively", () => {
    const code = read(CLIENT);

    // The payload is preserved...
    assert.match(code, /class ApiRequestError extends Error/);
    assert.match(code, /readonly payload: unknown/);
    assert.match(code, /export function blockersOf/);

    // ...without changing what sixty existing callers already read. The
    // thrown value is still an Error carrying the same message, so a
    // `catch (e) { e.message }` elsewhere is untouched.
    assert.match(code, /\(data as \{ error\?: string \}\)\.error \?\? `Request failed/);
  });

  test("blockersOf refuses to invent a list out of an unknown payload", () => {
    const code = read(CLIENT);
    assert.match(code, /if \(!Array\.isArray\(blockers\)\) return \[\];/);
    assert.match(code, /filter\(\(b\): b is string => typeof b === "string"\)/);
  });

  test("the close reads the handover half of the answer", () => {
    const code = read(CONTROLS);

    // Typed, not dropped.
    assert.match(code, /handover\?: HandoverOutcome/);
    assert.match(code, /export type HandoverOutcome/);
    assert.match(code, /requiredItemCount/);
    assert.match(code, /configIssue/);

    // And branched on: a required handover must not produce the plain
    // success message.
    assert.match(code, /res\.handover\?\.required/);
    assert.match(code, /setHandoverNotice\(res\.handover\)/);
  });

  test("a settled-but-not-discharged close says so, and offers the way out", () => {
    const code = read(CONTROLS);
    assert.match(code, /data-testid="handover-required-notice"/);
    assert.match(code, /t\.shifts\.settledNotDischarged/);
    assert.match(code, /href="\/handovers"/, "the notice must link to the handover screen");

    const i18n = read("src/lib/i18n.ts");
    assert.match(i18n, /settledNotDischarged:/);
    assert.match(i18n, /handoverStillOwed:/);
    assert.match(i18n, /goToHandovers:/);
  });

  test("the bare success toast is reserved for a close that really finished", () => {
    const code = read(CONTROLS);
    // `lockedSuccess` must live in the else-branch of the handover check.
    // Asserted positionally because the defect being guarded against is
    // exactly "this line runs unconditionally".
    const required = code.indexOf("res.handover?.required");
    const locked = code.indexOf("t.shifts.lockedSuccess");
    assert.ok(required > 0, "the handover branch must exist");
    assert.ok(
      locked > required,
      "the success message must come after the handover check, not before it"
    );
    assert.match(code, /} else \{[\s\S]{0,160}t\.shifts\.lockedSuccess/);
  });

  test("a refusal shows every blocker the server named", () => {
    const code = read(CONTROLS);
    assert.match(code, /import \{ api, blockersOf, money \}/);
    assert.match(code, /setBlockers\(blockersOf\(e\)\)/);
    assert.match(code, /data-testid="close-blockers"/);
    assert.match(code, /blockers\.map\(/);
    // Yesterday's obstacles must not be shown against today's attempt.
    assert.match(code, /setBlockers\(\[\]\)/);
  });

  test("the close does not invent the shift's new state", () => {
    const code = read(CONTROLS);
    // A two-stage close leaves the shift AWAITING_HANDOVER rather than
    // closed. The client asks the server what happened instead of assuming
    // either outcome.
    assert.match(code, /await load\(\);/);
    assert.doesNotMatch(
      code,
      /setHandoverNotice\(res\.handover\);[\s\S]{0,200}setActive\(null\)/,
      "the client must re-read the shift rather than clearing it locally"
    );
  });
});
