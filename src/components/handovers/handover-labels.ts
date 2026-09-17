// Shared vocabulary for the handover screens.
//
// The status list mirrors the Prisma enum. It matters more than a label map
// usually does: `GET /api/handovers/:id` REFUSES with 409 for anything that
// is not under review, so the list has to know which rows can be opened at
// all rather than letting somebody click into an error.

export const HANDOVER_STATUSES = [
  "DRAFT",
  "OUTGOING_SUBMITTED",
  "INCOMING_REVIEW",
  "ACCEPTED",
  "REJECTED",
  "MANAGER_EXCEPTION",
  "COMPLETED",
] as const;
export type HandoverStatus = (typeof HANDOVER_STATUSES)[number];

export const HANDOVER_STATUS_LABEL: Record<HandoverStatus, string> = {
  DRAFT: "مسودة",
  OUTGOING_SUBMITTED: "اتسلّم — مستني المراجعة",
  INCOMING_REVIEW: "تحت المراجعة",
  ACCEPTED: "اتستلم",
  REJECTED: "اترفض — إعادة جرد",
  MANAGER_EXCEPTION: "استثناء مدير",
  COMPLETED: "مكتمل",
};

/**
 * The only two statuses the detail endpoint will open.
 *
 * `getIncomingHandoverView` answers 409 "التسليم مش في مرحلة مراجعة" for
 * every other status, and a COMPLETED handover is deliberately unreadable
 * there. Rows outside this set are listed but not clickable.
 */
export const REVIEWABLE: readonly HandoverStatus[] = [
  "OUTGOING_SUBMITTED",
  "INCOMING_REVIEW",
];

export const TARGET_LABEL: Record<string, string> = {
  SHIFT_TO_SHIFT: "وردية لوردية",
  BRANCH_CUSTODY: "عهدة الفرع",
};

/**
 * A retry key for the acceptance routes.
 *
 * `accept`, `override-accept` and `to-branch-custody` all require one, and
 * reuse of the SAME key on an already-completed handover is what makes a
 * retry safe rather than a second acceptance. It is generated once per
 * attempt and sent as given.
 */
export function newIdempotencyKey(): string {
  return `ui-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}
