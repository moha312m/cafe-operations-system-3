// ── The handover journey, as one readable model ─────────────────────────
// Navigation and wording only: every transition is still decided by the server services
// (`handover.ts`, `custody.ts`, `opening-readiness.ts`). Three things are kept apart on
// purpose, because they really are different facts:
//   1. outgoing FINANCIAL CLOSURE        — the closing shift's money is settled;
//   2. HANDOVER COMPLETION               — the stock handover record is COMPLETED;
//   3. incoming shift OPERATIONAL READINESS — the next shift may use POS (custody gate cleared,
//      opening cash confirmed when a receipt exists, place accepted when the branch requires it).
// Any of the three can be done while another is not, and the screen says which.
import type { ShiftReadiness } from "@/lib/handover-readiness";

export type JourneyTarget = "SHIFT_TO_SHIFT" | "BRANCH_CUSTODY" | null;
export type Panel = "summary" | "cash" | "inventory" | "place" | "orders" | "activity";
export type StageState = "done" | "current" | "pending" | "blocked" | "skipped";
export type Stage = { id: string; group: "closure" | "handover" | "readiness"; label: string; state: StageState; actor: string; note: string | null; panel: Panel };

export type JourneyInput = {
  target: JourneyTarget;
  status: string;
  countStatus: string | null;
  systemValidated: boolean;
  financiallyClosed: boolean;
  disputed: boolean;
  /** Counted lines still awaiting a signature (receiver's or the branch's). */
  unreviewedLines: number;
  /** Lines never counted: not part of the signature. */
  excludedLines: number;
  outgoingName: string;
  incomingShift: { shiftNumber: number; name: string } | null;
  incomingAmbiguous: boolean;
  /** The readiness of the shift this handover feeds (or the single waiting shift). */
  readiness: ShiftReadiness | null;
  can: { submit: boolean; confirmCount: boolean; accept: boolean; exception: boolean };
  viewer: { isOutgoing: boolean; isRecipient: boolean; name: string };
  directHandover?: boolean;
  dispositionRecorded?: boolean;
};

export type RequiredNow = {
  title: string;
  /** Who must do it. */
  actor: string;
  panel: Panel | null;
  actionLabel: string | null;
  /** Why the viewer cannot do it, when that is the case. */
  blocker: string | null;
  /** Other requirements that are independent of this one. */
  parallel: Stage[];
};

export type Journey = {
  stages: Stage[];
  closure: { state: "done" | "pending"; label: string };
  completion: { state: "done" | "pending" | "rejected"; label: string };
  readiness: { state: "operational" | "pending" | "none"; label: string; remaining: string[] };
  requiredNow: RequiredNow;
};

const countPhase = (i: JourneyInput): "count" | "review" | "submit" | "receive" | "complete" => {
  if (i.status === "COMPLETED") return "complete";
  if (["OUTGOING_SUBMITTED", "INCOMING_REVIEW"].includes(i.status)) return "receive";
  if (i.status === "REJECTED") return "count";
  if (i.countStatus === "CONFIRMED") return "submit";
  if (["SUBMITTED", "RECOUNT_REQUIRED"].includes(i.countStatus ?? "")) return "review";
  return "count";
};

