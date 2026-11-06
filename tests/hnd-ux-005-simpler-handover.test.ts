import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { nextSteps, STEP_ORDER } from "../src/components/handovers/next-step-model";

// HND-UX-005 — the owner asked for fewer buttons to finish a handover. Five
// display-only changes, no rule change:
//   1. /handovers leads with one «المطلوب منك دلوقتي» card; empty panels are not drawn;
//   2. a direct handover under review shows its summary and one button, the rest folded;
//   3. branch custody: one «حفظ في عهدة الفرع» press signs the counted lines, then converts;
//   4. the close's Done screen after a branch-custody night points there, not to "hand the device over";
//   5. the morning opening verification is a three-step wizard on the same page.
// These checks also pin what must NOT move: per-line signatures, the omission pair, the
// server's CONFIRMED-count gate, and the blind count.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = (file: string) => readFileSync(path.join(root, file), "utf8");

describe("next-step model", () => {
  test("orders what is waiting: handover first, then what the next shift needs, cash deliveries last", () => {
    const { steps, checking, failed } = nextSteps({ handover: 0, "night-cash": 1, opening: 1, place: 2, "cash-deliveries": 3 });
    assert.deepEqual(steps.map((s) => s.source), ["night-cash", "opening", "place", "cash-deliveries"]);
    assert.equal(steps[3].count, 3);
    assert.match(steps[3].title, /3 تسليمات نقدية/);
    assert.equal(checking, false);
    assert.deepEqual(failed, []);
    assert.deepEqual(STEP_ORDER, ["handover", "night-cash", "opening", "place", "cash-deliveries"]);
  });

  test("nothing waiting is idle only once every panel has answered; a failed check is never shown as idle", () => {
    assert.deepEqual(nextSteps({ handover: 0, "night-cash": 0, opening: 0, place: 0, "cash-deliveries": 0 }), { steps: [], failed: [], checking: false });
    assert.equal(nextSteps({ handover: 0, "night-cash": null }).checking, true, "a panel still loading keeps the card checking");
    assert.equal(nextSteps({ handover: 0 }).checking, true, "a panel that never reported is not counted as empty");
    const broken = nextSteps({ handover: 0, "night-cash": "error", opening: 0, place: 0, "cash-deliveries": 0 });
    assert.deepEqual(broken.failed, ["night-cash"]);
    assert.deepEqual(broken.steps, []);
  });

  test("only the listed sources are considered", () => {
    const { steps, checking } = nextSteps({ handover: 2 }, ["handover"]);
    assert.equal(checking, false);
    assert.equal(steps[0].title, "2 تسليمات مستنية خطوة");
  });
});

describe("HND-UX-005 screens", () => {
  test("1. /handovers: the card, then only panels with work, then the history with its filter", () => {
    const page = source("src/app/(app)/handovers/page.tsx");
    assert.match(page, /<NextStepCard reports=/);
    assert.match(page, /id="handover-history"/);
    assert.match(page, /if \(status === ANY\) setOpenIds/, "the waiting-handover count ignores the status filter");
    assert.match(page, /includeCash=\{false\} hideWhenEmpty/, "night cash is its own step, not nested in the verification panel");
    const card = source("src/components/handovers/next-step-card.tsx");
    assert.match(card, /مفيش حاجة مستنياك دلوقتي/);
    assert.match(card, /تعذّر فحص/);
  });

  test("2. a direct handover under review: the summary is the action, the workspace folds, the receiving-sheet callout is gone", () => {
    const detail = source("src/components/handovers/handover-detail.tsx");
    assert.match(detail, /const directMode = !!view\?\.overview\.directHandover && view\?\.target === "SHIFT_TO_SHIFT";/);
    assert.match(detail, /\{!directReviewing && <section className="space-y-2 rounded-xl border border-primary\/30/);
    assert.match(detail, /<FoldWhen fold=\{directMode\} open=\{detailsOpen\}/);
    assert.match(detail, /step === "receive" && !branchCustody && !directMode && !canReceiveLines/);
    assert.match(detail, /setDetailsOpen\(true\)/, "opening a panel from a stage unfolds the details");
    assert.match(detail, /useEffect\(\(\) => \{\n\s*const hash = window\.location\.hash\.replace\("#", ""\);\n\s*if \(\(PANELS as string\[\]\)\.includes\(hash\)\) setTab\(hash as Panel\);\n\s*\}, \[\]\);/, "a #section link (the Done screen's #inventory) is honoured after a server render");
  });

  test("3. branch custody: one press signs each counted line, then converts with its own retry key", () => {
    const panel = source("src/components/handovers/branch-signing-panel.tsx");
    const signAt = panel.indexOf("/acknowledge`, { method: \"POST\"");
    const convertAt = panel.indexOf("/to-branch-custody`, {");
    assert.ok(signAt > 0 && convertAt > signAt, "lines are signed through the existing per-line route before the conversion");
    assert.match(panel, /const signed = pendingIds\.length === 0 \? true : await signAll\(\);\n\s*if \(signed\) await convert\(\);/, "a half-signed batch never converts");
    assert.match(panel, /handoverIntents\.keyFor\(handoverId, "branch", intent\)/);
    assert.match(panel, /const omissionHalf = \(omissionReason\.trim\(\) === ""\) !== \(omissionNote\.trim\(\) === ""\);/, "the omission reason and note still travel as a pair");
    assert.match(panel, /data-testid="branch-custody-sign-all"[\s\S]*حفظ في عهدة الفرع/);
    const bar = source("src/components/handovers/handover-action-bar.tsx");
    assert.match(bar, /\{target !== "BRANCH_CUSTODY" && <Button[\s\S]*?data-testid="handover-to-branch-custody"/, "no second conversion button on a branch-custody handover");
    assert.match(bar, /data-testid="handover-request-recount"/, "asking for a recount stays available");
  });

  test("4. after a branch-custody night the Done screen leads to «حفظ في عهدة الفرع», never to handing the device over", () => {
    const close = source("src/components/pos/shift-close-flow.tsx");
    assert.match(close, /const branchNight = !!submitted && handover\?\.target === "BRANCH_CUSTODY";/);
    assert.match(close, /const waiting = submitted && !branchNight;/);
    assert.match(close, /data-testid="close-hand-device"/);
    assert.match(close, /\{branchNight && maySaveToBranch && handoverHref && <Link href=\{`\$\{handoverHref\}#inventory`\}/);
    assert.match(close, /const maySaveToBranch = canKey\("handover\.accept"\) && canKey\("handover\.exception"\);/);
  });

  test("5. opening verification: one waiting shift and its latest count are chosen without asking; verify still needs a CONFIRMED count", () => {
    const opening = source("src/components/handovers/opening-verification-panel.tsx");
    assert.match(opening, /shifts\.length===1\?shifts\[0\]\.id:""/);
    assert.match(opening, /const step=!count\?1:count\.status==="CONFIRMED"\?3:2;/);
    assert.match(opening, /<StockCountDetail key=\{count\.id\} embedded/, "the count is recorded on this page, with the ordinary count screen and its blind entry");
    assert.match(opening, /action: "verify", shiftId, countSessionId: count\.id, branchId/);
    assert.doesNotMatch(opening, /تحديث القائمة/);
    assert.match(opening, /data-testid="opening-count-awaiting-confirm"/, "someone who cannot confirm the count is told who does");
    const boundary = source("src/lib/handover-boundary.ts");
    assert.match(boundary, /if \(session\.status !== "CONFIRMED"\) \{\s*throw new ApiError\(409, OPENING_COUNT_NOT_CONFIRMED\);/, "the server gate is unchanged");
  });
});
