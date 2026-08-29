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
  StockCountPolicy, StockCountType, StockCountMode,
} from "@prisma/client";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/api";
import { getCafeSettings } from "@/lib/cafe-settings";

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
export async function resolveCountScope(args: {
  cafeId: string;
  branchId: string;
  type: StockCountType;
  /** Optional, only so a caller that already resolved policy can pass it. */
  policy?: ResolvedStockCountPolicy;
}): Promise<{ inventoryItemIds: string[]; derivation: "ALL_ELIGIBLE" | "CRITICAL_ONLY" }> {
  const policy = args.policy ?? (await resolveStockCountPolicy(args.cafeId, args.branchId));
  if (policy.policy === "CYCLE") throw new UnsupportedCountPolicyError();

  if (args.type !== "CRITICAL" && args.type !== "FULL") {
    throw new UnsupportedCountPolicyError(
      `نوع الجرد «${String(args.type)}» غير مدعوم — اختار CRITICAL أو FULL`
    );
  }

  const criticalOnly = args.type === "CRITICAL";
  const items = await db.inventoryItem.findMany({
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