export function buildJourney(i: JourneyInput): Journey {
  const branch = i.target === "BRANCH_CUSTODY";
  const phase = countPhase(i);
  const order = ["count", "review", "submit", "receive", "complete"] as const;
  const at = order.indexOf(phase);
  const st = (idx: number, blocked = false): StageState => (at > idx ? "done" : at === idx ? (blocked ? "blocked" : "current") : "pending");

  const stages: Stage[] = [
    { id: "financial-close", group: "closure", label: "إقفال الشيفت ماليًا", state: i.financiallyClosed ? "done" : "pending", actor: i.outgoingName, note: i.financiallyClosed ? null : "الإقفال المالي لم يُسجل بعد.", panel: "cash" },
    { id: "count", group: "handover", label: "جرد المُسلّم", state: st(0), actor: i.outgoingName, note: i.status === "REJECTED" ? "اترجع لإعادة الجرد." : null, panel: "inventory" },
    { id: "review", group: "handover", label: "اعتماد الجرد", state: i.systemValidated ? "skipped" : st(1), actor: "مسؤول بصلاحية تأكيد الجرد", note: i.systemValidated ? "الكميات مطابقة وتحقق منها النظام دون توقيع مسؤول." : null, panel: "inventory" },
    { id: "submit", group: "handover", label: "تقديم العهدة", state: st(2), actor: i.outgoingName, note: null, panel: "inventory" },
    branch
      ? { id: "sign", group: "handover", label: i.unreviewedLines > 0 ? `توقيع باسم الفرع (${i.unreviewedLines} سطر)` : "توقيع سطور الجرد باسم الفرع", state: at < 3 ? "pending" : at > 3 ? "done" : i.unreviewedLines > 0 ? (i.can.accept && i.can.exception ? "current" : "blocked") : "done", actor: "مسؤول بصلاحية الاستثناء", note: "لا يوجد موظف مستلم؛ التوقيع باسم الفرع ولا يُعد عدًّا مستقلًا.", panel: "inventory" }
      : { id: "sign", group: "handover", label: i.unreviewedLines > 0 ? `ورقة الاستلام (${i.unreviewedLines} سطر)` : "ورقة الاستلام", state: at < 3 ? "pending" : at > 3 ? "done" : i.disputed ? "blocked" : i.unreviewedLines > 0 ? (i.viewer.isRecipient && i.can.accept ? "current" : "blocked") : "done", actor: i.incomingShift ? `${i.incomingShift.name} (شيفت #${i.incomingShift.shiftNumber})` : "المستلم", note: i.disputed ? "فيه سطر معترض عليه — اطلب إعادة الجرد." : null, panel: "inventory" },
    { id: "completion", group: "handover", label: branch ? "تحويل لعهدة الفرع" : "تأكيد الاستلام", state: at >= 4 ? "done" : at === 3 && i.unreviewedLines === 0 && !i.disputed ? "current" : "pending", actor: branch ? "مسؤول بصلاحية الاستثناء" : (i.incomingShift?.name ?? "المستلم"), note: null, panel: "inventory" },
  ];

  // Incoming readiness: only the requirements the server actually reports for the shift.
  const readinessStages: Stage[] = (i.readiness?.requirements ?? []).filter((r) => r.state !== "not-required").map((r) => ({
    id: r.id, group: "readiness" as const, label: r.label,
    // Server rules: the place check is independent of the stock handover and may run any time the shift is open;
    // opening verification and the cash receipt only make sense after the handover is complete.
    state: r.state === "done" ? "done" : r.id === "place-receipt" || phase === "complete" ? "current" : "pending",
    actor: r.id === "cash-receipt" ? "المستلم (أو المالك باعتماد استثنائي)" : r.id === "place-receipt" ? "المستلم المعيّن لفحص المكان" : r.id === "custody" ? (branch ? "تحويل لعهدة الفرع" : "تأكيد الاستلام") : "الشيفت المستلم",
    note: r.detail, panel: r.id === "cash-receipt" ? "cash" : r.id === "place-receipt" ? "place" : "inventory",
  } as Stage));
  // The custody requirement is the handover itself; show it once, as the handover's own stage.
  const readinessOnly = readinessStages.filter((s) => s.id !== "custody");
  stages.push(...readinessOnly);
  if (i.readiness) stages.push({ id: "operational", group: "readiness", label: "الشيفت جاهز للتشغيل", state: i.readiness.operational ? "done" : "pending", actor: `${i.readiness.cashierName} (شيفت #${i.readiness.shiftNumber})`, note: i.readiness.operational ? null : "نقطة البيع ترفض الشيفت لحد ما المتطلبات اللي فوق تكتمل.", panel: "summary" });

  const pendingReadiness = readinessOnly.filter((s) => s.state !== "done");
  const readiness: Journey["readiness"] = !i.readiness
    ? { state: "none", label: i.incomingAmbiguous ? "أكتر من شيفت ممكن يستلم — لازم يتحدد المستلم" : "لا يوجد شيفت مستلم مفتوح حاليًا", remaining: [] }
    : i.readiness.operational ? { state: "operational", label: `شيفت #${i.readiness.shiftNumber} جاهز للتشغيل`, remaining: [] }
    : { state: "pending", label: `شيفت #${i.readiness.shiftNumber} لسه غير جاهز`, remaining: [...(phase !== "complete" ? ["اكتمال تسليم العهدة"] : []), ...pendingReadiness.map((s) => s.label)] };

  const closure: Journey["closure"] = i.financiallyClosed ? { state: "done", label: "الإقفال المالي تم" } : { state: "pending", label: "الإقفال المالي لم يُسجل" };
  const completion: Journey["completion"] = i.status === "COMPLETED" ? { state: "done", label: "تسليم العهدة اكتمل" } : i.status === "REJECTED" ? { state: "rejected", label: "اترجع لإعادة الجرد" } : { state: "pending", label: "تسليم العهدة لسه ما اكتملش" };

  return { stages, closure, completion, readiness, requiredNow: requiredNow(i, phase, stages, pendingReadiness) };
}

