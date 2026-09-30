import type { PeriodicFullCountSchedule, Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/api";
import { auditInTransaction } from "@/lib/audit";
import { getCafeSettings } from "@/lib/cafe-settings";

export type HandoverConfigError =
  | { code: "CYCLE_POLICY_UNSUPPORTED"; message: string }
  | { code: "SELECTED_WITH_NO_ITEMS"; message: string }
  | { code: "WEEKLY_WITHOUT_WEEKDAY"; message: string };

export type BranchHandoverConfig = {
  enabled: boolean;
  mode: "FULL" | "SELECTED";
  selectedItemIds: string[];
  periodic: {
    schedule: PeriodicFullCountSchedule;
    weekday: number | null;
  };
  source: Record<"enabled" | "mode" | "schedule" | "weekday", "CAFE" | "BRANCH">;
  configError: HandoverConfigError | null;
};

function configErrors(args: {
  policy: string;
  mode: "FULL" | "SELECTED";
  selectedItemIds: string[];
  schedule: PeriodicFullCountSchedule;
  weekday: number | null;
}): HandoverConfigError[] {
  const errors: HandoverConfigError[] = [];
  if (args.policy === "CYCLE") {
    errors.push({ code: "CYCLE_POLICY_UNSUPPORTED", message: "CYCLE policy is not supported for handover configuration" });
  }
  if (args.mode === "SELECTED" && args.selectedItemIds.length === 0) {
    errors.push({ code: "SELECTED_WITH_NO_ITEMS", message: "SELECTED handover mode has no selected active items" });
  }
  if (args.schedule === "WEEKLY" && args.weekday === null) {
    errors.push({ code: "WEEKLY_WITHOUT_WEEKDAY", message: "WEEKLY periodic schedule requires a weekday" });
  }
  return errors;
}

type HandoverConfigReadClient = Pick<
  Prisma.TransactionClient,
  "branch" | "cafeSettings" | "inventoryItem"
>;

type HandoverConfigSettings = {
  stockCountPolicy: "NO_SHIFT_COUNT" | "CRITICAL" | "FULL" | "HYBRID" | "CYCLE";
  handoverCountType: "CRITICAL" | "FULL";
  periodicFullCountSchedule: PeriodicFullCountSchedule;
  periodicFullCountWeekday: number | null;
};

const READ_ONLY_DEFAULT_SETTINGS: HandoverConfigSettings = {
  stockCountPolicy: "HYBRID",
  handoverCountType: "CRITICAL",
  periodicFullCountSchedule: "MANUAL_ONLY",
  periodicFullCountWeekday: null,
};

function inherited<T>(cafeValue: T, branchOverride: T | null) {
  return branchOverride === null
    ? { value: cafeValue, source: "CAFE" as const }
    : { value: branchOverride, source: "BRANCH" as const };
}

async function readHandoverConfig(
  client: HandoverConfigReadClient,
  cafeId: string,
  branchId: string,
  cafeSettings: HandoverConfigSettings | null,
): Promise<{ config: BranchHandoverConfig; errors: HandoverConfigError[] }> {
  const branch = await client.branch.findUnique({
    where: { id: branchId },
    select: {
      cafeId: true,
      stockCountPolicyOverride: true,
      handoverCountTypeOverride: true,
      periodicFullCountScheduleOverride: true,
      periodicFullCountWeekdayOverride: true,
    },
  });
  if (!branch) throw new ApiError(404, "Branch not found");
  if (branch.cafeId !== cafeId) {
    throw new ApiError(400, "Branch does not belong to cafe");
  }

  const settings = cafeSettings ?? READ_ONLY_DEFAULT_SETTINGS;
  const policy = inherited(settings.stockCountPolicy, branch.stockCountPolicyOverride);
  const handoverCountType = inherited(settings.handoverCountType, branch.handoverCountTypeOverride);
  const schedule = inherited(settings.periodicFullCountSchedule, branch.periodicFullCountScheduleOverride);
  const weekday = branch.periodicFullCountScheduleOverride === null
    ? { value: settings.periodicFullCountWeekday, source: "CAFE" as const }
    : { value: branch.periodicFullCountWeekdayOverride, source: "BRANCH" as const };
  const mode = handoverCountType.value === "FULL" ? "FULL" : "SELECTED";
  const selectedItemIds = mode === "SELECTED"
    ? (await client.inventoryItem.findMany({
      where: { cafeId, branchId, archivedAt: null, isActive: true, isCritical: true },
      select: { id: true },
      orderBy: { name: "asc" },
    })).map((item) => item.id)
    : [];
  const errors = configErrors({
    policy: policy.value,
    mode,
    selectedItemIds,
    schedule: schedule.value,
    weekday: weekday.value,
  });
  return {
    config: {
      enabled: policy.value !== "NO_SHIFT_COUNT",
      mode,
      selectedItemIds,
      periodic: { schedule: schedule.value, weekday: weekday.value },
      source: {
        enabled: policy.source,
        mode: handoverCountType.source,
        schedule: schedule.source,
        weekday: weekday.source,
      },
      configError: errors[0] ?? null,
    },
    errors,
  };
}

const message: Record<HandoverConfigError["code"], string> = {
  CYCLE_POLICY_UNSUPPORTED: "CYCLE policy is not supported for handover configuration",
  SELECTED_WITH_NO_ITEMS: "SELECTED handover mode has no selected active items",
  WEEKLY_WITHOUT_WEEKDAY: "WEEKLY periodic schedule requires a weekday",
};

function fail(code: HandoverConfigError["code"] | "VALIDATION", detail?: string): never {
  const text = detail ? `${message[code as HandoverConfigError["code"]] ?? "Invalid handover configuration"}: ${detail}` : message[code as HandoverConfigError["code"]] ?? "Invalid handover configuration";
  throw new ApiError(400, `${code}: ${text}`);
}

export async function resolveBranchHandoverConfig(
  cafeId: string,
  branchId: string,
): Promise<BranchHandoverConfig> {
  const settings = await getCafeSettings(cafeId);
  return (await readHandoverConfig(db, cafeId, branchId, settings)).config;
}

export async function handoverEnablementPreflight(cafeId: string, branchId: string): Promise<HandoverConfigError[]> {
  const settings = await getCafeSettings(cafeId);
  return (await readHandoverConfig(db, cafeId, branchId, settings)).errors;
}

/**
 * Resolves the SH-8 handover configuration using only the caller's
 * transaction. Missing settings are represented by the schema defaults in
 * memory, so this read-only path never triggers CafeSettings lazy creation.
 */
export async function resolveBranchHandoverConfigReadOnly(
  tx: Prisma.TransactionClient,
  cafeId: string,
  branchId: string,
): Promise<BranchHandoverConfig> {
  const settings = await tx.cafeSettings.findUnique({
    where: { cafeId },
    select: {
      stockCountPolicy: true,
      handoverCountType: true,
      periodicFullCountSchedule: true,
      periodicFullCountWeekday: true,
    },
  });
  return (await readHandoverConfig(tx, cafeId, branchId, settings)).config;
}

/** Returns every SH-8 configuration error from the caller's transaction. */
export async function handoverEnablementPreflightInTransaction(
  tx: Prisma.TransactionClient,
  cafeId: string,
  branchId: string,
): Promise<HandoverConfigError[]> {
  const settings = await tx.cafeSettings.findUnique({
    where: { cafeId },
    select: {
      stockCountPolicy: true,
      handoverCountType: true,
      periodicFullCountSchedule: true,
      periodicFullCountWeekday: true,
    },
  });
  return (await readHandoverConfig(tx, cafeId, branchId, settings)).errors;
}

export async function updateBranchHandoverConfig(args: {
  cafeId: string; branchId: string; actorId: string;
  patch: Partial<{ enabled: boolean; mode: "FULL" | "SELECTED"; selectedItemIds: string[]; schedule: PeriodicFullCountSchedule | null; weekday: number | null }>;
}): Promise<BranchHandoverConfig> {
  const ids = args.patch.selectedItemIds;
  if (ids && new Set(ids).size !== ids.length) fail("VALIDATION", "selectedItemIds contains a duplicate id");
  if (args.patch.weekday !== undefined && args.patch.weekday !== null && (!Number.isInteger(args.patch.weekday) || args.patch.weekday < 0 || args.patch.weekday > 6)) fail("VALIDATION", "weekday must be an integer from 0 to 6");
  await db.$transaction(async (tx: Prisma.TransactionClient) => {
    const branch = await tx.branch.findUnique({ where: { id: args.branchId }, select: { cafeId: true, stockCountPolicyOverride: true, handoverCountTypeOverride: true, periodicFullCountScheduleOverride: true, periodicFullCountWeekdayOverride: true } });
    if (!branch) throw new ApiError(404, "Branch not found");
    if (branch.cafeId !== args.cafeId) throw new ApiError(400, "Branch does not belong to cafe");
    const [settings, selected] = await Promise.all([
      tx.cafeSettings.findUniqueOrThrow({ where: { cafeId: args.cafeId }, select: { stockCountPolicy: true, handoverCountType: true, periodicFullCountSchedule: true, periodicFullCountWeekday: true } }),
      tx.inventoryItem.findMany({ where: { cafeId: args.cafeId, branchId: args.branchId, archivedAt: null, isActive: true, isCritical: true }, select: { id: true }, orderBy: { name: "asc" } }),
    ]);
    const policy = branch.stockCountPolicyOverride ?? settings.stockCountPolicy;
    const handoverCountType = branch.handoverCountTypeOverride ?? settings.handoverCountType;
    const schedule = branch.periodicFullCountScheduleOverride ?? settings.periodicFullCountSchedule;
    const weekday = branch.periodicFullCountScheduleOverride === null
      ? settings.periodicFullCountWeekday
      : branch.periodicFullCountWeekdayOverride;
    const before: BranchHandoverConfig = {
      enabled: policy !== "NO_SHIFT_COUNT",
      mode: handoverCountType === "FULL" ? "FULL" : "SELECTED",
      selectedItemIds: handoverCountType === "FULL" ? [] : selected.map((item) => item.id),
      periodic: { schedule, weekday },
      source: {
        enabled: branch.stockCountPolicyOverride === null ? "CAFE" : "BRANCH",
        mode: branch.handoverCountTypeOverride === null ? "CAFE" : "BRANCH",
        schedule: branch.periodicFullCountScheduleOverride === null ? "CAFE" : "BRANCH",
        weekday: branch.periodicFullCountScheduleOverride === null ? "CAFE" : "BRANCH",
      },
      configError: null,
    };
    const finalMode = args.patch.mode ?? before.mode;
    const finalEnabled = args.patch.enabled ?? before.enabled;
    const finalSelected = ids ?? before.selectedItemIds;
    if (policy === "CYCLE" && args.patch.enabled === true && args.patch.mode === undefined) fail("CYCLE_POLICY_UNSUPPORTED");
    if (finalEnabled && finalMode === "SELECTED" && finalSelected.length === 0) fail("SELECTED_WITH_NO_ITEMS");
    let scheduleOverride: PeriodicFullCountSchedule | null | undefined;
    let weekdayOverride: number | null | undefined;
    if (args.patch.schedule !== undefined) {
      scheduleOverride = args.patch.schedule;
      if (scheduleOverride === null) {
        if (args.patch.weekday !== undefined && args.patch.weekday !== null) fail("VALIDATION", "weekday must be null when schedule inherits");
        weekdayOverride = null;
      } else if (scheduleOverride === "WEEKLY") {
        const retained = branch.periodicFullCountScheduleOverride === "WEEKLY" ? branch.periodicFullCountWeekdayOverride : null;
        weekdayOverride = args.patch.weekday === undefined ? retained : args.patch.weekday;
        if (weekdayOverride === null) fail("WEEKLY_WITHOUT_WEEKDAY");
      } else {
        if (args.patch.weekday !== undefined && args.patch.weekday !== null) fail("VALIDATION", "weekday is only valid with WEEKLY schedule");
        weekdayOverride = null;
      }
    } else if (args.patch.weekday !== undefined) {
      if (branch.periodicFullCountScheduleOverride !== "WEEKLY" || args.patch.weekday === null) fail("WEEKLY_WITHOUT_WEEKDAY");
      scheduleOverride = "WEEKLY"; weekdayOverride = args.patch.weekday;
    }
    const scoped = ids ? await tx.inventoryItem.findMany({ where: { id: { in: ids }, cafeId: args.cafeId, branchId: args.branchId, archivedAt: null, isActive: true }, select: { id: true } }) : [];
    if (ids && scoped.length !== ids.length) fail("VALIDATION", "a selected item is missing, archived, inactive, or outside this branch");
    const data: Prisma.BranchUpdateInput = {};
    if (args.patch.enabled !== undefined) data.stockCountPolicyOverride = args.patch.enabled ? "HYBRID" : "NO_SHIFT_COUNT";
    if (args.patch.mode !== undefined) data.handoverCountTypeOverride = args.patch.mode === "FULL" ? "FULL" : "CRITICAL";
    if (scheduleOverride !== undefined) data.periodicFullCountScheduleOverride = scheduleOverride;
    if (weekdayOverride !== undefined) data.periodicFullCountWeekdayOverride = weekdayOverride;
    if (Object.keys(data).length) await tx.branch.update({ where: { id: args.branchId }, data });
    if (ids) {
      await tx.inventoryItem.updateMany({ where: { cafeId: args.cafeId, branchId: args.branchId, archivedAt: null, isActive: true, isCritical: true, id: { notIn: ids } }, data: { isCritical: false } });
      if (ids.length) await tx.inventoryItem.updateMany({ where: { id: { in: ids }, cafeId: args.cafeId, branchId: args.branchId, archivedAt: null, isActive: true }, data: { isCritical: true } });
    }
    const auditedPeriodic = scheduleOverride === null
      ? { schedule: settings.periodicFullCountSchedule, weekday: settings.periodicFullCountWeekday }
      : { schedule: scheduleOverride === undefined ? before.periodic.schedule : scheduleOverride, weekday: weekdayOverride === undefined ? before.periodic.weekday : weekdayOverride };
    await auditInTransaction(tx, { cafeId: args.cafeId, userId: args.actorId, action: "HANDOVER_CONFIG_UPDATED", entity: "Branch", entityId: args.branchId, details: { oldValue: before, newValue: { enabled: finalEnabled, mode: finalMode, selectedItemIds: finalSelected, periodic: auditedPeriodic }, overrides: { stockCountPolicyOverride: args.patch.enabled === undefined ? undefined : args.patch.enabled ? "HYBRID" : "NO_SHIFT_COUNT", handoverCountTypeOverride: args.patch.mode === undefined ? undefined : args.patch.mode === "FULL" ? "FULL" : "CRITICAL", periodicFullCountScheduleOverride: scheduleOverride, periodicFullCountWeekdayOverride: weekdayOverride } } });
  });
  return resolveBranchHandoverConfig(args.cafeId, args.branchId);
}
