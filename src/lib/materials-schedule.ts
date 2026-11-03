// HND-UX-004 — when the owner-selected materials are counted at a shift close.
//
// Money is reconciled at every close. Materials follow their own cadence,
// chosen by the owner per branch: EVERY_SHIFT (how every handover-enabled
// branch already behaved), DAILY or WEEKLY. This module answers one question
// for a close: is a materials count owed now, and for which business periods?
//
// ── PERIODS ──
//
// A DAILY period is a business date; a WEEKLY period is the business date of
// the chosen weekday. Business dates use the existing operational day
// (`businessDateInTz`, which rolls over at 03:00 local), so a cutoff of 01:30
// belongs to the business day that started the previous morning.
//
// A period becomes claimable at its cutoff instant. The first shift closing at
// or after that instant claims every period still owed up to the latest
// claimable one. Missed periods do not disappear: they are claimed by the next
// close, and that ONE count covers them all. Nothing here fabricates separate
// counts for the missed days, and nothing backdates the observation — the count
// happens when it happens and covers the time since the previous verified one.
//
// ── ONE CLAIM PER PERIOD ──
//
// The claim is a `ShiftMaterialsDecision` row whose `periodTo` is the last
// period it covers. Closes at one branch are serialised by the exclusive
// inventory lock the close takes before deciding, and the partial unique index
// on (branchId, cadence, periodTo) is the backstop: a retry or a racing close
// that computed the same period loses rather than satisfying it twice.
//
// ── WHAT IS NOT DECIDED HERE ──
//
// The scope (which items) is the existing selected-items / full-count
// configuration, snapshotted on the handover. The optional periodic FULL count
// keeps its own schedule (`fullCountDue`); when it is due together with the
// selected count, one FULL count satisfies both, and the decision says so.

import type { MaterialsCountCadence, Prisma } from "@prisma/client";
import { ApiError } from "@/lib/api";
import { addDays, businessDateInTz, DEFAULT_TZ, zonedDateTime } from "@/lib/date-range";

export type MaterialsSchedule = {
  cadence: MaterialsCountCadence;
  weekday: number | null;
  cutoff: string | null;
  since: Date | null;
  timezone: string;
};

export type MaterialsDecisionReason = "EVERY_SHIFT" | "PERIOD_DUE" | "FULL_COUNT_DUE" | "BRANCH_CUSTODY" | "NOT_DUE";

export type MaterialsDecision = {
  due: boolean;
  reason: MaterialsDecisionReason;
  periodFrom: string | null;
  periodTo: string | null;
  nextDueAt: Date | null;
};

export const CUTOFF_RE = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
/** Same rollover as `businessDateInTz`. */
const BUSINESS_DAY_START = "03:00";

