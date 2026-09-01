// Count policy, and the server's sole authority over what is in scope.
//
// Two refusals live here, for the same underlying reason: a count that can be
// steered is not evidence of anything.
//
// SCOPE. `resolveCountScope` takes no item list — not "ignores one", takes
// none, by signature. If a caller could name the items, a custodian could
// omit the short one and the count would come back clean by construction.
// Scope is derived instead from the owner's own configuration: FULL is every
// eligible item at the branch, CRITICAL is the subset the owner marked. That
// is exactly why `InventoryItem.isCritical` is owner configuration (T8)
// rather than something a request supplies.
//
// CYCLE. Spec §3 lists cycle counting among the configurable policies, so the
// enum keeps it and `resolveStockCountPolicy` reports it faithfully — an
// owner who selected it should see it selected. But no cycle engine exists,
// so the two functions that would ACT on it refuse by name. Silently running
// a FULL count and labelling it a cycle would let an owner believe cycle
// counting was happening when nothing was, which is worse than the feature
// being absent.

import type {
  PeriodicFullCountSchedule, Prisma, StockCountPolicy, StockCountType, StockCountMode,
} from "@prisma/client";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/api";
import { getCafeSettings } from "@/lib/cafe-settings";
import { businessDateInTz, DEFAULT_TZ } from "@/lib/date-range";
import { resolveBranchHandoverConfigReadOnly } from "@/lib/handover-config";

/** 400, and it names CYCLE, so the refusal is legible to the person who hit it. */
export class UnsupportedCountPolicyError extends ApiError {
  constructor(
    message = "العد الدوري (CYCLE) لسه مش مدعوم — اختار CRITICAL أو FULL"
  ) {
    super(400, message);
    this.name = "UnsupportedCountPolicyError";
  }
}

type PolicyField = "policy" | "handoverCountType" | "periodicCountType" | "mode";

export type ResolvedStockCountPolicy = {
  policy: StockCountPolicy;
  handoverCountType: StockCountType;
  periodicCountType: StockCountType;
  mode: StockCountMode;
  /**
   * Where each field came from. An owner looking at a branch that behaves
   * unexpectedly needs to know whether it was configured or is merely
   * inheriting, and the value alone cannot tell them.
   */
  source: Record<PolicyField, "CAFE" | "BRANCH">;
};

/** Café setting unless the branch overrode it; NULL means inherit. */
function pick<T>(cafeValue: T, branchOverride: T | null): { value: T; from: "CAFE" | "BRANCH" } {
  return branchOverride === null || branchOverride === undefined
    ? { value: cafeValue, from: "CAFE" }
    : { value: branchOverride, from: "BRANCH" };
}

export async function resolveStockCountPolicy(
  cafeId: string,
  branchId: string
): Promise<ResolvedStockCountPolicy> {
  const [settings, branch] = await Promise.all([
    getCafeSettings(cafeId),
    db.branch.findUniqueOrThrow({
      where: { id: branchId },
      select: {
        cafeId: true,
        stockCountPolicyOverride: true,
        handoverCountTypeOverride: true,
        periodicCountTypeOverride: true,
        stockCountModeOverride: true,
      },
    }),
  ]);

  // A branch of another café must never inherit this café's policy.
  if (branch.cafeId !== cafeId) {
    throw new ApiError(400, "الفرع مش تابع للكافيه");
  }

  const policy = pick(settings.stockCountPolicy, branch.stockCountPolicyOverride);
  const handover = pick(settings.handoverCountType, branch.handoverCountTypeOverride);
  const periodic = pick(settings.periodicCountType, branch.periodicCountTypeOverride);
  const mode = pick(settings.stockCountMode, branch.stockCountModeOverride);

  return {
    policy: policy.value,
    handoverCountType: handover.value,
    periodicCountType: periodic.value,
    mode: mode.value,
    source: {
      policy: policy.from,
      handoverCountType: handover.from,
      periodicCountType: periodic.from,
      mode: mode.from,
    },
  };
}

