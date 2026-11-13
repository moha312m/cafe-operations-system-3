// Stock handover v2 — the manager/owner report and review.
//
// The report reads; it never posts. A review records what a person concluded
// about a comparison: a status, a classification and an append-only trail of
// notes. A stock correction, when one is warranted, goes through the existing
// authorised adjustment process — this module only links the conclusion to it.

import { createHash } from "node:crypto";
import type { Prisma, StockHandoverClassification, StockHandoverReviewStatus } from "@prisma/client";
import { ApiError } from "@/lib/api";
import { auditInTransaction } from "@/lib/audit";
import { db } from "@/lib/db";
import { acquireInventorySharedLocks } from "@/lib/inventory-freeze";
import { lockItemForUpdate } from "@/lib/ledger";
import { buildComparison, LABEL_AR, toMilli, type ComparisonLineRecord, type ComparisonSnapshot } from "@/lib/stock-handover-v2";
import { buildXlsx, type XlsxSheetCell } from "@/lib/xlsx";

type Client = Prisma.TransactionClient | typeof db;

const ADJUSTMENT_ACTION = "STOCK_HANDOVER_ADJUSTMENT";

function shortage(snapshot: ComparisonSnapshot, itemId: string) {
  const line = snapshot.lines.find((row) => row.inventoryItemId === itemId);
  if (!line || !line.outgoing?.counterId || !line.incoming?.counterId || line.outgoing.counterId === line.incoming.counterId ||
      line.reliability !== "CONFIRMED" || line.disputed || line.adjusted === null) return null;
  const difference = toMilli(line.adjusted);
  return difference < BigInt(0) ? { line, difference } : null;
}

function adjustmentToken(snapshot: ComparisonSnapshot, itemId: string, ledgerVersion: bigint, cost: string) {
  return createHash("sha256").update(JSON.stringify([snapshot.handoverId, snapshot.version, itemId, String(ledgerVersion), cost])).digest("hex");
}

function reviewedShortage(review: { status: string; classification: string } | null) {
  return review?.status === "REVIEWED" && review.classification === "LOSS_UNEXPLAINED";
}

async function linkedAdjustments(client: Client, cafeId: string, handoverId: string) {
  const rows = await client.auditLog.findMany({
    where: { cafeId, action: ADJUSTMENT_ACTION, entity: "HandoverSession", entityId: handoverId },
    orderBy: { createdAt: "asc" },
    select: { details: true, createdAt: true, user: { select: { name: true } } },
  });
  return rows.map((row) => ({
    ...row.details as { transactionId: string; inventoryItemId: string; comparisonVersion: string; quantity: number; unitCost: number | null; totalCost: number | null; reason: string },
    createdAt: row.createdAt.toISOString(), actorName: row.user?.name ?? null,
  }));
}

/**
 * Server-side gate for a linked handover shortage adjustment. Requires: a
 * review classified LOSS_UNEXPLAINED and marked REVIEWED; a confirmed shortage
 * from two different counters; no adjustment already linked for the item; a
 * token minted against the current comparison version, ledger version and
 * reference cost (any movement or cost change makes it stale); and a fresh
 * physical count whose shortfall against the locked book balance is exactly
 * the requested delta and never larger than the confirmed handover shortage.
 */
