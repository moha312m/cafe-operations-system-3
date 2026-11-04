// HANDOVER-023 (Step 5): the journey model keeps three facts apart — outgoing financial
// closure, handover completion, and incoming shift readiness — and names the one thing
// required now, who must do it, and why a viewer cannot. Pure: no database or server.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildJourney, pendingSignatureLineIds, type JourneyInput } from "@/components/handovers/handover-journey";
import type { ShiftReadiness } from "@/lib/handover-readiness";

const readiness = (over: Partial<ShiftReadiness> & { requirements?: ShiftReadiness["requirements"] } = {}): ShiftReadiness => ({
  shiftId: "s2", shiftNumber: 7, cashierName: "منى", openedAt: "2026-11-04T10:00:00.000Z", gate: null, operational: true,
  requirements: [
    { id: "custody", label: "استلام عهدة المخزون", state: "done", detail: null },
    { id: "opening-verification", label: "التحقق من العهدة الافتتاحية", state: "done", detail: null },
    { id: "cash-receipt", label: "استلام كاش الدرج", state: "not-required", detail: null },
    { id: "place-receipt", label: "استلام المكان والأجهزة", state: "not-required", detail: null },
  ],
  ...over,
});
const base: JourneyInput = {
  target: "SHIFT_TO_SHIFT", status: "OUTGOING_SUBMITTED", countStatus: "CONFIRMED", systemValidated: false, financiallyClosed: true,
  disputed: false, unreviewedLines: 2, excludedLines: 0, outgoingName: "أحمد", incomingShift: { shiftNumber: 7, name: "منى" }, incomingAmbiguous: false,
  readiness: null, can: { submit: true, confirmCount: true, accept: true, exception: false }, viewer: { isOutgoing: false, isRecipient: true, name: "منى" },
};
const stage = (j: ReturnType<typeof buildJourney>, id: string) => j.stages.find((s) => s.id === id)!;

test("A. shift-to-shift: the recipient is told to sign the sheet; others are told whose job it is", () => {
  const recipient = buildJourney(base);
  assert.match(recipient.requiredNow.title, /راجع ورقة الاستلام \(2 سطر\)/);
  assert.equal(recipient.requiredNow.blocker, null);
  assert.equal(recipient.requiredNow.panel, "inventory");
  const other = buildJourney({ ...base, viewer: { isOutgoing: false, isRecipient: false, name: "سلمى" } });
  assert.match(other.requiredNow.blocker ?? "", /توقيع منى صاحب الشيفت المستلم/);
});

test("B. branch custody with no incoming shift: branch-signature wording, a manager signs, no recipient is invented", () => {
  const j = buildJourney({ ...base, target: "BRANCH_CUSTODY", incomingShift: null, can: { submit: false, confirmCount: false, accept: true, exception: true }, viewer: { isOutgoing: false, isRecipient: false, name: "مدير" } });
  assert.match(j.requiredNow.title, /وقّع 2 سطر جرد باسم الفرع/);
  assert.match(j.requiredNow.actor, /الاستثناء/);
  assert.equal(stage(j, "sign").label, "توقيع باسم الفرع (2 سطر)");
  assert.match(stage(j, "sign").note ?? "", /لا يوجد موظف مستلم/);
  assert.equal(stage(j, "completion").label, "تحويل لعهدة الفرع");
  assert.equal(j.readiness.state, "none");
  const cashier = buildJourney({ ...base, target: "BRANCH_CUSTODY", incomingShift: null, can: { submit: true, confirmCount: false, accept: true, exception: false } });
  assert.match(cashier.requiredNow.blocker ?? "", /لمسؤول بصلاحية الاستثناء/);
});