export type ResolvedPeriodicFullCount = {
  schedule: PeriodicFullCountSchedule;
  weekday: number | null;
  source: Record<"schedule" | "weekday", "CAFE" | "BRANCH">;
};

/** The handover intent is supplied by the caller; no Shift state is inferred. */
export type PeriodicFullCountTarget = "SHIFT_TO_SHIFT" | "BRANCH_CUSTODY";

export type FullCountDueVerdict = {
  due: boolean;
  businessDate: string;
  target: PeriodicFullCountTarget;
  reason:
    | "MANUAL_ONLY"
    | "SHIFT_TO_SHIFT"
    | "DAILY_BRANCH_CUSTODY"
    | "WEEKLY_MATCHING_BRANCH_CUSTODY"
    | "WEEKLY_NON_MATCHING_WEEKDAY";
  schedule: PeriodicFullCountSchedule;
  weekday: number | null;
};

type FullCountDueArgs = {
  cafeId: string;
  branchId: string;
  at: Date;
  target: PeriodicFullCountTarget;
};

export async function resolvePeriodicFullCount(
  cafeId: string,
  branchId: string,
): Promise<ResolvedPeriodicFullCount> {
  const [settings, branch] = await Promise.all([
    getCafeSettings(cafeId),
    db.branch.findUniqueOrThrow({
      where: { id: branchId },
      select: {
        cafeId: true,
        periodicFullCountScheduleOverride: true,
        periodicFullCountWeekdayOverride: true,
      },
    }),
  ]);

  if (branch.cafeId !== cafeId) {
    throw new ApiError(400, "Ø§Ù„ÙØ±Ø¹ Ù…Ø´ ØªØ§Ø¨Ø¹ Ù„Ù„ÙƒØ§ÙÙŠÙ‡");
  }

  const schedule = pick(
    settings.periodicFullCountSchedule,
    branch.periodicFullCountScheduleOverride,
  );
  // Schedule and weekday are a constrained configuration pair. A branch's
  // non-null schedule override therefore owns the paired weekday too: a
  // DAILY/MANUAL override intentionally resolves to NULL rather than leaking
  // a weekly weekday inherited from its cafe.
  const weekday = branch.periodicFullCountScheduleOverride === null
    ? { value: settings.periodicFullCountWeekday, from: "CAFE" as const }
    : { value: branch.periodicFullCountWeekdayOverride, from: "BRANCH" as const };
  return {
    schedule: schedule.value,
    weekday: weekday.value,
    source: { schedule: schedule.from, weekday: weekday.from },
  };
}

