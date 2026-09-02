import type {
  HandoverStockMode,
  HandoverTarget,
  InventoryUnit,
  PeriodicFullCountSchedule,
  Prisma,
  RequiredItemTrigger,
} from "@prisma/client";
import { ApiError } from "@/lib/api";
import { resolveBranchHandoverConfigReadOnly } from "@/lib/handover-config";
import {
  fullCountDueInTransaction,
  resolveCountScopeInTransaction,
} from "@/lib/stock-count-policy";

export type RequiredItemPlanItem = {
  inventoryItemId: string;
  itemNameSnapshot: string;
  unitSnapshot: InventoryUnit;
  isCriticalSnapshot: boolean;
};

export type RequiredItemPlan = {
  cafeId: string;
  branchId: string;
  target: HandoverTarget;
  mode: HandoverStockMode;
  trigger: RequiredItemTrigger;
  businessDate: string;
  periodic: {
    schedule: PeriodicFullCountSchedule;
    weekday: number | null;
  };
  configSnapshotAt: Date;
  items: RequiredItemPlanItem[];
};

function badRequest(message: string): never {
  throw new ApiError(400, message);
}

function conflict(message: string): never {
  throw new ApiError(409, message);
}

function assertTarget(value: unknown): asserts value is HandoverTarget {
  if (value !== "SHIFT_TO_SHIFT" && value !== "BRANCH_CUSTODY") {
    badRequest("target must be SHIFT_TO_SHIFT or BRANCH_CUSTODY");
  }
}

function validatePlan(plan: RequiredItemPlan): void {
  if (!plan.cafeId || !plan.branchId) badRequest("cafeId and branchId are required");
  assertTarget(plan.target);
  if (plan.mode !== "FULL" && plan.mode !== "SELECTED") badRequest("invalid stock mode");
  if (!["REGULAR_MODE", "PERIODIC_DAILY", "PERIODIC_WEEKLY", "MANUAL_FULL"].includes(plan.trigger)) {
    badRequest("invalid required-item trigger");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(plan.businessDate)) badRequest("invalid business date");
  if (!(plan.configSnapshotAt instanceof Date) || Number.isNaN(plan.configSnapshotAt.getTime())) {
    badRequest("configSnapshotAt must be a valid date");
  }
  if (!["DAILY_LAST_HANDOVER", "WEEKLY", "MANUAL_ONLY"].includes(plan.periodic.schedule)) {
    badRequest("invalid periodic schedule");
  }
  if (plan.periodic.schedule === "WEEKLY") {
    if (!Number.isInteger(plan.periodic.weekday) || plan.periodic.weekday! < 0 || plan.periodic.weekday! > 6) {
      badRequest("weekly periodic schedule requires weekday 0 through 6");
    }
  } else if (plan.periodic.weekday !== null) {
    badRequest("non-weekly periodic schedule cannot carry a weekday");
  }
  const ids = new Set<string>();
  for (const item of plan.items) {
    if (!item.inventoryItemId || !item.itemNameSnapshot) badRequest("required-item snapshot is incomplete");
    if (ids.has(item.inventoryItemId)) badRequest("required-item plan contains a duplicate inventory item");
    ids.add(item.inventoryItemId);
  }
}