function weekdayOf(dateStr: string): number {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** The instant a period's count becomes claimable. */
export function periodCutoffInstant(periodKey: string, cutoff: string, timezone: string): Date {
  // Business day D runs from D 03:00 to D+1 03:00 local, so an early-morning
  // cutoff sits on the next calendar date.
  const date = cutoff < BUSINESS_DAY_START ? addDays(periodKey, 1) : periodKey;
  return zonedDateTime(`${date}T${cutoff}`, timezone).at;
}

function step(cadence: MaterialsCountCadence): number {
  return cadence === "WEEKLY" ? 7 : 1;
}

function assertPeriodic(s: MaterialsSchedule): asserts s is MaterialsSchedule & { cutoff: string } {
  if (!s.cutoff || !CUTOFF_RE.test(s.cutoff)) throw new ApiError(409, "إعداد جرد الخامات ناقص: حدّد وقت الجرد");
  if (s.cadence === "WEEKLY" && (s.weekday === null || s.weekday < 0 || s.weekday > 6)) {
    throw new ApiError(409, "إعداد جرد الخامات ناقص: حدّد يوم الجرد الأسبوعي");
  }
}

/** The latest period whose cutoff is at or before `at`, or null. */
export function latestClaimablePeriod(at: Date, s: MaterialsSchedule): string | null {
  assertPeriodic(s);
  const today = businessDateInTz(at, s.timezone);
  for (let back = 0; back <= 8; back += 1) {
    const d = addDays(today, -back);
    if (s.cadence === "WEEKLY" && weekdayOf(d) !== s.weekday) continue;
    if (periodCutoffInstant(d, s.cutoff, s.timezone).getTime() <= at.getTime()) return d;
  }
  return null;
}

/** The first period whose cutoff is at or after `since`. */
export function firstPeriodFrom(since: Date, s: MaterialsSchedule): string {
  assertPeriodic(s);
  const start = addDays(businessDateInTz(since, s.timezone), -1);
  for (let ahead = 0; ahead <= 9; ahead += 1) {
    const d = addDays(start, ahead);
    if (s.cadence === "WEEKLY" && weekdayOf(d) !== s.weekday) continue;
    if (periodCutoffInstant(d, s.cutoff, s.timezone).getTime() >= since.getTime()) return d;
  }
  throw new Error("materials schedule: no period found");
}

/**
 * Pure decision. `lastClaimedPeriod` is the latest period already claimed for
 * this branch and cadence (null when none).
 */
export function decideMaterialsCount(args: {
  at: Date;
  schedule: MaterialsSchedule;
  lastClaimedPeriod: string | null;
}): MaterialsDecision {
  const s = args.schedule;
  if (s.cadence === "EVERY_SHIFT") {
    return { due: true, reason: "EVERY_SHIFT", periodFrom: null, periodTo: null, nextDueAt: null };
  }
  assertPeriodic(s);
  const latest = latestClaimablePeriod(args.at, s);
  const afterClaim = args.lastClaimedPeriod ? addDays(args.lastClaimedPeriod, step(s.cadence)) : null;
  const fromSince = s.since ? firstPeriodFrom(s.since, s) : null;
  // The earliest period still owed: after the last claim, never before the
  // schedule existed. With neither known, only the latest period is owed.
  const owedFrom = [afterClaim, fromSince].filter((v): v is string => v !== null).sort().at(-1) ?? latest;

  if (latest && owedFrom && latest >= owedFrom) {
    return {
      due: true,
      reason: "PERIOD_DUE",
      periodFrom: owedFrom,
      periodTo: latest,
      nextDueAt: periodCutoffInstant(addDays(latest, step(s.cadence)), s.cutoff, s.timezone),
    };
  }
  const next = owedFrom ?? (latest ? addDays(latest, step(s.cadence)) : null);
  return {
    due: false,
    reason: "NOT_DUE",
    periodFrom: null,
    periodTo: null,
    nextDueAt: next ? periodCutoffInstant(next, s.cutoff, s.timezone) : null,
  };
}

export async function readMaterialsSchedule(
  tx: Pick<Prisma.TransactionClient, "branch">,
  branchId: string,
): Promise<MaterialsSchedule> {
  const branch = await tx.branch.findUniqueOrThrow({
    where: { id: branchId },
    select: { materialsCountCadence: true, materialsCountWeekday: true, materialsCountCutoff: true, materialsScheduleSince: true },
  });
  return {
    cadence: branch.materialsCountCadence,
    weekday: branch.materialsCountWeekday,
    cutoff: branch.materialsCountCutoff,
    since: branch.materialsScheduleSince,
    // The same zone the existing periodic full-count schedule resolves in.
    timezone: DEFAULT_TZ,
  };
}

export type ResolvedMaterialsDecision = MaterialsDecision & {
  schedule: MaterialsSchedule;
  fullCountDue: boolean;
  coverageFrom: Date | null;
};

/**
 * Decide inside the close's transaction. The caller must already hold the
 * branch's exclusive inventory lock, so no other close at this branch can be
 * deciding at the same time.
 */
export async function resolveMaterialsDecision(
  tx: Prisma.TransactionClient,
  args: { branchId: string; at: Date; fullCountDue: boolean; branchCustodyNeedsHandover?: boolean },
): Promise<ResolvedMaterialsDecision> {
  const schedule = await readMaterialsSchedule(tx, args.branchId);
  const lastClaim = schedule.cadence === "EVERY_SHIFT"
    ? null
    : await tx.shiftMaterialsDecision.findFirst({
        where: { branchId: args.branchId, cadence: schedule.cadence, periodTo: { not: null } },
        orderBy: { periodTo: "desc" },
        select: { periodTo: true },
      });
  const base = decideMaterialsCount({ at: args.at, schedule, lastClaimedPeriod: lastClaim?.periodTo ?? null });
  // The physical observation this count is measured from: the last outgoing
  // count that was actually handed over at this branch.
  const previous = await tx.shiftMaterialsDecision.findFirst({
    where: { branchId: args.branchId, satisfiedAt: { not: null } },
    orderBy: { satisfiedAt: "desc" },
    select: { satisfiedAt: true },
  });
  // A separately due FULL count is its own trigger. A branch-custody close
  // is counted only when overnight drawer storage needs the branch-custody
  // handover to exist (see the close); otherwise ending the night does not
  // make materials due.
  const decision: MaterialsDecision = base.due
    ? base
    : args.fullCountDue
      ? { ...base, due: true, reason: "FULL_COUNT_DUE" }
      : args.branchCustodyNeedsHandover
        ? { ...base, due: true, reason: "BRANCH_CUSTODY" }
        : base;
  return { ...decision, schedule, fullCountDue: args.fullCountDue, coverageFrom: previous?.satisfiedAt ?? null };
}

/** Persist the close's decision. A lost period race is a 409 the closer can retry. */
export async function recordMaterialsDecision(
  tx: Prisma.TransactionClient,
  args: { cafeId: string; branchId: string; shiftId: string; handoverId: string | null; at: Date; decision: ResolvedMaterialsDecision },
): Promise<{ id: string }> {
  const d = args.decision;
  try {
    return await tx.shiftMaterialsDecision.create({
      data: {
        cafeId: args.cafeId,
        branchId: args.branchId,
        shiftId: args.shiftId,
        handoverId: args.handoverId,
        cadence: d.schedule.cadence,
        weekday: d.schedule.weekday,
        cutoff: d.schedule.cutoff,
        timezone: d.schedule.timezone,
        due: d.due,
        reason: d.reason,
        fullCountDue: d.fullCountDue,
        periodFrom: d.periodFrom,
        periodTo: d.periodTo,
        coverageFrom: d.coverageFrom,
        nextDueAt: d.nextDueAt,
        decidedAt: args.at,
      },
      select: { id: true },
    });
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === "P2002" || code === "23505") {
      throw new ApiError(409, "جرد الفترة دي اتسجل من قفل تاني — جرّب تاني");
    }
    throw e;
  }
}

/** The outgoing count was handed over: the claimed period is satisfied. */
export async function markMaterialsSatisfied(
  tx: Prisma.TransactionClient,
  args: { handoverId: string; at: Date },
): Promise<void> {
  await tx.shiftMaterialsDecision.updateMany({
    where: { handoverId: args.handoverId, satisfiedAt: null },
    data: { satisfiedAt: args.at },
  });
}

export { materialsDecisionLabel } from "@/lib/materials-labels";
