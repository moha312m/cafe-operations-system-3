import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { handoverBlockMessage } from "../src/components/handovers/workflow-state";

// UI-009: the incoming shift's "not ready to sell" notice used to say
// "complete the count and review it, then hand over custody" whatever had
// already been done, so a manager whose cashier HAD counted (and the count was
// confirmed) was still told to count. The message now follows the real count
// status and names the single missing step. Text only: no transition changes.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = (file: string) => readFileSync(path.join(root, file), "utf8");
const base = { outgoingName: "كريم الكاشير", outgoingShiftNumber: 1 };

describe("UI-009 handover gate message follows the real state", () => {
  test("no count yet, count in progress, rejected: the count is what is missing", () => {
    assert.match(handoverBlockMessage({ ...base, status: "DRAFT", countStatus: null }), /فتح جرد التسليم وتسجيل الكميات الفعلية/);
    assert.match(handoverBlockMessage({ ...base, status: "DRAFT", countStatus: "IN_PROGRESS" }), /بدأ الجرد ولم يكمله/);
    assert.match(handoverBlockMessage({ ...base, status: "REJECTED", countStatus: "DRAFT" }), /جرد إعادة التسليم/);
  });

  test("count submitted or needing a recount: waiting for a manager, not for the cashier", () => {
    for (const countStatus of ["SUBMITTED", "RECOUNT_REQUIRED"]) {
      const text = handoverBlockMessage({ ...base, status: "DRAFT", countStatus });
      assert.match(text, /بانتظار اعتماد مسؤول/);
      assert.doesNotMatch(text, /فتح جرد التسليم/);
    }
  });

  test("count confirmed but custody not submitted: only the submit step is left, and it is never called 'complete the count'", () => {
    const text = handoverBlockMessage({ ...base, status: "DRAFT", countStatus: "CONFIRMED" });
    assert.match(text, /الجرد اتعمل واتأكد/);
    assert.match(text, /كريم الكاشير يضغط «تقديم العهدة للمستلم»/);
    assert.doesNotMatch(text, /استكمال الجرد/);
  });

  test("custody submitted: the receiver's step; unknown status: points to the handover page", () => {
    assert.match(handoverBlockMessage({ ...base, status: "OUTGOING_SUBMITTED", countStatus: "CONFIRMED" }), /مراجعة الأصناف وتأكيد الاستلام/);
    assert.match(handoverBlockMessage({ ...base, status: "WHATEVER", countStatus: null }), /افتح صفحة التسليم/);
    assert.match(handoverBlockMessage({ ...base, status: "DRAFT", countStatus: "CONFIRMED" }), /^شيفت #1 مقفول ماليًا، وتسليم المخزون لم يكتمل\./);
  });

  test("the API sends the count status (no quantities) and the shift controls use the helper", () => {
    const api = source("src/app/api/shifts/active/route.ts");
    assert.match(api, /stockCountSession: \{ select: \{ status: true \} \}/);
    assert.doesNotMatch(api, /stockCountSession: \{ select: \{[^}]*(lines|countedQuantity|expected)/);
    const controls = source("src/components/pos/shift-controls.tsx");
    assert.match(controls, /handoverBlockMessage\(\{ status: pendingShift\.pendingHandover\.status, countStatus: pendingShift\.pendingHandover\.stockCountSession\?\.status \?\? null/);
    assert.match(controls, /data-testid="handover-gate-message"/);
    assert.doesNotMatch(controls, /استكمال الجرد ومراجعته ثم تسليم العهدة/);
  });

  test("a shift that is open but not ready is no longer described as needing to be opened", () => {
    const controls = source("src/components/pos/shift-controls.tsx");
    assert.match(controls, /🔒 \{pendingShift \? "الشيفت مفتوح لكن البيع مقفول لحين اكتمال استلام العهدة" : t\.shifts\.mustOpen\}/);
    assert.match(controls, /\{!pendingShift && <Button size="sm" className="ms-auto" onClick=\{\(\) => setOpenDialog\(true\)\}>/, "the open-shift button rule is unchanged");
  });

  test("an unknown shift number is never invented, and the list shows the count status in Arabic", () => {
    assert.match(handoverBlockMessage({ ...base, outgoingShiftNumber: null, status: "DRAFT", countStatus: null }), /^الشيفت السابق مقفول ماليًا/);
    for (const file of ["src/components/handovers/handover-list.tsx", "src/components/handovers/handover-detail.tsx", "src/lib/close-guidance.ts"]) {
      assert.doesNotMatch(source(file), /outgoingShiftNumber: [^,}]*\?\? 1\b/, `${file} must not default the shift number to 1`);
    }
    const list = source("src/components/handovers/handover-list.tsx");
    assert.match(list, /COUNT_STATUS_LABEL\[h\.stockCountSession\.status as CountStatus\]/);
    assert.doesNotMatch(list, /\{h\.stockCountSession\?\.status \?\? "/, "no raw enum in the row");
    assert.match(source("src/components/handovers/handover-detail.tsx"), /=== "review" \? "التسليم لسه عند المُسلّم، والجرد بانتظار اعتماد مسؤول/, "a count waiting for review is not described as needing nothing");
  });

  test("a draft that is not open for receiving yet is explained calmly, other failures still alert", () => {
    const detail = source("src/components/handovers/handover-detail.tsx");
    const page = source("src/app/(app)/handovers/page.tsx");
    assert.match(page, /listedStatus=\{handovers\.find\(row => row\.id === selectedId && row\.branchId === branchId\)\?\.status\}/);
    assert.match(detail, /!view && \(listedStatus === "DRAFT" \|\| listedStatus === "REJECTED"\)/);
    assert.match(detail, /\{error && !\(listLoading && !view\) && \(!view && \(listedStatus === "DRAFT"/, "no red flash while the list loads");
    assert.match(page, /listLoading=\{loading\}/);
    assert.match(detail, /role="status" data-testid="handover-not-open-yet"/);
    assert.match(detail, /ومفيش إجراء مطلوب منك دلوقتي/);
    assert.match(detail, /<p role="alert" className="rounded-lg border p-3 text-sm">\{error\}\./, "real errors keep the alert");
    assert.match(detail, /canKey\("handover\.accept"\) && \["OUTGOING_SUBMITTED", "INCOMING_REVIEW"\]\.includes\(view\.status\)/, "receiving gates unchanged");
  });
});
