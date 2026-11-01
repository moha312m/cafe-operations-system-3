import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { handoverPhaseLabel } from "../src/lib/close-guidance";
import { handoverBlockMessage } from "../src/components/handovers/workflow-state";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = (file: string) => readFileSync(path.join(root, file), "utf8");

describe("UI-010 handover list summary projection and single-source phase message", () => {
  test("listHandoversForViewer selects outgoingUser.name, outgoingShift.shiftNumber, and stockCountSession.status without any quantity or expected fields", () => {
    const handoverLib = source("src/lib/handover.ts");
    const fnStart = handoverLib.indexOf("export async function listHandoversForViewer");
    assert.ok(fnStart > 0, "listHandoversForViewer must exist");
    const fnBody = handoverLib.slice(fnStart, fnStart + 900);

    assert.match(fnBody, /outgoingUser:\s*\{\s*select:\s*\{\s*name:\s*true\s*\}\s*\}/);
    assert.match(fnBody, /outgoingShift:\s*\{\s*select:\s*\{\s*shiftNumber:\s*true\s*\}\s*\}/);
    assert.match(fnBody, /stockCountSession:\s*\{\s*select:\s*\{\s*status:\s*true\s*\}\s*\}/);
    assert.doesNotMatch(
      fnBody,
      /lines|countedQuantity|effectiveCountedQuantity|expectedQuantity|varianceQuantity|currentStock|costImpact|itemVersion/,
      "listHandoversForViewer must never project quantities or expected figures"
    );

    // incomingHandoverViewWithClient must remain closed for non-outgoing viewers in DRAFT/REJECTED
    const viewFnStart = handoverLib.indexOf("async function incomingHandoverViewWithClient");
    const viewFnGuard = handoverLib.slice(viewFnStart, viewFnStart + 1400);
    assert.match(
      viewFnGuard,
      /const outgoingDraft =[\s\S]{0,160}handover\.outgoingUserId === viewerId/,
      "incomingHandoverViewWithClient must not open DRAFT/REJECTED to non-outgoing viewers"
    );
  });

  test("handoverPhaseLabel uses handoverBlockMessage as single source of truth across count states", () => {
    const cgSource = source("src/lib/close-guidance.ts");
    assert.match(cgSource, /import\s*\{[^}]*handoverBlockMessage[^}]*\}\s*from\s*"@\/components\/handovers\/workflow-state"/);

    assert.equal(handoverPhaseLabel("ACCEPTED").complete, true);
    assert.equal(handoverPhaseLabel("COMPLETED").complete, true);
    assert.equal(handoverPhaseLabel("MANAGER_EXCEPTION").complete, false);

    const noCount = handoverPhaseLabel("DRAFT", {
      countStatus: null,
      outgoingName: "أحمد الكاشير",
      outgoingShiftNumber: 4,
    });
    assert.equal(noCount.complete, false);
    assert.equal(
      noCount.label,
      handoverBlockMessage({
        status: "DRAFT",
        countStatus: null,
        outgoingName: "أحمد الكاشير",
        outgoingShiftNumber: 4,
      })
    );
    assert.match(noCount.label, /المطلوب من أحمد الكاشير: فتح جرد التسليم/);

    const submittedCount = handoverPhaseLabel("DRAFT", {
      countStatus: "SUBMITTED",
      outgoingName: "أحمد الكاشير",
      outgoingShiftNumber: 4,
    });
    assert.match(submittedCount.label, /بانتظار اعتماد مسؤول/);

    const confirmedCount = handoverPhaseLabel("DRAFT", {
      countStatus: "CONFIRMED",
      outgoingName: "أحمد الكاشير",
      outgoingShiftNumber: 4,
    });
    assert.match(confirmedCount.label, /الجرد اتعمل واتأكد/);
    assert.match(confirmedCount.label, /أحمد الكاشير يضغط «تقديم العهدة للمستلم»/);
    assert.doesNotMatch(confirmedCount.label, /الجرد لسه مطلوب/);
  });

  test("PendingCloseBanner, HandoverList, and HandoverDetail surface the exact count status and actor name", () => {
    const panel = source("src/components/pos/close-guidance-panel.tsx");
    assert.match(panel, /handoverPhaseLabel\(view\.status,\s*\{/);
    assert.match(panel, /countStatus:\s*view\.count\?\.status/);

    const list = source("src/components/handovers/handover-list.tsx");
    assert.match(list, /outgoingUser\?\.name/);
    assert.match(list, /stockCountSession\?\.status/);

    const detail = source("src/components/handovers/handover-detail.tsx");
    assert.match(detail, /handoverBlockMessage/);
  });
});