function weekdayForBusinessDate(businessDate: string): number {
  const [year, month, day] = businessDate.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

function fullCountDueFromResolved(
  args: FullCountDueArgs,
  resolved: Pick<ResolvedPeriodicFullCount, "schedule" | "weekday">,
): FullCountDueVerdict {
  const businessDate = businessDateInTz(args.at, DEFAULT_TZ);
  const base = {
    businessDate,
    target: args.target,
    schedule: resolved.schedule,
    weekday: resolved.weekday,
  };

  if (args.target === "SHIFT_TO_SHIFT") {
    return { ...base, due: false, reason: "SHIFT_TO_SHIFT" };
  }
  if (resolved.schedule === "MANUAL_ONLY") {
    return { ...base, due: false, reason: "MANUAL_ONLY" };
  }
  if (resolved.schedule === "DAILY_LAST_HANDOVER") {
    return { ...base, due: true, reason: "DAILY_BRANCH_CUSTODY" };
  }
  return weekdayForBusinessDate(businessDate) === resolved.weekday
    ? { ...base, due: true, reason: "WEEKLY_MATCHING_BRANCH_CUSTODY" }
    : { ...base, due: false, reason: "WEEKLY_NON_MATCHING_WEEKDAY" };
}

export async function fullCountDue(args: {
  cafeId: string;
  branchId: string;
  at: Date;
  target: PeriodicFullCountTarget;
}): Promise<FullCountDueVerdict> {
  const resolved = await resolvePeriodicFullCount(args.cafeId, args.branchId);
  return fullCountDueFromResolved(args, resolved);
}

/** Read-only SH-7 verdict using only the caller's transaction. */
export async function fullCountDueInTransaction(
  tx: Prisma.TransactionClient,
  args: FullCountDueArgs,
): Promise<FullCountDueVerdict> {
  const config = await resolveBranchHandoverConfigReadOnly(tx, args.cafeId, args.branchId);
  return fullCountDueFromResolved(args, config.periodic);
}

/**
 * Whether a handover must be preceded by a count, and of what.
 *
 * HYBRID is a policy that SELECTS a count type; it is never a count type
 * itself. That distinction is why `StockCountType` has only two values.
 */
export function countRequiredForHandover(
  p: ResolvedStockCountPolicy
): { required: boolean; type: StockCountType | null } {
  switch (p.policy) {
    case "NO_SHIFT_COUNT":
      return { required: false, type: null };
    case "CRITICAL":
      return { required: true, type: "CRITICAL" };
    case "FULL":
      return { required: true, type: "FULL" };
    case "HYBRID":
      return { required: true, type: p.handoverCountType };
    case "CYCLE":
      throw new UnsupportedCountPolicyError();
  }
}

/**
 * THE authority on what a count covers.
 *
 * Note the signature: there is no item-id parameter. That is the guarantee,
 * not an implementation detail — a caller cannot narrow the scope because
 * there is nowhere to say so.
 */
type ResolveCountScopeArgs = {
  cafeId: string;
  branchId: string;
  type: StockCountType;
  /** Optional, only so a caller that already resolved policy can pass it. */
  policy?: ResolvedStockCountPolicy;
};

type CountScopeReadClient = Pick<Prisma.TransactionClient, "inventoryItem">;
type CountScope = {
  inventoryItemIds: string[];
  derivation: "ALL_ELIGIBLE" | "CRITICAL_ONLY";
};

async function resolveCountScopeWithClient(
  client: CountScopeReadClient,
  args: ResolveCountScopeArgs,
): Promise<CountScope> {
  if (args.type !== "CRITICAL" && args.type !== "FULL") {
    throw new UnsupportedCountPolicyError(
      `نوع الجرد «${String(args.type)}» غير مدعوم — اختار CRITICAL أو FULL`
    );
  }

  const criticalOnly = args.type === "CRITICAL";
  const items = await client.inventoryItem.findMany({
    where: {
      cafeId: args.cafeId,
      branchId: args.branchId,
      // An archived or deactivated ingredient is not on the shelf, so it is
      // not something a counter can be asked to find.
      archivedAt: null,
      isActive: true,
      ...(criticalOnly ? { isCritical: true } : {}),
    },
    select: { id: true },
    orderBy: { name: "asc" },
  });

  return {
    inventoryItemIds: items.map((i) => i.id),
    derivation: criticalOnly ? "CRITICAL_ONLY" : "ALL_ELIGIBLE",
  };
}

export async function resolveCountScope(args: {
  cafeId: string;
  branchId: string;
  type: StockCountType;
  /** Optional, only so a caller that already resolved policy can pass it. */
  policy?: ResolvedStockCountPolicy;
}): Promise<CountScope> {
  const policy = args.policy ?? (await resolveStockCountPolicy(args.cafeId, args.branchId));
  if (policy.policy === "CYCLE") throw new UnsupportedCountPolicyError();
  return resolveCountScopeWithClient(db, args);
}

/** Read-only server-derived scope using only the caller's transaction. */
export async function resolveCountScopeInTransaction(
  tx: Prisma.TransactionClient,
  args: ResolveCountScopeArgs,
): Promise<CountScope> {
  if (args.policy?.policy === "CYCLE") throw new UnsupportedCountPolicyError();
  if (!args.policy) {
    const config = await resolveBranchHandoverConfigReadOnly(tx, args.cafeId, args.branchId);
    if (config.configError?.code === "CYCLE_POLICY_UNSUPPORTED") {
      throw new UnsupportedCountPolicyError();
    }
  }
  return resolveCountScopeWithClient(tx, args);
}
