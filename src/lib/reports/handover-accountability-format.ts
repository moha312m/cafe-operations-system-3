// Presentation rules for the handover accountability report, shared by the
// screen, the print page, CSV and XLSX so they cannot disagree.
// R8: Western digits everywhere, money as `1,234.50 ج.م`, quantities with their
// unit, dates `05/11/2026`, times `5:06 م`, all on Cairo time.
import { DEFAULT_TZ } from "@/lib/date-range";

export const REPORT_TZ = DEFAULT_TZ;
export const NOT_RECORDED = "لم يُسجَّل";
export const HIDDEN = "مخفي";

// Labels live here, not in the server module, so the client page can use them.
export const PERIOD_LABELS = {
  today: "اليوم", yesterday: "أمس", this_week: "هذا الأسبوع", this_month: "الشهر الحالي", last_month: "الشهر الماضي", custom: "فترة مخصصة",
} as const;
export const MODE_LABELS = {
  DIRECT: "مباشر", RECOUNT: "بعدّ المستلم", BRANCH_CUSTODY: "عهدة الفرع", NO_HANDOVER: "إقفال بدون تسليم",
} as const;
export const EXCEPTION_LABELS = {
  OPENING_WITHOUT_RECEIPT: "فتح شيفت بدون استلام مسجل",
  CLOSE_WITHOUT_COUNT: "إقفال بدون عدّ نقدية",
  NO_DISPOSITION: "لم يُسجَّل مصير النقدية",
  HANDOVER_PENDING: "تسليم لم يُستلم بعد",
  RECEIPT_PENDING: "استلام نقدية الليل لم يكتمل",
  DELIVERY_PENDING: "توريد بانتظار التأكيد",
  DELIVERY_DISPUTED: "نزاع على توريد",
  ISSUE_OPEN: "مشكلة تسليم مفتوحة",
  STOCK_NOT_COUNTED: "خامات لم تُعدّ عند التسليم — الفرق غير معروف",
  STOCK_UNPRICED: "فرق خامات بدون تكلفة مسجلة",
} as const;
export const HANDOVER_STATUS_LABELS: Record<string, string> = {
  DRAFT: "مسودة", OUTGOING_SUBMITTED: "قدّمه المُسلِّم", INCOMING_REVIEW: "قيد مراجعة المستلم", ACCEPTED: "مستلم", REJECTED: "مرفوض", MANAGER_EXCEPTION: "استثناء مدير", COMPLETED: "مكتمل",
};
export const CASE_STATUS_LABELS: Record<string, string> = {
  OPEN: "مفتوحة", UNDER_INVESTIGATION: "قيد التحقيق", RESPONSIBILITY_ASSIGNED: "حُدد المسؤول", APPROVED: "معتمدة", RESOLVED: "محلولة", WAIVED: "متنازل عنها",
};
export const PLACE_STATUS_LABELS: Record<string, string> = {
  ACCEPTED: "تم الاستلام", OVERRIDDEN: "اعتماد استثنائي", FAULT: "عطل مسجل", IN_PROGRESS: "جار الفحص", PENDING: "منتظر الفحص", NOT_RECORDED,
};

export const UNIT_LABELS: Record<string, string> = {
  GRAM: "جم", KG: "كجم", ML: "مل", LITER: "لتر", PIECE: "قطعة", BOX: "علبة", BAG: "كيس",
};

const moneyFormat = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const qtyFormat = new Intl.NumberFormat("en-US", { minimumFractionDigits: 3, maximumFractionDigits: 3 });
const intFormat = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

/** `1,234.50 ج.م`. A negative sign leads, so it reads the same in RTL text. */
export function formatMoney(value: number): string {
  return `${moneyFormat.format(value)} ج.م`;
}
export function formatAmount(value: number): string {
  return moneyFormat.format(value);
}
export function formatQuantity(value: number, unit: string | null): string {
  return unit ? `${qtyFormat.format(value)} ${UNIT_LABELS[unit] ?? unit}` : qtyFormat.format(value);
}
export function formatCount(value: number): string {
  return intFormat.format(value);
}

function parts(at: Date | string) {
  const date = typeof at === "string" ? new Date(at) : at;
  const p = new Intl.DateTimeFormat("en-GB", {
    timeZone: REPORT_TZ, day: "2-digit", month: "2-digit", year: "numeric", hour: "numeric", minute: "2-digit", hourCycle: "h12",
  }).formatToParts(date);
  const get = (type: string) => p.find((x) => x.type === type)?.value ?? "";
  return { day: get("day"), month: get("month"), year: get("year"), hour: get("hour"), minute: get("minute"), pm: get("dayPeriod").toLowerCase().startsWith("p") };
}
/** `05/11/2026` in Cairo. */
export function formatDate(at: Date | string): string {
  const p = parts(at);
  return `${p.day}/${p.month}/${p.year}`;
}
/** `5:06 م` in Cairo. */
export function formatTime(at: Date | string): string {
  const p = parts(at);
  return `${Number(p.hour)}:${p.minute} ${p.pm ? "م" : "ص"}`;
}
export function formatDateTime(at: Date | string): string {
  return `${formatDate(at)} ${formatTime(at)}`;
}
/** `YYYY-MM-DD` → `05/11/2026`, without a time-zone round trip. */
export function formatDateStr(dateStr: string): string {
  const [y, m, d] = dateStr.split("-");
  return `${d}/${m}/${y}`;
}

/**
 * Excel's serial date for an instant, in Cairo wall-clock time, so the cell
 * shows the same date and time the screen does.
 */
export function excelSerial(at: Date | string): number {
  const date = typeof at === "string" ? new Date(at) : at;
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone: REPORT_TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: string) => Number(p.find((x) => x.type === type)?.value ?? 0);
  const wall = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return Math.round(((wall - Date.UTC(1899, 11, 30)) / 86400000) * 1e6) / 1e6;
}
