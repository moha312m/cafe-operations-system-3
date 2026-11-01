import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = (file: string) => readFileSync(path.join(root, file), "utf8");

describe("UI-016 handover UX clarity, anti-trap guards, and compact layout", () => {
  test("HandoverDetail explains missing incoming shift or waiting recipient and links to /current-shift", () => {
    const detail = source("src/components/handovers/handover-detail.tsx");
    assert.match(detail, /data-testid="handover-receive-blocker-callout"/);
    assert.match(detail, /لا يوجد شيفت مستلم مفتوح حاليًا/);
    assert.match(detail, /href="\/current-shift"/);
    assert.match(detail, /hasIncomingShift=\{!!view\.workflow\.incomingShift\}/);
    assert.match(detail, /stockReviewReady=\{stockReviewReady\}/);
  });

  test("HandoverActionBar hides premature cash inputs and prevents override-accept trap when stock lines are unacknowledged", () => {
    const bar = source("src/components/handovers/handover-action-bar.tsx");
    assert.match(bar, /hasIncomingShift\?: boolean/);
    assert.match(bar, /stockReviewReady\?: boolean/);
    assert.match(bar, /data-testid="handover-override-prerequisite-warning"/);
  });

  test("ReceivingSheet has no bulk accept-without-count: each null observation stays an explicit per-line choice", () => {
    const sheet = source("src/components/handovers/receiving-sheet.tsx");
    assert.doesNotMatch(sheet, /receiving-accept-all-without-count/);
    assert.doesNotMatch(sheet, /for \(const line of unreviewed\)[\s\S]{0,120}withoutCount: true/);
  });

  test("the open-shift shortcut names the recipient and is never offered to the outgoing user", () => {
    const detail = source("src/components/handovers/handover-detail.tsx");
    assert.match(detail, /!view\.workflow\.incomingShift && view\.outgoingUserId !== user\.id && \(/);
    assert.match(detail, /أنا المستلم: افتح شيفتي/);
    assert.match(detail, /المستلم يفتح شيفته من حسابه هو أولًا/);
  });

  test("override-accept is not offered on a BRANCH_CUSTODY target, which the server always refuses", () => {
    const bar = source("src/components/handovers/handover-action-bar.tsx");
    assert.match(bar, /\{target !== "BRANCH_CUSTODY" && <Button[\s\S]{0,200}data-testid="handover-override-accept"/);
  });

  test("HandoversPage compacts bottom opening/place panels into a responsive grid", () => {
    const page = source("src/app/(app)/handovers/page.tsx");
    assert.match(page, /data-testid="handover-auxiliary-panels"/);
    assert.match(page, /lg:grid-cols-3/);
  });
});