export async function planRequiredItems(
  tx: Prisma.TransactionClient,
  args: {
    cafeId: string;
    branchId: string;
    at: Date;
    target: HandoverTarget;
    manualFullCount?: boolean;
  },
): Promise<RequiredItemPlan> {
  if (!args.cafeId || !args.branchId) badRequest("cafeId and branchId are required");
  if (!(args.at instanceof Date) || Number.isNaN(args.at.getTime())) badRequest("at must be a valid date");
  assertTarget(args.target);

  const config = await resolveBranchHandoverConfigReadOnly(tx, args.cafeId, args.branchId);
  if (!config.enabled) badRequest("handover stock counting is disabled");
  if (config.configError) badRequest(`${config.configError.code}: ${config.configError.message}`);

  const due = await fullCountDueInTransaction(tx, {
    cafeId: args.cafeId,
    branchId: args.branchId,
    at: args.at,
    target: args.target,
  });
  if (due.schedule !== config.periodic.schedule || due.weekday !== config.periodic.weekday) {
    conflict("handover configuration changed while required items were being planned; retry");
  }

  let mode: HandoverStockMode = config.mode;
  let trigger: RequiredItemTrigger = "REGULAR_MODE";
  if (args.manualFullCount) {
    mode = "FULL";
    trigger = "MANUAL_FULL";
  } else if (due.due) {
    mode = "FULL";
    trigger = due.schedule === "WEEKLY" ? "PERIODIC_WEEKLY" : "PERIODIC_DAILY";
  }

  const scope = await resolveCountScopeInTransaction(tx, {
    cafeId: args.cafeId,
    branchId: args.branchId,
    type: mode === "FULL" ? "FULL" : "CRITICAL",
  });
  const hydrated = await tx.inventoryItem.findMany({
    where: {
      id: { in: scope.inventoryItemIds },
      cafeId: args.cafeId,
      branchId: args.branchId,
      archivedAt: null,
      isActive: true,
    },
    select: { id: true, name: true, unit: true, isCritical: true },
  });
  const byId = new Map(hydrated.map((item) => [item.id, item]));
  if (byId.size !== scope.inventoryItemIds.length) {
    conflict("inventory scope changed while required items were being planned; retry");
  }
  const items = scope.inventoryItemIds.map((id) => {
    const item = byId.get(id);
    if (!item) conflict("inventory scope changed while required items were being planned; retry");
    return {
      inventoryItemId: item.id,
      itemNameSnapshot: item.name,
      unitSnapshot: item.unit,
      isCriticalSnapshot: item.isCritical,
    };
  });

  return {
    cafeId: args.cafeId,
    branchId: args.branchId,
    target: args.target,
    mode,
    trigger,
    businessDate: due.businessDate,
    periodic: { schedule: config.periodic.schedule, weekday: config.periodic.weekday },
    configSnapshotAt: new Date(args.at.getTime()),
    items,
  };
}

function snapshotMatches(
  handover: {
    cafeId: string;
    branchId: string;
    target: HandoverTarget | null;
    resolvedTarget: HandoverTarget | null;
    acceptedStockCountSessionId: string | null;
    stockMode: HandoverStockMode | null;
    requiredItemTrigger: RequiredItemTrigger | null;
    requiredItemCount: number | null;
    periodicScheduleSnapshot: PeriodicFullCountSchedule | null;
    periodicWeekdaySnapshot: number | null;
    configSnapshotAt: Date | null;
    businessDateSnapshot: string | null;
    requiredItems: Array<{
      inventoryItemId: string;
      itemNameSnapshot: string;
      unitSnapshot: InventoryUnit;
      isCriticalSnapshot: boolean;
    }>;
  },
  plan: RequiredItemPlan,
): boolean {
  if (
    handover.cafeId !== plan.cafeId
    || handover.branchId !== plan.branchId
    || handover.target !== plan.target
    || handover.resolvedTarget !== null
    || handover.acceptedStockCountSessionId !== null
    || handover.stockMode !== plan.mode
    || handover.requiredItemTrigger !== plan.trigger
    || handover.requiredItemCount !== plan.items.length
    || handover.periodicScheduleSnapshot !== plan.periodic.schedule
    || handover.periodicWeekdaySnapshot !== plan.periodic.weekday
    || handover.configSnapshotAt?.getTime() !== plan.configSnapshotAt.getTime()
    || handover.businessDateSnapshot !== plan.businessDate
    || handover.requiredItems.length !== plan.items.length
  ) return false;

  const expected = new Map(plan.items.map((item) => [item.inventoryItemId, item]));
  return handover.requiredItems.every((stored) => {
    const item = expected.get(stored.inventoryItemId);
    return item !== undefined
      && stored.itemNameSnapshot === item.itemNameSnapshot
      && stored.unitSnapshot === item.unitSnapshot
      && stored.isCriticalSnapshot === item.isCriticalSnapshot;
  });
}

