// Shared vocabulary for the stock-count screens.
//
// Each map mirrors an enum the server owns (`src/lib/stock-count.ts`,
// `src/lib/count-disposition.ts`). Mirrored for wording and for deciding
// which buttons are worth drawing — never for deciding what is allowed. The
// service re-checks every transition inside its transaction and refuses
// regardless of what this file lets somebody press.

export const COUNT_STATUSES = [
  "DRAFT",
  "IN_PROGRESS",
  "SUBMITTED",
  "RECOUNT_REQUIRED",
  "CONFIRMED",
  "LOCKED",
] as const;
export type CountStatus = (typeof COUNT_STATUSES)[number];

export const COUNT_STATUS_LABEL: Record<CountStatus, string> = {
  DRAFT: "مسودة",
  IN_PROGRESS: "جاري العد",
  SUBMITTED: "اتسلّم",
  RECOUNT_REQUIRED: "محتاج إعادة عد",
  CONFIRMED: "متأكد",
  LOCKED: "مقفول",
};

export type CountType = "CRITICAL" | "FULL";
export const COUNT_TYPE_LABEL: Record<CountType, string> = {
  CRITICAL: "أصناف حرجة",
  FULL: "جرد كامل",
};

export const DISPOSITIONS = [
  "PENDING",
  "COUNTED",
  "WITHIN_TOLERANCE",
  "OUTSIDE_TOLERANCE",
  "RECOUNT_REQUIRED",
  "RESOLVED_WITHIN_TOLERANCE",
  "VARIANCE_CONFIRMED",
] as const;
export type Disposition = (typeof DISPOSITIONS)[number];

export const DISPOSITION_LABEL: Record<Disposition, string> = {
  PENDING: "لسه ما اتعدش",
  COUNTED: "اتعد",
  WITHIN_TOLERANCE: "داخل السماحية",
  OUTSIDE_TOLERANCE: "خارج السماحية",
  RECOUNT_REQUIRED: "محتاج إعادة عد",
  RESOLVED_WITHIN_TOLERANCE: "اترجع للسماحية",
  VARIANCE_CONFIRMED: "فرق معتمد",
};

/** Lines the service will not move again. */
export const TERMINAL_DISPOSITIONS: readonly Disposition[] = [
  "WITHIN_TOLERANCE",
  "RESOLVED_WITHIN_TOLERANCE",
  "VARIANCE_CONFIRMED",
];

/** A session that still takes counts. CONFIRMED and LOCKED do not. */
export const OPEN_FOR_CAPTURE: readonly CountStatus[] = [
  "DRAFT",
  "IN_PROGRESS",
  "SUBMITTED",
  "RECOUNT_REQUIRED",
];

/** Only a submitted count can be confirmed. */
export const CONFIRMABLE: readonly CountStatus[] = ["SUBMITTED", "RECOUNT_REQUIRED"];

/** Recount and accept-variance both start from an unsettled disagreement. */
export const DISPUTED_DISPOSITIONS: readonly Disposition[] = [
  "OUTSIDE_TOLERANCE",
  "RECOUNT_REQUIRED",
];