function requiredNow(i: JourneyInput, phase: ReturnType<typeof countPhase>, stages: Stage[], pendingReadiness: Stage[]): RequiredNow {
  const branch = i.target === "BRANCH_CUSTODY";
  const parallel = phase === "complete" ? pendingReadiness : pendingReadiness.filter((s) => s.id === "place-receipt");
  const base = { parallel } as const;
  if (phase === "count") {
    const rejected = i.status === "REJECTED";
    return { ...base, title: rejected ? "التسليم اترجع: افتح جرد إعادة التسليم" : i.countStatus === null ? "افتح جرد التسليم وسجّل الكميات الفعلية" : "كمّل الجرد وأرسله", actor: i.outgoingName, panel: "inventory", actionLabel: "فتح الجرد", blocker: i.viewer.isOutgoing && i.can.submit ? null : `ده شغل ${i.outgoingName} (المُسلّم).` };
  }
  if (phase === "review") return { ...base, title: "الجرد مُرسل ومستني الاعتماد", actor: "مسؤول بصلاحية تأكيد الجرد", panel: "inventory", actionLabel: "مراجعة الجرد", blocker: i.can.confirmCount ? null : "اعتماد الجرد يحتاج مسؤولًا بصلاحية تأكيد الجرد." };
  if (phase === "submit") return { ...base, title: i.directHandover && i.dispositionRecorded === false ? "حدّد مصير النقدية ثم قدّم العهدة" : "الجرد معتمد — قدّم العهدة", actor: i.outgoingName, panel: "inventory", actionLabel: "تقديم العهدة", blocker: i.viewer.isOutgoing && i.can.submit ? null : `التقديم من ${i.outgoingName} (المُسلّم).` };
  if (phase === "receive") {
    if (i.disputed) return { ...base, title: "الاستلام معترض عليه — اطلب إعادة الجرد", actor: "مسؤول بصلاحية طلب إعادة الجرد", panel: "inventory", actionLabel: "طلب إعادة الجرد", blocker: null };
    if (i.directHandover && !branch) {
      return {
        ...base,
        title: "راجع ملخص العهدة واضغط «فتح ورديتي واستلام العهدة»",
        actor: i.incomingShift ? `${i.incomingShift.name} (شيفت #${i.incomingShift.shiftNumber})` : "الموظف المستلم",
        panel: "summary",
        actionLabel: "ملخص الاستلام المباشر",
        blocker: i.incomingAmbiguous ? "فيه أكتر من شيفت ممكن يستلم؛ النظام مش هيختار بالنيابة عنك." : null,
      };
    }
    if (branch) {
      const mayAct = i.can.accept && i.can.exception;
      // One press signs the counted lines in the branch's name (each line still recorded with its signer and time) and then converts.
      return { ...base, title: i.unreviewedLines > 0 ? `احفظ العهدة في عهدة الفرع — زر واحد يوقّع ${i.unreviewedLines} سطر جرد باسم الفرع ويحوّلها` : "سطور الجرد موقّعة — احفظ العهدة في عهدة الفرع", actor: "مسؤول بصلاحية الاستثناء (باسم الفرع)", panel: "inventory", actionLabel: "حفظ في عهدة الفرع", blocker: mayAct ? null : "التوقيع والتحويل لعهدة الفرع لمسؤول بصلاحية الاستثناء." };
    }
    if (!i.incomingShift) return { ...base, title: i.incomingAmbiguous ? "حدّد المستلم قبل القبول" : "المستلم يفتح شيفته أولًا", actor: "المستلم", panel: "inventory", actionLabel: null, blocker: i.incomingAmbiguous ? "فيه أكتر من شيفت ممكن يستلم؛ النظام مش هيختار بالنيابة عنك." : "مفيش شيفت مستلم مفتوح في الفرع لتسجيل ورقة الاستلام." };
    return { ...base, title: i.unreviewedLines > 0 ? `راجع ورقة الاستلام (${i.unreviewedLines} سطر)` : "أكّد استلام عهدة الشيفت", actor: `${i.incomingShift.name} (شيفت #${i.incomingShift.shiftNumber})`, panel: "inventory", actionLabel: "فتح ورقة الاستلام", blocker: i.viewer.isRecipient && i.can.accept ? null : `ورقة الاستلام توقيع ${i.incomingShift.name} صاحب الشيفت المستلم.` };
  }
  // The handover is complete: what is left is the next shift's readiness.
  const next = stages.find((s) => s.group === "readiness" && s.id !== "operational" && s.state !== "done");
  if (next) {
    const first = next;
    return { title: first.label, actor: first.actor, panel: first.panel, actionLabel: first.id === "opening-verification" ? "التحقق من العهدة الافتتاحية" : first.id === "cash-receipt" ? "استلام كاش الدرج" : first.id === "place-receipt" ? "استلام المكان" : "فتح", blocker: null, parallel: parallel.filter((s) => s.id !== first.id) };
  }
  if (i.readiness && !i.readiness.operational) return { title: "راجع حالة الشيفت المستلم", actor: i.readiness.cashierName, panel: "summary", actionLabel: null, blocker: "فيه متطلب لم يظهر في القائمة؛ حدّث الصفحة.", parallel: [] };
  return { title: i.readiness ? "التسليم اكتمل والشيفت المستلم جاهز للتشغيل" : "التسليم اكتمل", actor: "—", panel: null, actionLabel: null, blocker: null, parallel: [] };
}

/** The counted lines still to sign, from the authoritative view: never from a screen's memory. */
export function pendingSignatureLineIds(lines: { id: string; disposition: string }[], acknowledgements: { stockCountLineId: string }[]) {
  const signed = new Set(acknowledgements.map((a) => a.stockCountLineId));
  return lines.filter((l) => l.disposition !== "PENDING" && !signed.has(l.id)).map((l) => l.id);
}