export async function persistRequiredItems(
  tx: Prisma.TransactionClient,
  args: { handoverId: string; plan: RequiredItemPlan },
): Promise<{ handoverId: string; requiredItemCount: number; replayed: boolean }> {
  if (!args.handoverId) badRequest("handoverId is required");
  validatePlan(args.plan);
  const handover = await tx.handoverSession.findUnique({
    where: { id: args.handoverId },
    include: { requiredItems: true },
  });
  if (!handover) throw new ApiError(404, "handover not found");
  if (handover.cafeId !== args.plan.cafeId || handover.branchId !== args.plan.branchId) {
    badRequest("handover does not belong to the plan cafe and branch");
  }

  const hasSnapshot = handover.target !== null
    || handover.stockMode !== null
    || handover.requiredItemTrigger !== null
    || handover.requiredItemCount !== null
    || handover.periodicScheduleSnapshot !== null
    || handover.configSnapshotAt !== null
    || handover.businessDateSnapshot !== null
    || handover.requiredItems.length > 0;
  if (hasSnapshot) {
    if (!snapshotMatches(handover, args.plan)) conflict("required-item snapshot is immutable");
    return { handoverId: handover.id, requiredItemCount: args.plan.items.length, replayed: true };
  }
  if (handover.resolvedTarget !== null || handover.acceptedStockCountSessionId !== null) {
    conflict("handover already contains later-stage evidence");
  }

  const itemIds = args.plan.items.map((item) => item.inventoryItemId);
  const owned = await tx.inventoryItem.findMany({
    where: { id: { in: itemIds }, cafeId: args.plan.cafeId, branchId: args.plan.branchId },
    select: { id: true },
  });
  if (owned.length !== itemIds.length) badRequest("required-item plan contains an item outside the handover branch");

  const claimed = await tx.handoverSession.updateMany({
    where: {
      id: handover.id,
      cafeId: args.plan.cafeId,
      branchId: args.plan.branchId,
      target: null,
      resolvedTarget: null,
      acceptedStockCountSessionId: null,
      stockMode: null,
      requiredItemTrigger: null,
      requiredItemCount: null,
      periodicScheduleSnapshot: null,
      periodicWeekdaySnapshot: null,
      configSnapshotAt: null,
      businessDateSnapshot: null,
    },
    data: {
      target: args.plan.target,
      stockMode: args.plan.mode,
      requiredItemTrigger: args.plan.trigger,
      requiredItemCount: args.plan.items.length,
      periodicScheduleSnapshot: args.plan.periodic.schedule,
      periodicWeekdaySnapshot: args.plan.periodic.weekday,
      configSnapshotAt: args.plan.configSnapshotAt,
      businessDateSnapshot: args.plan.businessDate,
    },
  });
  if (claimed.count !== 1) conflict("required-item snapshot was claimed concurrently; retry");

  if (args.plan.items.length > 0) {
    await tx.handoverRequiredItem.createMany({
      data: args.plan.items.map((item) => ({ handoverId: handover.id, ...item })),
    });
  }
  return { handoverId: handover.id, requiredItemCount: args.plan.items.length, replayed: false };
}