export async function validateHandoverAdjustment(tx: Prisma.TransactionClient, args: {
  cafeId: string; branchId: string; handoverId: string; itemId: string; token: string; physicalQuantity: number; delta: number;
}) {
  const [handover] = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "HandoverSession"
    WHERE "id"=${args.handoverId} AND "cafeId"=${args.cafeId} AND "branchId"=${args.branchId} FOR UPDATE
  `;
  if (!handover) throw new ApiError(404, "التسليم مش موجود في نفس الفرع");
  const review = await tx.stockHandoverReview.findUnique({ where: { handoverId: handover.id } });
  if (!reviewedShortage(review)) throw new ApiError(409, "راجع الحالة وصنّفها عجز غير مفسّر قبل التسوية");
  const snapshot = await buildComparison(tx, handover.id);
  const evidence = shortage(snapshot, args.itemId);
  if (!evidence) throw new ApiError(409, "الصنف مافيش له عجز مؤكد من جردين مستقلين");
  const existing = await linkedAdjustments(tx, args.cafeId, handover.id);
  if (existing.some((row) => row.inventoryItemId === args.itemId)) throw new ApiError(409, "العجز ده له تسوية مسجّلة بالفعل");
  // Lock order: handover row (above), then the branch gate, then the item —
  // the same order as handover cancellation and every ordinary movement.
  await acquireInventorySharedLocks(tx, [args.branchId]);
  const locked = await lockItemForUpdate(tx, args.itemId);
  if (locked.unit !== evidence.line.unit || adjustmentToken(snapshot, args.itemId, locked.ledgerVersion, locked.costPerUnitExact.toFixed(2)) !== args.token) {
    throw new ApiError(409, "الرصيد أو المقارنة اتغيروا. افتح التقرير من جديد وعدّ الصنف تاني");
  }
  const observedDelta = toMilli(args.physicalQuantity) - toMilli(locked.currentStock);
  if (observedDelta >= BigInt(0) || observedDelta < evidence.difference || observedDelta !== toMilli(args.delta)) {
    throw new ApiError(409, "سجّل بس العجز المتبقي بين الجرد الفعلي والرصيد الحالي، في حدود فرق التسليم المؤكد");
  }
  return { comparisonVersion: snapshot.version, bookQuantity: locked.currentStock };
}

export async function recordHandoverAdjustment(tx: Prisma.TransactionClient, args: {
  cafeId: string; actorId: string; handoverId: string; inventoryItemId: string; transactionId: string; comparisonVersion: string;
  quantity: number; physicalQuantity: number; bookQuantity: number; unitCost: number | null; totalCost: number | null; reason: string;
}) {
  const { cafeId, actorId, handoverId, ...details } = args;
  await auditInTransaction(tx, { cafeId, userId: actorId, action: ADJUSTMENT_ACTION, entity: "HandoverSession", entityId: handoverId, details });
}

/** Managers review; owners and report readers read. */
export const mayReadStockHandoverReports = (keys: Set<string>) => keys.has("handover.manage") || keys.has("shifts.view_reports");

export const REVIEW_STATUSES: StockHandoverReviewStatus[] = ["OPEN", "IN_REVIEW", "REVIEWED", "RESOLVED"];
export const CLASSIFICATIONS: StockHandoverClassification[] = [
  "UNCLASSIFIED", "EXPLAINED_BY_MOVEMENTS", "COUNT_ERROR", "UNRECORDED_USAGE", "WASTE_OR_DAMAGE", "RECEIVING_OR_TRANSFER", "LOSS_UNEXPLAINED", "OTHER",
];
export const STATUS_AR: Record<StockHandoverReviewStatus, string> = {
  OPEN: "مفتوح", IN_REVIEW: "قيد المراجعة", REVIEWED: "اتراجع", RESOLVED: "اتقفل",
};
export const CLASSIFICATION_AR: Record<StockHandoverClassification, string> = {
  UNCLASSIFIED: "لسه ماتصنّفش",
  EXPLAINED_BY_MOVEMENTS: "مفسَّر بحركات مسجلة",
  COUNT_ERROR: "غلط في العدّ",
  UNRECORDED_USAGE: "استهلاك ماتسجلش",
  WASTE_OR_DAMAGE: "هالك أو تالف",
  RECEIVING_OR_TRANSFER: "استلام أو تحويل",
  LOSS_UNEXPLAINED: "عجز غير مفسَّر",
  OTHER: "سبب تاني",
};

export type ReportFilter = {
  cafeId: string;
  branchId: string | null;
  status?: StockHandoverReviewStatus | null;
  classification?: StockHandoverClassification | null;
  /** UNEXPLAINED: any adjusted ≠ 0 · EXPLAINED: raw ≠ 0 but adjusted = 0 · MISSING: a count is missing · NONE: no difference. */
  result?: "UNEXPLAINED" | "EXPLAINED" | "MISSING" | "NONE" | null;
  from?: Date | null;
  to?: Date | null;
  take?: number;
};

export type ReportRow = {
  handoverId: string;
  branchId: string;
  branchName: string;
  closedAt: string | null;
  status: string;
  outgoingName: string;
  incomingName: string | null;
  outgoingCounted: boolean;
  incomingCounted: boolean;
  reliability: string;
  rawDifferenceCount: number;
  adjustedDifferenceCount: number;
  unavailableCount: number;
  /** C1: lines the incoming employee refused on the legacy receiving sheet. */
  disputedCount: number;
  /** C2: received with no confirmed outgoing count; the shelf moved at book figures. */
  uncountedAcceptance: boolean;
  result: "UNEXPLAINED" | "EXPLAINED" | "MISSING" | "NONE";
  reviewStatus: StockHandoverReviewStatus | null;
  classification: StockHandoverClassification | null;
  notes: number;
  comparedAt: string | null;
};

const resultOf = (c: { rawDifferenceCount: number; adjustedDifferenceCount: number } | null, outgoingCounted: boolean, incomingCounted: boolean, disputedCount = 0, uncounted = false): ReportRow["result"] => {
  // A refusal is a disagreement nobody has explained yet, with or without figures (C1).
  if (disputedCount > 0) return "UNEXPLAINED";
  // Received with no confirmed outgoing count: never "matching" (C2).
  if (uncounted) return "MISSING";
  if (!outgoingCounted || !incomingCounted || !c) return "MISSING";
  if (c.adjustedDifferenceCount > 0) return "UNEXPLAINED";
  if (c.rawDifferenceCount > 0) return "EXPLAINED";
  return "NONE";
};

/** One row per handover, newest first. Counts are read as recorded; nothing is recomputed here. */
export async function listStockHandoverReports(client: Client, filter: ReportFilter): Promise<ReportRow[]> {
  const handovers = await client.handoverSession.findMany({
    where: {
      cafeId: filter.cafeId,
      ...(filter.branchId ? { branchId: filter.branchId } : {}),
      ...(filter.from || filter.to ? { createdAt: { ...(filter.from ? { gte: filter.from } : {}), ...(filter.to ? { lte: filter.to } : {}) } } : {}),
      ...(filter.status || filter.classification
        ? { stockReview: { ...(filter.status ? { status: filter.status } : {}), ...(filter.classification ? { classification: filter.classification } : {}) } }
        : {}),
    },
    orderBy: { createdAt: "desc" },
    take: Math.min(filter.take ?? 200, 1000),
    select: {
      id: true, branchId: true, status: true, createdAt: true, stockCountSessionId: true, acceptedStockCountSessionId: true,
      branch: { select: { name: true } },
      outgoingUser: { select: { name: true } },
      incomingUser: { select: { name: true } },
      incomingStockCount: { select: { submittedAt: true, counter: { select: { name: true } } } },
      stockComparisons: { orderBy: { computedAt: "desc" }, take: 1, select: { reliability: true, rawDifferenceCount: true, adjustedDifferenceCount: true, unavailableCount: true, computedAt: true, lines: true } },
      stockReview: { select: { status: true, classification: true, _count: { select: { notes: true } } } },
      stockAcknowledgements: { where: { decision: "DISPUTED" }, select: { line: { select: { sessionId: true } } } },
    },
  });
  const rows = handovers.map((h): ReportRow => {
    const c = h.stockComparisons[0] ?? null;
    const recorded = (c?.lines ?? null) as { outgoingCounted?: boolean; incomingCounted?: boolean; disputedCount?: number } | null;
    // The live sheet (current count only) or the recorded comparison, whichever
    // names more: a later correction may clear a sheet row, the record stays.
    const liveDisputes = h.stockAcknowledgements.filter((a) => a.line.sessionId === h.stockCountSessionId).length;
    const disputedCount = Math.max(liveDisputes, Number(recorded?.disputedCount ?? 0));
    const uncountedAcceptance = h.status === "COMPLETED" && h.acceptedStockCountSessionId === null;
    const outgoingCounted = recorded?.outgoingCounted ?? !!h.stockCountSessionId;
    const incomingCounted = recorded?.incomingCounted ?? !!h.incomingStockCount?.submittedAt;
    return {
      handoverId: h.id,
      branchId: h.branchId,
      branchName: h.branch.name,
      closedAt: h.createdAt.toISOString(),
      status: h.status,
      outgoingName: h.outgoingUser.name,
      incomingName: h.incomingStockCount?.counter.name ?? h.incomingUser?.name ?? null,
      outgoingCounted,
      incomingCounted,
      reliability: c?.reliability ?? "UNAVAILABLE",
      rawDifferenceCount: c?.rawDifferenceCount ?? 0,
      adjustedDifferenceCount: c?.adjustedDifferenceCount ?? 0,
      unavailableCount: c?.unavailableCount ?? 0,
      disputedCount,
      uncountedAcceptance,
      result: resultOf(c, outgoingCounted, incomingCounted, disputedCount, uncountedAcceptance),
      reviewStatus: h.stockReview?.status ?? null,
      classification: h.stockReview?.classification ?? null,
      notes: h.stockReview?._count.notes ?? 0,
      comparedAt: c?.computedAt.toISOString() ?? null,
    };
  });
  return filter.result ? rows.filter((r) => r.result === filter.result) : rows;
}

/** One handover in full: the live comparison, its history, the movements behind it and the review trail. */
export async function stockHandoverReportDetail(client: Client, args: { cafeId: string; viewerBranchId: string | null; handoverId: string; canAdjust?: boolean }) {
  const h = await client.handoverSession.findFirst({
    where: { id: args.handoverId, cafeId: args.cafeId },
    select: {
      id: true, branchId: true, status: true, createdAt: true, acceptedAt: true,
      branch: { select: { name: true } }, outgoingUser: { select: { name: true } }, incomingUser: { select: { name: true } },
      incomingStockCount: { select: { startedAt: true, submittedAt: true, counter: { select: { name: true } } } },
      stockComparisons: { orderBy: { computedAt: "desc" }, select: { id: true, version: true, reliability: true, rawDifferenceCount: true, adjustedDifferenceCount: true, unavailableCount: true, computedAt: true } },
      stockReview: {
        select: {
          id: true, status: true, classification: true, reviewedAt: true, resolvedAt: true,
          notes: { orderBy: { createdAt: "asc" }, select: { id: true, text: true, statusFrom: true, statusTo: true, classificationFrom: true, classificationTo: true, createdAt: true, author: { select: { name: true } } } },
        },
      },
    },
  });
  if (!h) throw new ApiError(404, "التسليم مش موجود");
  if (args.viewerBranchId !== null && h.branchId !== args.viewerBranchId) throw new ApiError(403, "ليس لديك صلاحية على فرع تاني");
  const comparison = await buildComparison(client as Prisma.TransactionClient, h.id);
  const adjustments = await linkedAdjustments(client, args.cafeId, h.id);
  const adjustmentOptions: Record<string, { token: string; bookQuantity: number; referenceCost: number | null }> = {};
  if (args.canAdjust && reviewedShortage(h.stockReview)) {
    const linkedItems = new Set(adjustments.map((row) => row.inventoryItemId));
    const ids = comparison.lines.filter((line) => !linkedItems.has(line.inventoryItemId) && shortage(comparison, line.inventoryItemId)).map((line) => line.inventoryItemId);
    const items = ids.length ? await client.inventoryItem.findMany({
      where: { id: { in: ids }, cafeId: args.cafeId, branchId: h.branchId, isActive: true },
      select: { id: true, currentStock: true, costPerUnit: true, ledgerVersion: true },
    }) : [];
    for (const item of items) {
      adjustmentOptions[item.id] = {
        token: adjustmentToken(comparison, item.id, item.ledgerVersion, item.costPerUnit.toFixed(2)),
        bookQuantity: item.currentStock.toNumber(),
        referenceCost: item.costPerUnit.gt(0) ? item.costPerUnit.toNumber() : null,
      };
    }
  }

  // The recorded movements behind every non-zero figure, so a reader can see
  // what explained (or did not explain) it.
  const movements: Record<string, { type: string; quantity: string; at: string; note: string | null; by: string | null }[]> = {};
  for (const line of comparison.lines) {
    if (!line.outgoing || !line.incoming || line.movementCount === 0) continue;
    const a = line.outgoing.itemVersion, b = line.incoming.itemVersion;
    if (a === null || b === null) continue;
    const lo = BigInt(a) < BigInt(b) ? BigInt(a) : BigInt(b);
    const hi = BigInt(a) < BigInt(b) ? BigInt(b) : BigInt(a);
    const rows = await client.inventoryTransaction.findMany({
      where: { inventoryItemId: line.inventoryItemId, itemVersion: { gt: lo, lte: hi } },
      orderBy: { itemVersion: "asc" },
      select: { type: true, quantity: true, createdAt: true, note: true, createdBy: { select: { name: true } } },
    });
    movements[line.inventoryItemId] = rows.map((r) => ({ type: r.type, quantity: r.quantity.toFixed(3), at: r.createdAt.toISOString(), note: r.note, by: r.createdBy?.name ?? null }));
  }

  return {
    handover: {
      id: h.id, status: h.status, branchName: h.branch.name, closedAt: h.createdAt.toISOString(), acceptedAt: h.acceptedAt?.toISOString() ?? null,
      outgoingName: h.outgoingUser.name, incomingName: h.incomingStockCount?.counter.name ?? h.incomingUser?.name ?? null,
      incomingCount: h.incomingStockCount ? { startedAt: h.incomingStockCount.startedAt.toISOString(), submittedAt: h.incomingStockCount.submittedAt?.toISOString() ?? null } : null,
    },
    comparison: { ...comparison, lines: comparison.lines.map((l) => ({ ...l, labelText: LABEL_AR[l.label] })) },
    history: h.stockComparisons.map((c) => ({ ...c, computedAt: c.computedAt.toISOString() })),
    movements,
    adjustments,
    adjustmentOptions,
    review: h.stockReview
      ? {
          status: h.stockReview.status, classification: h.stockReview.classification,
          reviewedAt: h.stockReview.reviewedAt?.toISOString() ?? null, resolvedAt: h.stockReview.resolvedAt?.toISOString() ?? null,
          notes: h.stockReview.notes.map((n) => ({ ...n, createdAt: n.createdAt.toISOString(), authorName: n.author.name })),
        }
      : null,
  };
}

/**
 * Append a review note, optionally moving the status and/or classification.
 * The note text is required: a conclusion nobody explained is not a review.
 * Idempotent per review and key.
 */
export async function addReviewNote(tx: Prisma.TransactionClient, args: {
  cafeId: string; viewerBranchId: string | null; handoverId: string; actorId: string;
  text: string; status?: StockHandoverReviewStatus | null; classification?: StockHandoverClassification | null; idempotencyKey: string;
}) {
  const text = args.text?.trim() ?? "";
  if (!text) throw new ApiError(400, "اكتب ملاحظة المراجعة");
  const h = await tx.handoverSession.findFirst({ where: { id: args.handoverId, cafeId: args.cafeId }, select: { id: true, cafeId: true, branchId: true } });
  if (!h) throw new ApiError(404, "التسليم مش موجود");
  if (args.viewerBranchId !== null && h.branchId !== args.viewerBranchId) throw new ApiError(403, "ليس لديك صلاحية على فرع تاني");
  await tx.$queryRaw`SELECT "id" FROM "HandoverSession" WHERE "id" = ${h.id} FOR UPDATE`;
  const review = await tx.stockHandoverReview.upsert({ where: { handoverId: h.id }, create: { cafeId: h.cafeId, branchId: h.branchId, handoverId: h.id }, update: {} });
  const replay = await tx.stockHandoverReviewNote.findUnique({ where: { reviewId_idempotencyKey: { reviewId: review.id, idempotencyKey: args.idempotencyKey } } });
  if (replay) return { review, note: replay, replayed: true };

  const statusTo = args.status && args.status !== review.status ? args.status : null;
  const classificationTo = args.classification && args.classification !== review.classification ? args.classification : null;
  const now = new Date();
  const note = await tx.stockHandoverReviewNote.create({
    data: {
      reviewId: review.id, authorId: args.actorId, text,
      statusFrom: statusTo ? review.status : null, statusTo,
      classificationFrom: classificationTo ? review.classification : null, classificationTo,
      idempotencyKey: args.idempotencyKey,
    },
  });
  const updated = await tx.stockHandoverReview.update({
    where: { id: review.id },
    data: {
      lastActorId: args.actorId,
      ...(statusTo ? { status: statusTo } : {}),
      ...(classificationTo ? { classification: classificationTo } : {}),
      ...(statusTo === "REVIEWED" ? { reviewedAt: now } : {}),
      ...(statusTo === "RESOLVED" ? { resolvedAt: now } : {}),
    },
  });
  await auditInTransaction(tx, {
    cafeId: h.cafeId, userId: args.actorId, action: "STOCK_HANDOVER_REVIEW_NOTE", entity: "HandoverSession", entityId: h.id,
    details: { reviewId: review.id, noteId: note.id, statusFrom: note.statusFrom, statusTo, classificationFrom: note.classificationFrom, classificationTo },
  });
  return { review: updated, note, replayed: false };
}

/** The report as a spreadsheet: the list, and per handover the item lines. */
export async function stockHandoverReportXlsx(client: Client, filter: ReportFilter): Promise<Buffer> {
  const rows = await listStockHandoverReports(client, filter);
  const RESULT_AR = { UNEXPLAINED: "فرق غير مفسَّر", EXPLAINED: "فرق مفسَّر بحركات", MISSING: "جرد ناقص", NONE: "مطابق" } as const;
  const listSheet: XlsxSheetCell[][] = [
    ["الفرع", "تاريخ التسليم", "المُسلِّم", "المُستلِم", "جرد المُسلِّم", "جرد المُستلِم", "الموثوقية", "أصناف بفرق خام", "أصناف بفرق غير مفسَّر", "غير متاح", "النتيجة", "حالة المراجعة", "التصنيف", "عدد الملاحظات", "أصناف عليها اعتراض", "استلام من غير جرد مؤكد"],
    ...rows.map((r) => [
      r.branchName, { value: r.closedAt, format: "datetime" as const }, r.outgoingName, r.incomingName ?? "—",
      r.outgoingCounted ? "اتعدّ" : "ناقص", r.incomingCounted ? "اتعدّ" : "ناقص", r.reliability,
      { value: r.rawDifferenceCount, format: "int" as const }, { value: r.adjustedDifferenceCount, format: "int" as const }, { value: r.unavailableCount, format: "int" as const },
      RESULT_AR[r.result], r.reviewStatus ? STATUS_AR[r.reviewStatus] : "—", r.classification ? CLASSIFICATION_AR[r.classification] : "—", { value: r.notes, format: "int" as const },
      { value: r.disputedCount, format: "int" as const },
      r.uncountedAcceptance ? "نعم" : "",
    ]),
  ];
  const lineSheet: XlsxSheetCell[][] = [["الفرع", "تاريخ التسليم", "الصنف", "الوحدة", "عدّ المُسلِّم", "عدّ المُستلِم", "الفرق الخام", "صافي الحركات", "المتوقع", "الفرق بعد الحركات", "الموثوقية", "النتيجة", "ملاحظة", "اعتراض المُستلِم"]];
  for (const r of rows.slice(0, 200)) {
    const c = await buildComparison(client as Prisma.TransactionClient, r.handoverId);
    for (const l of c.lines as ComparisonLineRecord[]) {
      const q = (v: string | null | undefined) => (v === null || v === undefined ? null : { value: Number(v), format: "qty" as const });
      lineSheet.push([r.branchName, { value: r.closedAt, format: "datetime" as const }, l.itemName, l.unit, q(l.outgoing?.quantity), q(l.incoming?.quantity), q(l.raw), q(l.netMovement), q(l.expected), q(l.adjusted), l.reliability, LABEL_AR[l.label], l.note ?? "", l.disputed ? "اعترض" : ""]);
    }
  }
  return buildXlsx([
    { name: "تسليمات المخزن", rows: listSheet, headerRows: [0], filter: true, frozenColumns: 1 },
    { name: "الأصناف", rows: lineSheet, headerRows: [0], filter: true, frozenColumns: 3 },
  ]);
}
