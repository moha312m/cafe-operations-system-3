// Navigation hints only. The existing services remain the transition authority.
export function handoverStep(status: string, countStatus: string | null) {
  if (status === "COMPLETED") return "complete";
  if (["OUTGOING_SUBMITTED", "INCOMING_REVIEW"].includes(status)) return "receive";
  if (status === "REJECTED") return "count";
  if (!["DRAFT", "REJECTED"].includes(status)) return "unknown";
  if (countStatus === "CONFIRMED") return "submit";
  if (["SUBMITTED", "RECOUNT_REQUIRED"].includes(countStatus ?? "")) return "review";
  return "count";
}

/**
 * What the incoming person is told while their shift waits for the stock
 * handover. It names the ONE thing still missing, from the real count status,
 * instead of repeating the whole procedure. Text only: nothing here decides a
 * transition and no quantity is involved.
 */
export function handoverBlockMessage(h: {
  status: string;
  countStatus: string | null;
  outgoingName: string;
  /** null when the row does not carry it: never print an invented shift number. */
  outgoingShiftNumber: number | null;
}): string {
  const head = `${h.outgoingShiftNumber === null ? "الشيفت السابق" : `شيفت #${h.outgoingShiftNumber}`} مقفول ماليًا، وتسليم المخزون لم يكتمل.`;
  const who = h.outgoingName;
  switch (handoverStep(h.status, h.countStatus)) {
    case "count":
      if (h.status === "REJECTED") return `${head} التسليم اترجع للمراجعة: المطلوب من ${who} فتح جرد إعادة التسليم.`;
      return h.countStatus === null
        ? `${head} المطلوب من ${who}: فتح جرد التسليم وتسجيل الكميات الفعلية.`
        : `${head} ${who} بدأ الجرد ولم يكمله: المطلوب تسجيل كمية كل صنف مطلوب ثم إرسال الجرد.`;
    case "review":
      return `${head} ${who} أرسل الجرد، وهو بانتظار اعتماد مسؤول بصلاحية تأكيد الجرد.`;
    case "submit":
      return `${head} الجرد اتعمل واتأكد ✓. باقي خطوة واحدة: ${who} يضغط «تقديم العهدة للمستلم» من صفحة التسليم.`;
    case "receive":
      return `${head} المطلوب من مستلم العهدة: مراجعة الأصناف وتأكيد الاستلام بصلاحية الاستلام.`;
    default:
      return `${head} افتح صفحة التسليم لمعرفة الخطوة المتبقية.`;
  }
}

export function pendingHandover<T extends { id: string; branchId: string; status: string }>(rows: T[], branchId: string): T | null {
  const pending = rows.filter(row => row.branchId === branchId &&
    ["DRAFT", "REJECTED", "OUTGOING_SUBMITTED", "INCOMING_REVIEW"].includes(row.status));
  return pending.length === 1 ? pending[0] : null;
}