export async function settleRequiredItems(
  tx: Prisma.TransactionClient,
  args: { handoverId: string; acceptedSessionId: string; omissionNote?: string | null },
): Promise<{
  handoverId: string;
  acceptedSessionId: string;
  omitted: Array<{ inventoryItemId: string; itemNameSnapshot: string; omissionNote: string | null }>;
  replayed: boolean;
}> {
  if (!args.handoverId || !args.acceptedSessionId) badRequest("handoverId and acceptedSessionId are required");
  const handover = await tx.handoverSession.findUnique({
    where: { id: args.handoverId },
    include: { requiredItems: true },
  });
  if (!handover) throw new ApiError(404, "handover not found");
  if (
    handover.target === null
    || handover.stockMode === null
    || handover.requiredItemTrigger === null
    || handover.requiredItemCount === null
    || handover.periodicScheduleSnapshot === null
    || handover.configSnapshotAt === null
    || handover.businessDateSnapshot === null
    || handover.requiredItemCount !== handover.requiredItems.length
  ) conflict("handover required-item snapshot is incomplete");

  const session = await tx.stockCountSession.findUnique({
    where: { id: args.acceptedSessionId },
    include: { lines: { select: { id: true, inventoryItemId: true } } },
  });
  if (!session) throw new ApiError(404, "stock count session not found");
  if (session.cafeId !== handover.cafeId || session.branchId !== handover.branchId) {
    badRequest("stock count session does not belong to the handover cafe and branch");
  }
  if (session.accountabilityContext !== "HANDOVER" || session.handoverId !== handover.id || session.openingBranchCustodyPeriodId !== null) {
    conflict("stock count session is not bound to this handover");
  }
  if (handover.stockMode === "FULL" && session.type !== "FULL") {
    conflict("a FULL required-item snapshot requires a FULL stock count");
  }
  if (session.type !== "CRITICAL" && session.type !== "FULL") conflict("unsupported stock count type");
  if (session.status !== "CONFIRMED" && session.status !== "LOCKED") conflict("stock count session is not confirmed");
  if (session.lockedByHandoverId !== null && session.lockedByHandoverId !== handover.id) {
    conflict("stock count session is locked by another handover");
  }
  if (session.status === "LOCKED" && session.lockedByHandoverId !== handover.id) {
    conflict("locked stock count session is not locked by this handover");
  }
  if (handover.acceptedStockCountSessionId !== null && handover.acceptedStockCountSessionId !== session.id) {
    conflict("final accepted stock-count evidence cannot be replaced");
  }

  const lineByItem = new Map(session.lines.map((line) => [line.inventoryItemId, line.id]));
  const normalizedNote = args.omissionNote?.trim() || null;
  const desired = handover.requiredItems.map((required) => {
    const lineId = lineByItem.get(required.inventoryItemId) ?? null;
    return {
      required,
      satisfiedByLineId: lineId,
      omitted: lineId === null,
      omissionNote: lineId === null ? normalizedNote : null,
    };
  });
  const exact = desired.every(({ required, satisfiedByLineId, omitted, omissionNote }) =>
    required.satisfiedByLineId === satisfiedByLineId
    && required.omitted === omitted
    && required.omissionNote === omissionNote);

  const omitted = desired
    .filter((entry) => entry.omitted)
    .map(({ required, omissionNote }) => ({
      inventoryItemId: required.inventoryItemId,
      itemNameSnapshot: required.itemNameSnapshot,
      omissionNote,
    }))
    .sort((a, b) => a.inventoryItemId.localeCompare(b.inventoryItemId));

  if (handover.acceptedStockCountSessionId !== null) {
    if (!exact) conflict("final required-item settlement is immutable");
    return { handoverId: handover.id, acceptedSessionId: session.id, omitted, replayed: true };
  }
  if (exact) return { handoverId: handover.id, acceptedSessionId: session.id, omitted, replayed: true };

  for (const entry of desired) {
    await tx.handoverRequiredItem.update({
      where: { id: entry.required.id },
      data: {
        satisfiedByLineId: entry.satisfiedByLineId,
        omitted: entry.omitted,
        omissionNote: entry.omissionNote,
      },
    });
  }
  return { handoverId: handover.id, acceptedSessionId: session.id, omitted, replayed: false };
}
