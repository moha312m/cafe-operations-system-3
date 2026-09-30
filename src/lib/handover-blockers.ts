import type { HandoverStatus, OrderStatus, Prisma, StockCountStatus } from "@prisma/client";
import { handoverEnablementPreflightInTransaction } from "@/lib/handover-config";

export type HandoverBlockerCode =
  | "UNSERVED_ORDERS"
  | "PENDING_APPROVAL_ORDERS"
  | "DRAFT_PURCHASE_INVOICES"
  | "PENDING_CORRECTIONS"
  | "FOREIGN_ACTIVE_COUNT"
  | "EXISTING_ACTIVE_HANDOVER"
  | "HANDOVER_CONFIG_ERROR";

export type HandoverBlocker = {
  code: HandoverBlockerCode;
  count: number;
  message: string;
  ids: string[];
};

const SAMPLE_LIMIT = 20;
const UNSERVED_STATUSES: OrderStatus[] = ["CONFIRMED", "PREPARING", "READY"];
const ACTIVE_COUNT_STATUSES: StockCountStatus[] = ["DRAFT", "IN_PROGRESS", "SUBMITTED", "RECOUNT_REQUIRED"];
const ACTIVE_HANDOVER_STATUSES: HandoverStatus[] = ["DRAFT", "OUTGOING_SUBMITTED", "INCOMING_REVIEW", "REJECTED"];

function rowBlocker(
  code: Exclude<HandoverBlockerCode, "HANDOVER_CONFIG_ERROR">,
  count: number,
  ids: string[],
  message: string,
): HandoverBlocker | null {
  return count === 0 ? null : { code, count, message, ids };
}

export async function handoverStartBlockers(
  tx: Prisma.TransactionClient,
  args: {
    cafeId: string;
    branchId: string;
    excludeHandoverId?: string | null;
  },
): Promise<HandoverBlocker[]> {
  const scope = { cafeId: args.cafeId, branchId: args.branchId };
  const activeCountScope = {
    ...scope,
    status: { in: ACTIVE_COUNT_STATUSES },
    ...(args.excludeHandoverId
      ? {
        OR: [
          { lockedByHandoverId: null },
          { lockedByHandoverId: { not: args.excludeHandoverId } },
        ],
      }
      : {}),
  };
  const activeHandoverScope = {
    ...scope,
    status: { in: ACTIVE_HANDOVER_STATUSES },
    ...(args.excludeHandoverId ? { id: { not: args.excludeHandoverId } } : {}),
  };

  const [
    unservedCount, unservedRows,
    pendingApprovalCount, pendingApprovalRows,
    draftPurchaseCount, draftPurchaseRows,
    pendingCorrectionCount, pendingCorrectionRows,
    activeCountCount, activeCountRows,
    activeHandoverCount, activeHandoverRows,
    configErrors,
  ] = await Promise.all([
    tx.order.count({ where: { ...scope, status: { in: UNSERVED_STATUSES } } }),
    tx.order.findMany({
      where: { ...scope, status: { in: UNSERVED_STATUSES } },
      select: { id: true }, take: SAMPLE_LIMIT, orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    }),
    tx.order.count({ where: { ...scope, status: "PENDING_WAITER_APPROVAL" } }),
    tx.order.findMany({
      where: { ...scope, status: "PENDING_WAITER_APPROVAL" },
      select: { id: true }, take: SAMPLE_LIMIT, orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    }),
    tx.purchaseInvoice.count({ where: { ...scope, status: "DRAFT" } }),
    tx.purchaseInvoice.findMany({
      where: { ...scope, status: "DRAFT" },
      select: { id: true }, take: SAMPLE_LIMIT, orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    }),
    tx.stockCountCorrection.count({
      where: { status: "PENDING_APPROVAL", line: { session: scope } },
    }),
    tx.stockCountCorrection.findMany({
      where: { status: "PENDING_APPROVAL", line: { session: scope } },
      select: { id: true }, take: SAMPLE_LIMIT, orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    }),
    tx.stockCountSession.count({ where: activeCountScope }),
    tx.stockCountSession.findMany({
      where: activeCountScope,
      select: { id: true }, take: SAMPLE_LIMIT, orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    }),
    tx.handoverSession.count({ where: activeHandoverScope }),
    tx.handoverSession.findMany({
      where: activeHandoverScope,
      select: { id: true }, take: SAMPLE_LIMIT, orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    }),
    handoverEnablementPreflightInTransaction(tx, args.cafeId, args.branchId),
  ]);

  const blockers: HandoverBlocker[] = [];
  const append = (blocker: HandoverBlocker | null) => {
    if (blocker) blockers.push(blocker);
  };
  append(rowBlocker("UNSERVED_ORDERS", unservedCount, unservedRows.map((row) => row.id), "Unserved orders can still consume stock"));
  append(rowBlocker("PENDING_APPROVAL_ORDERS", pendingApprovalCount, pendingApprovalRows.map((row) => row.id), "Orders are awaiting waiter approval"));
  append(rowBlocker("DRAFT_PURCHASE_INVOICES", draftPurchaseCount, draftPurchaseRows.map((row) => row.id), "Draft purchase invoices can still post stock"));
  append(rowBlocker("PENDING_CORRECTIONS", pendingCorrectionCount, pendingCorrectionRows.map((row) => row.id), "Count corrections are awaiting approval"));
  append(rowBlocker("FOREIGN_ACTIVE_COUNT", activeCountCount, activeCountRows.map((row) => row.id), "Active stock counts belong to another handover context"));
  append(rowBlocker("EXISTING_ACTIVE_HANDOVER", activeHandoverCount, activeHandoverRows.map((row) => row.id), "An active handover already exists for this branch"));
  if (configErrors.length > 0) {
    blockers.push({
      code: "HANDOVER_CONFIG_ERROR",
      count: configErrors.length,
      message: "Handover configuration contains blocking errors",
      ids: configErrors.map((error) => error.code),
    });
  }
  return blockers;
}
