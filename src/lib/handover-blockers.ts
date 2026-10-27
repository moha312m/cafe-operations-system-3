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
  /** What the closer reads: the obstacle and what to do about it. */
  messageAr: string;
  ids: string[];
  /** Human references for the sampled rows (order numbers), same order as `ids`. */
  refs?: string[];
};

/** Blockers a café may waive by carrying open orders to the incoming shift. */
export const CARRYABLE_BLOCKER_CODES: ReadonlySet<HandoverBlockerCode> = new Set([
  "UNSERVED_ORDERS",
  "PENDING_APPROVAL_ORDERS",
]);

const SAMPLE_LIMIT = 20;
const UNSERVED_STATUSES: OrderStatus[] = ["CONFIRMED", "PREPARING", "READY"];
const ACTIVE_COUNT_STATUSES: StockCountStatus[] = ["DRAFT", "IN_PROGRESS", "SUBMITTED", "RECOUNT_REQUIRED"];
const ACTIVE_HANDOVER_STATUSES: HandoverStatus[] = ["DRAFT", "OUTGOING_SUBMITTED", "INCOMING_REVIEW", "REJECTED"];

const MESSAGES_AR: Record<HandoverBlockerCode, string> = {
  UNSERVED_ORDERS:
    "أوردرات لسه متقدمتش (مؤكدة / بتتحضر / جاهزة) — قدّمها أو ألغيها من صفحة الطلبات، أو فعّل «ترحيل الأوردرات المفتوحة للشيفت اللي جاي» من الإعدادات",
  PENDING_APPROVAL_ORDERS:
    "أوردرات QR مستنية موافقة الويتر — وافق عليها أو ارفضها، أو فعّل «ترحيل الأوردرات المفتوحة للشيفت اللي جاي» من الإعدادات",
  DRAFT_PURCHASE_INVOICES: "فواتير مشتريات لسه مسودة — أكّدها أو احذفها من صفحة المشتريات",
  PENDING_CORRECTIONS: "تصحيحات جرد مستنية موافقة المدير",
  FOREIGN_ACTIVE_COUNT: "في جرد مفتوح في الفرع لازم يخلص أو يتلغي الأول",
  EXISTING_ACTIVE_HANDOVER: "في تسليم عهدة مفتوح بالفعل في الفرع — كمّله أو ارفضه من صفحة التسليمات",
  HANDOVER_CONFIG_ERROR: "إعدادات تسليم العهدة في الفرع فيها خطأ — راجعها من إعدادات الفرع",
};

function rowBlocker(
  code: Exclude<HandoverBlockerCode, "HANDOVER_CONFIG_ERROR">,
  count: number,
  ids: string[],
  message: string,
  refs?: string[],
): HandoverBlocker | null {
  if (count === 0) return null;
  return { code, count, message, messageAr: MESSAGES_AR[code], ids, ...(refs ? { refs } : {}) };
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
      select: { id: true, orderNumber: true }, take: SAMPLE_LIMIT, orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    }),
    tx.order.count({ where: { ...scope, status: "PENDING_WAITER_APPROVAL" } }),
    tx.order.findMany({
      where: { ...scope, status: "PENDING_WAITER_APPROVAL" },
      select: { id: true, orderNumber: true }, take: SAMPLE_LIMIT, orderBy: [{ createdAt: "asc" }, { id: "asc" }],
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
  const orderRefs = (rows: { orderNumber: number }[]) => rows.map((row) => `#${row.orderNumber}`);
  append(rowBlocker("UNSERVED_ORDERS", unservedCount, unservedRows.map((row) => row.id), "Unserved orders can still consume stock", orderRefs(unservedRows)));
  append(rowBlocker("PENDING_APPROVAL_ORDERS", pendingApprovalCount, pendingApprovalRows.map((row) => row.id), "Orders are awaiting waiter approval", orderRefs(pendingApprovalRows)));
  append(rowBlocker("DRAFT_PURCHASE_INVOICES", draftPurchaseCount, draftPurchaseRows.map((row) => row.id), "Draft purchase invoices can still post stock"));
  append(rowBlocker("PENDING_CORRECTIONS", pendingCorrectionCount, pendingCorrectionRows.map((row) => row.id), "Count corrections are awaiting approval"));
  append(rowBlocker("FOREIGN_ACTIVE_COUNT", activeCountCount, activeCountRows.map((row) => row.id), "Active stock counts belong to another handover context"));
  append(rowBlocker("EXISTING_ACTIVE_HANDOVER", activeHandoverCount, activeHandoverRows.map((row) => row.id), "An active handover already exists for this branch"));
  if (configErrors.length > 0) {
    blockers.push({
      code: "HANDOVER_CONFIG_ERROR",
      count: configErrors.length,
      message: "Handover configuration contains blocking errors",
      messageAr: MESSAGES_AR.HANDOVER_CONFIG_ERROR,
      ids: configErrors.map((error) => error.code),
    });
  }
  return blockers;
}