test("C. branch custody with a shift already waiting: complete handover leaves the waiting shift on opening verification", () => {
  const waiting = readiness({ gate: "AWAITING_CUSTODY_TRANSFER", operational: false, requirements: [
    { id: "custody", label: "استلام عهدة المخزون", state: "pending", detail: "مستني" },
    { id: "opening-verification", label: "التحقق من العهدة الافتتاحية", state: "pending", detail: "بيبدأ بعد ما العهدة تتسلّم." },
    { id: "cash-receipt", label: "استلام كاش الدرج", state: "not-required", detail: null },
    { id: "place-receipt", label: "استلام المكان والأجهزة", state: "not-required", detail: null },
  ] });
  const before = buildJourney({ ...base, target: "BRANCH_CUSTODY", unreviewedLines: 0, can: { submit: false, confirmCount: false, accept: true, exception: true }, readiness: waiting });
  assert.match(before.requiredNow.title, /حوّل العهدة لعهدة الفرع/);
  assert.equal(stage(before, "opening-verification").state, "pending", "verification waits for the conversion");
  assert.deepEqual(before.readiness.remaining, ["اكتمال تسليم العهدة", "التحقق من العهدة الافتتاحية"]);

  const after = buildJourney({ ...base, target: "BRANCH_CUSTODY", status: "COMPLETED", unreviewedLines: 0, readiness: readiness({ gate: "AWAITING_OPENING_VERIFICATION", operational: false, requirements: [
    { id: "custody", label: "استلام عهدة المخزون", state: "done", detail: null },
    { id: "opening-verification", label: "التحقق من العهدة الافتتاحية", state: "pending", detail: "عهدة الفرع اتسلّمت؛ الشيفت لازم يعدّ الأصناف." },
    { id: "cash-receipt", label: "استلام كاش الدرج", state: "not-required", detail: null },
    { id: "place-receipt", label: "استلام المكان والأجهزة", state: "not-required", detail: null },
  ] }) });
  assert.equal(after.completion.state, "done");
  assert.equal(after.closure.state, "done");
  assert.equal(after.readiness.state, "pending", "handover complete, next shift still not operational");
  assert.equal(after.requiredNow.title, "التحقق من العهدة الافتتاحية");
  assert.equal(after.requiredNow.panel, "inventory");
  assert.match(after.readiness.label, /شيفت #7 لسه غير جاهز/);
});

test("D. a disputed line outranks everything and points at the recount", () => {
  const j = buildJourney({ ...base, disputed: true });
  assert.match(j.requiredNow.title, /معترض عليه/);
  assert.equal(j.requiredNow.actionLabel, "طلب إعادة الجرد");
  assert.equal(stage(j, "sign").state, "blocked");
});

test("F/G. cash and place requirements are listed individually; place runs in parallel, cash only after completion", () => {
  const ready = readiness({ operational: false, requirements: [
    { id: "custody", label: "استلام عهدة المخزون", state: "done", detail: null },
    { id: "opening-verification", label: "التحقق من العهدة الافتتاحية", state: "done", detail: null },
    { id: "cash-receipt", label: "استلام كاش الدرج", state: "pending", detail: "عدّ الكاش" },
    { id: "place-receipt", label: "استلام المكان والأجهزة", state: "pending", detail: "فحص المكان مفتوح" },
  ] });
  const during = buildJourney({ ...base, readiness: ready });
  assert.deepEqual(during.requiredNow.parallel.map((s) => s.id), ["place-receipt"], "the place check is independent of the stock handover");
  assert.equal(stage(during, "cash-receipt").state, "pending", "cash waits for the handover to complete");
  assert.equal(stage(during, "place-receipt").state, "current");

  const done = buildJourney({ ...base, status: "COMPLETED", unreviewedLines: 0, readiness: ready });
  assert.equal(done.requiredNow.panel, "cash");
  assert.deepEqual(done.requiredNow.parallel.map((s) => s.id), ["place-receipt"]);
  assert.deepEqual(done.readiness.remaining, ["استلام كاش الدرج", "استلام المكان والأجهزة"]);

  const all = buildJourney({ ...base, status: "COMPLETED", unreviewedLines: 0, readiness: readiness() });
  assert.equal(all.readiness.state, "operational");
  assert.match(all.requiredNow.title, /جاهز للتشغيل/);
});

test("closure, completion and readiness are independent facts", () => {
  const j = buildJourney({ ...base, financiallyClosed: false, status: "DRAFT", countStatus: null, unreviewedLines: 0 });
  assert.equal(j.closure.state, "pending");
  assert.equal(j.completion.state, "pending");
  assert.equal(j.readiness.state, "none");
  assert.match(j.requiredNow.title, /افتح جرد التسليم/);
  assert.equal(buildJourney({ ...base, systemValidated: true }).stages.find((s) => s.id === "review")!.state, "skipped");
});

test("pending signatures come from authoritative acknowledgements and skip uncounted lines", () => {
  const lines = [{ id: "a", disposition: "VARIANCE_RECORDED" }, { id: "b", disposition: "COUNTED" }, { id: "c", disposition: "PENDING" }];
  assert.deepEqual(pendingSignatureLineIds(lines, []), ["a", "b"]);
  assert.deepEqual(pendingSignatureLineIds(lines, [{ stockCountLineId: "a" }]), ["b"], "a partly signed batch continues with what is left");
  assert.deepEqual(pendingSignatureLineIds(lines, [{ stockCountLineId: "a" }, { stockCountLineId: "b" }]), []);
});
