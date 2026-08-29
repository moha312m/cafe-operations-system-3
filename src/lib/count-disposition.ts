// Where a counted line can go, and where it can stop.
//
// The transition map lives here rather than inside the recount engine (T27)
// because the rebase (T23) has to know which lines are settled before that
// engine exists — and because a state machine written down in one place can
// be walked by a test, which is how the defect below stays fixed.
//
// THE defect: an earlier draft refused confirmation while any line was
// unresolved, and offered no transition by which a genuine outside-tolerance
// variance could ever BECOME resolved. A shop with a real 2 kg shortage could
// never close its count — the only way out was to falsify the figure. The
// escape is an explicit terminal disposition, `VARIANCE_CONFIRMED`, reached
// by exhausting recount attempts or by an authorised explicit acceptance.
// COUNT-004 walks this map and fails if any state is stranded.

import type { CountLineDisposition } from "@prisma/client";

/**
 * A settled line. Terminal means the count no longer waits on it — not that
 * the variance was zero: `VARIANCE_CONFIRMED` is a real, accepted shortage.
 */
export const TERMINAL_DISPOSITIONS = [
  "WITHIN_TOLERANCE",
  "RESOLVED_WITHIN_TOLERANCE",
  "VARIANCE_CONFIRMED",
] as const;

export function isTerminal(d: CountLineDisposition): boolean {
  return (TERMINAL_DISPOSITIONS as readonly string[]).includes(d);
}

/**
 * Legal next states. A terminal state leads nowhere — that is what makes it
 * terminal, and the test asserts the empty arrays rather than trusting the
 * name.
 */
export const DISPOSITION_TRANSITIONS: Record<CountLineDisposition, CountLineDisposition[]> = {
  // Nothing counted yet.
  PENDING: ["COUNTED"],
  // A figure exists; tolerance decides which way it goes.
  COUNTED: ["WITHIN_TOLERANCE", "OUTSIDE_TOLERANCE"],
  // Outside tolerance is not yet a verdict: it can be recounted, resolved by
  // a recount that lands inside, or accepted as a real shortage.
  OUTSIDE_TOLERANCE: [
    "RECOUNT_REQUIRED",
    "RESOLVED_WITHIN_TOLERANCE",
    "VARIANCE_CONFIRMED",
  ],
  // A recount either lands inside tolerance, or exhausts its attempts and the
  // variance is confirmed. Both are exits; neither is a dead end.
  RECOUNT_REQUIRED: ["RESOLVED_WITHIN_TOLERANCE", "VARIANCE_CONFIRMED"],

  WITHIN_TOLERANCE: [],
  RESOLVED_WITHIN_TOLERANCE: [],
  VARIANCE_CONFIRMED: [],
};

/** Whether a line may move from one disposition to another. */
export function canTransition(
  from: CountLineDisposition,
  to: CountLineDisposition
): boolean {
  return (DISPOSITION_TRANSITIONS[from] ?? []).includes(to);
}
