// ── Handover activity timeline (read-only) ─────────────────────────────
// Built only from events that were actually recorded (the audit log), never inferred.
// No quantity is ever read from an event: the blind-count rule stays with the view
// service, and this timeline names who did what and when, plus the manager's
// written reason where one was recorded. A handover from before an event was
// recorded simply has no row for it, and the screen says so instead of filling it in.
import { db } from "@/lib/db";

export type ActivityEvent = { at: string; action: string; label: string; actor: string | null; detail: string | null };

const LABELS: Record<string, string> = {
  SHIFT_CLOSED: "إقفال الشيفت ماليًا",
  HANDOVER_STARTED: "فتح التسليم",
  COUNT_STARTED: "بدء جرد التسليم",
  COUNT_SUBMITTED: "إرسال الجرد",
  COUNT_CONFIRMED: "اعتماد الجرد",
  COUNT_LOCKED: "قفل الجرد",
  HANDOVER_SUBMITTED: "تقديم العهدة",
  HANDOVER_LINE_ACKNOWLEDGED: "توقيع سطر جرد",
  HANDOVER_SHEET_ACKNOWLEDGED: "توقيع ورقة الاستلام",
  HANDOVER_RECOUNT_REQUESTED: "طلب إعادة جرد",
  HANDOVER_MANAGER_EXCEPTION: "استلام استثنائي / استثناء مدير",
  HANDOVER_ACCEPTED: "اكتمال التسليم",
  HANDOVER_ORDERS_CARRIED: "نقل طلبات مفتوحة مع التسليم",
  SHIFT_CUSTODY_GATE_REDECIDED: "الشيفت المنتظر انتقل للتحقق من العهدة الافتتاحية",
  BRANCH_CUSTODY_VERIFIED: "التحقق من العهدة الافتتاحية",
  CASH_DIFFERENCE_DETECTED: "تسجيل فرق نقدية",
  SHIFT_CASH_DISPOSITION_RECORDED: "تحديد مصير نقدية الإقفال",
  CASH_DELIVERY_DECLARED: "إعلان تسليم نقدية للمالك/المدير",
  CASH_DELIVERY_CONFIRMED: "تأكيد استلام النقدية المُسلَّمة",
  CASH_DELIVERY_DISPUTED: "إبلاغ المستلم عن اختلاف في النقدية المُسلَّمة",
  CASH_DELIVERY_DISPUTE_RESOLVED: "تسوية المالك لاختلاف النقدية المُسلَّمة",
  HANDOVER_DIRECT_CASH_OPENING: "انتقال النقدية المتروكة في الدرج للشيفت المستلم",
  HANDOVER_ISSUE_REPORTED: "الإبلاغ عن اختلاف في التسليم",
  HANDOVER_ISSUE_RESOLVED: "مراجعة وإقفال بلاغ اختلاف",
};
const ACTIONS = Object.keys(LABELS);

export async function handoverActivity(args: { cafeId: string; handoverId: string; outgoingShiftId: string; countSessionIds: string[]; incomingShiftId: string | null }): Promise<ActivityEvent[]> {
  const shiftIds = [args.outgoingShiftId, ...(args.incomingShiftId ? [args.incomingShiftId] : [])];
  const rows = await db.auditLog.findMany({
    where: {
      cafeId: args.cafeId, action: { in: ACTIONS },
      OR: [
        { entity: "HandoverSession", entityId: args.handoverId },
        // A per-line signature is recorded against the acknowledgement row, with the handover named in its details.
        { entity: "HandoverStockAcknowledgement", details: { path: ["handoverId"], equals: args.handoverId } },
        { entity: "Shift", entityId: { in: shiftIds } },
        // A shift that was waiting and carried to opening verification by this handover's conversion.
        { entity: "Shift", action: "SHIFT_CUSTODY_GATE_REDECIDED", details: { path: ["handoverId"], equals: args.handoverId } },
        { entity: "ShiftCashDisposition", details: { path: ["shiftId"], equals: args.outgoingShiftId } },
        { entity: "CashDeliveryDeclaration", details: { path: ["shiftId"], equals: args.outgoingShiftId } },
        { entity: "HandoverIssue", details: { path: ["handoverId"], equals: args.handoverId } },
        ...(args.countSessionIds.length ? [{ entity: "StockCountSession", entityId: { in: args.countSessionIds } }] : []),
      ],
    },
    orderBy: { createdAt: "asc" }, take: 500,
    select: { action: true, createdAt: true, details: true, user: { select: { name: true } } },
  });
  return rows.map((r) => {
    const d = (r.details && typeof r.details === "object" ? r.details : {}) as Record<string, unknown>;
    const note = typeof d.note === "string" && d.note.trim() ? d.note.trim() : null;
    const desc = typeof d.description === "string" && d.description.trim() ? d.description.trim() : null;
    const detail = r.action === "HANDOVER_MANAGER_EXCEPTION" ? note
      : r.action === "HANDOVER_RECOUNT_REQUESTED" && typeof d.disputedCount === "number" ? `${d.disputedCount} سطر معترض عليه`
      : r.action === "HANDOVER_ORDERS_CARRIED" && typeof d.count === "number" ? `${d.count} طلب`
      : r.action === "HANDOVER_ACCEPTED" && d.acceptanceMode === "DIRECT_ACKNOWLEDGEMENT" ? "إقرار استلام مباشر (بدون عدّ مستقل)"
      : r.action === "CASH_DELIVERY_DISPUTED" || r.action === "CASH_DELIVERY_DISPUTE_RESOLVED" || r.action === "HANDOVER_ISSUE_RESOLVED" ? note
      : r.action === "HANDOVER_ISSUE_REPORTED" ? desc : null;
    return { at: r.createdAt.toISOString(), action: r.action, label: LABELS[r.action] ?? r.action, actor: r.user?.name ?? null, detail };
  });
}
