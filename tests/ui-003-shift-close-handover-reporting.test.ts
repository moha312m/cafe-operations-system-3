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

  // HND-UX-004 replaced the POS close dialog and its "settled, not
  // discharged" notice with a two-screen close (`/close-shift`). The stake is
  // the same and so is the contract, now held by the screen that submits:
  // the handover half of the answer decides what comes next, a settled shift
  // is never announced as finished while materials are owed, every blocker
  // the server names is shown, and the next state is read from the server.
  const FLOW = "src/components/pos/shift-close-flow.tsx";

  test("the close reads the handover half of the answer", () => {
    const code = read(FLOW);
    assert.match(code, /handover\?: \{ required: boolean \}/);
    // "Not due" is claimed only from the server's own materials decision —
    // never inferred from "no handover", which is also true when a café does
    // not count at all. What comes next is then re-read from the server.
    assert.match(code, /res\.materials && !res\.materials\.due \? \{ notDue:/);
    assert.match(code, /const next = await onCommitted\(null\);/);
    // The type stays exported beside the controls for the route's response.
    assert.match(read(CONTROLS), /export type HandoverOutcome/);
  });

  test("a settled close with materials owed continues to the materials screen, not to a success message", () => {
    const code = read(FLOW);
    assert.match(code, /"التالي: جرد الخامات وإغلاق الشيفت"/);
    assert.match(code, /stage === "MATERIALS"/);
    assert.match(code, /data-testid="close-materials-step"/);
    // Done is only ever the server's answer.
    assert.match(code, /flow\.stage === "DONE" && <DoneStep/);
    assert.match(code, /تم تسجيل تسليم شيفتك/);
    // The POS offers the way back to the remaining step after a refresh.
    assert.match(read(CONTROLS), /data-testid="close-resume-materials"/);
  });

  test("a refusal shows every blocker the server named, beside the action", () => {
    const code = read(FLOW);
    const clientImports = code.match(/import\s*\{([^}]+)\}\s*from "@\/lib\/client"/)?.[1].split(",").map((name) => name.trim());
    assert.ok(clientImports?.includes("api") && clientImports.includes("blockersOf") && clientImports.includes("money"));
    assert.match(code, /blockers: e instanceof ApiRequestError \? blockersOf\(e\) : \[\]/);
    assert.match(code, /failure\.blockers\.map\(/);
    // Last attempt's obstacles are cleared at the next attempt.
    assert.match(code, /setFailure\(null\)/);
  });

  test("the close does not invent the shift's new state", () => {
    const code = read(FLOW);
    // A lost response may still have committed: the screen asks the server
    // which step remains instead of assuming success or retrying the money.
    assert.match(code, /const next = await onCommitted\(null\);/);
    assert.match(code, /next\.stage !== "MONEY"/);
    assert.match(code, /\/api\/shifts\/close-flow\?branchId=/);
  });
});
