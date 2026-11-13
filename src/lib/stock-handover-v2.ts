// Stock handover v2 — count, compare, report; never block (owner decision 2026-11-12).
//
// A stock handover is accountability, not a gate. The outgoing employee's count
// (the handover's existing `StockCountSession`) and the incoming employee's own
// blind count (`StockHandoverIncomingCount`) are kept side by side. Neither one
// moves stock, money or a shift's state. When both exist they are compared per
// item:
//
//   raw       = incoming − outgoing
//   net       = Σ recorded ledger movement strictly after the earlier count's
//               cursor and up to (including) the later count's cursor
//   expected  = outgoing + net          (signed: an incoming count taken BEFORE
//                                        the outgoing one subtracts the window)
//   adjusted  = incoming − expected
//
// The cursor is the item's `ledgerVersion` at the moment each quantity was
// observed (`InventoryTransaction.itemVersion` is the version a movement was
// written at), so a movement is either inside the window or not — never
// counted twice, never missed. Quantities are handled as integer thousandths;
// no floating point reaches a figure.
//
// A nonzero raw OR adjusted difference notifies every manager of the branch and
// every owner of the café, once per comparison version and recipient, in the
// same transaction as the submission that produced it. Corrections are new
// line revisions with a reason; the comparison is then recomputed under a new
// version, and the earlier one stays on record.

import { createHash } from "node:crypto";
import type { InventoryUnit, Prisma, StockComparisonReliability } from "@prisma/client";
import { ApiError } from "@/lib/api";
import { auditInTransaction } from "@/lib/audit";
import { effectiveCountEvidence, EFFECTIVE_EVIDENCE_SELECT, hasAuthoritativeObservation } from "@/lib/count-evidence";
import { lockItemForUpdate } from "@/lib/ledger";

export {
  toMilli, fromMilli, compareItem, LABEL_AR, MISSING_OUTGOING, MISSING_INCOMING, UNIT_MISMATCH, NO_CURSOR,
  type CountObservation, type LedgerMovement, type ComparisonLabel, type ItemComparison,
} from "@/lib/stock-handover-compare";
import { toMilli, fromMilli, compareItem, type CountObservation, type LedgerMovement, type ComparisonLabel } from "@/lib/stock-handover-compare";

// ─────────────────────────── reading the evidence ───────────────────────────

type Client = Prisma.TransactionClient;

export type ComparisonLineRecord = {
  inventoryItemId: string;
  itemName: string;
  unit: InventoryUnit;
  outgoing: { quantity: string; unit: InventoryUnit; countedAt: string; itemVersion: string | null; counterId: string | null } | null;
  /** `source`: the v2 blind count, or the legacy line-by-line receiving sheet (C1). */
  incoming: { quantity: string; unit: InventoryUnit; countedAt: string; itemVersion: string | null; counterId: string | null; revision: number; source: IncomingSource } | null;
  /** The incoming employee refused this line on the legacy receiving sheet. */
  disputed: boolean;
  raw: string | null;
  netMovement: string | null;
  expected: string | null;
  adjusted: string | null;
  movementCount: number;
  reliability: StockComparisonReliability;
  label: ComparisonLabel;
  note: string | null;
};

export type ComparisonSnapshot = {
  handoverId: string;
  cafeId: string;
  branchId: string;
  version: string;
  reliability: StockComparisonReliability;
  outgoingCounted: boolean;
  incomingCounted: boolean;
  sameCounter: boolean;
  lines: ComparisonLineRecord[];
  rawDifferenceCount: number;
  adjustedDifferenceCount: number;
  unavailableCount: number;
  /** Lines the incoming employee refused on the legacy receiving sheet. */
  disputedCount: number;
};

export type IncomingSource = "INCOMING_COUNT" | "LEGACY_SHEET";

const observationJson = (o: CountObservation) => ({
  quantity: fromMilli(o.quantityMilli), unit: o.unit, countedAt: o.countedAt.toISOString(),
  itemVersion: o.itemVersion === null ? null : String(o.itemVersion), counterId: o.counterId,
});

/** The outgoing count's current observation per item (recount > approved correction > line). */
async function outgoingObservations(tx: Client, sessionId: string | null) {
  const map = new Map<string, CountObservation>();
  if (!sessionId) return { map, counted: false, counterIds: new Set<string>() };
  const lines = await tx.stockCountLine.findMany({
    where: { sessionId },
    select: { ...EFFECTIVE_EVIDENCE_SELECT, inventoryItemId: true, unit: true },
  });
  const counterIds = new Set<string>();
  for (const line of lines) {
    if (!hasAuthoritativeObservation(line)) continue;
    const evidence = effectiveCountEvidence(line);
    if (!evidence.countedAt) continue;
    map.set(line.inventoryItemId, {
      // The resolver hands back a JS number; fix it to the column precision first.
      quantityMilli: toMilli(Number(evidence.quantity).toFixed(3)),
      unit: line.unit,
      countedAt: evidence.countedAt,
      itemVersion: evidence.itemVersion ?? null,
      counterId: evidence.counterId ?? null,
    });
    if (evidence.counterId) counterIds.add(evidence.counterId);
  }
  return { map, counted: map.size > 0, counterIds };
}

/** The incoming count's current revision per item. */
async function incomingObservations(tx: Client, handoverId: string) {
  const count = await tx.stockHandoverIncomingCount.findUnique({
    where: { handoverId },
    select: { id: true, submittedAt: true, lines: { orderBy: [{ inventoryItemId: "asc" }, { revision: "desc" }] } },
  });
  const map = new Map<string, CountObservation & { revision: number }>();
  const counterIds = new Set<string>();
  if (!count || !count.submittedAt) return { map, counted: false, counterIds, countId: count?.id ?? null };
  for (const line of count.lines) {
    if (map.has(line.inventoryItemId)) continue; // highest revision first
    map.set(line.inventoryItemId, {
      quantityMilli: toMilli(line.quantity.toFixed(3)),
      unit: line.unit,
      countedAt: line.countedAt,
      itemVersion: line.itemVersion,
      counterId: line.counterId,
      revision: line.revision,
    });
    counterIds.add(line.counterId);
  }
  return { map, counted: map.size > 0, counterIds, countId: count.id };
}

/**
 * C1. The legacy line-by-line receiving sheet (`HandoverStockAcknowledgement`)
 * of the CURRENT outgoing count. v2 completes a handover whatever the sheet
 * says, so the sheet's figures and refusals must be read here or they reach
 * nobody. A figure has no ledger cursor of its own (the sheet never stored
 * one), so it compares PROVISIONAL, by time. A refusal is kept as a refusal
 * even when it carries no figure: a missing count is never a zero.
 */
async function legacySheetEvidence(tx: Client, handoverId: string, sessionId: string | null) {
  const map = new Map<string, CountObservation & { revision: number }>();
  const disputed = new Set<string>();
  if (!sessionId) return { map, disputed, differing: 0 };
  const acks = await tx.handoverStockAcknowledgement.findMany({
    where: { handoverId, line: { sessionId } },
    select: { incomingCountedQuantity: true, varianceQuantity: true, decision: true, acknowledgedAt: true, acknowledgedById: true,
      line: { select: { inventoryItemId: true, unit: true } } },
  });
  let differing = 0;
  for (const ack of acks) {
    const itemId = ack.line.inventoryItemId;
    if (ack.decision === "DISPUTED") disputed.add(itemId);
    if (ack.varianceQuantity !== null && !ack.varianceQuantity.isZero()) differing += 1;
    if (ack.incomingCountedQuantity === null) continue;
    map.set(itemId, {
      quantityMilli: toMilli(ack.incomingCountedQuantity.toFixed(3)),
      unit: ack.line.unit,
      countedAt: ack.acknowledgedAt,
      itemVersion: null,
      counterId: ack.acknowledgedById,
      revision: 1,
    });
  }
  return { map, disputed, differing };
}

/** Build the comparison from the database. Read-only. */
export async function buildComparison(tx: Client, handoverId: string): Promise<ComparisonSnapshot> {
  const handover = await tx.handoverSession.findUnique({
    where: { id: handoverId },
    select: { id: true, cafeId: true, branchId: true, stockCountSessionId: true },
  });
  if (!handover) throw new ApiError(404, "التسليم مش موجود");
  const [out, v2inc, sheet] = await Promise.all([
    outgoingObservations(tx, handover.stockCountSessionId),
    incomingObservations(tx, handover.id),
    legacySheetEvidence(tx, handover.id, handover.stockCountSessionId),
  ]);
  // The v2 blind count wins per item; the legacy sheet fills only what it did not count.
  const source = new Map<string, IncomingSource>();
  const incMap = new Map(v2inc.map);
  for (const id of incMap.keys()) source.set(id, "INCOMING_COUNT");
  for (const [id, o] of sheet.map) if (!incMap.has(id)) { incMap.set(id, o); source.set(id, "LEGACY_SHEET"); }
  const sheetCounters = [...sheet.map.values()].map((o) => o.counterId).filter((id): id is string => !!id);
  const inc = { map: incMap, counted: incMap.size > 0, counterIds: new Set([...v2inc.counterIds, ...sheetCounters]) };
  const itemIds = [...new Set([...out.map.keys(), ...inc.map.keys(), ...sheet.disputed])].sort();
  const items = itemIds.length
    ? await tx.inventoryItem.findMany({ where: { id: { in: itemIds } }, select: { id: true, name: true, unit: true } })
    : [];
  const itemById = new Map(items.map((i) => [i.id, i]));

  // Every movement that could fall in any item's window, read once.
  const versions = [...out.map.values(), ...inc.map.values()].map((o) => o.itemVersion).filter((v): v is bigint => v !== null);
  const times = [...out.map.values(), ...inc.map.values()].map((o) => o.countedAt.getTime());
  const movementRows = itemIds.length
    ? await tx.inventoryTransaction.findMany({
        where: {
          inventoryItemId: { in: itemIds },
          OR: [
            ...(versions.length ? [{ itemVersion: { gt: versions.reduce((a, b) => (a < b ? a : b)) } }] : []),
            ...(times.length ? [{ createdAt: { gt: new Date(Math.min(...times)) } }] : []),
          ],
        },
        select: { inventoryItemId: true, itemVersion: true, quantity: true, createdAt: true },
        orderBy: [{ inventoryItemId: "asc" }, { itemVersion: "asc" }],
      })
    : [];
  const movementsByItem = new Map<string, LedgerMovement[]>();
  for (const row of movementRows) {
    const list = movementsByItem.get(row.inventoryItemId) ?? [];
    list.push({ itemVersion: row.itemVersion, quantityMilli: toMilli(row.quantity.toFixed(3)), createdAt: row.createdAt });
    movementsByItem.set(row.inventoryItemId, list);
  }

  const lines: ComparisonLineRecord[] = itemIds.map((id) => {
    const o = out.map.get(id) ?? null;
    const i = inc.map.get(id) ?? null;
    const moves = movementsByItem.get(id) ?? [];
    const c = compareItem(o, i, moves);
    const item = itemById.get(id);
    return {
      inventoryItemId: id,
      itemName: item?.name ?? id,
      unit: item?.unit ?? (o?.unit ?? i!.unit),
      outgoing: o ? observationJson(o) : null,
      incoming: i ? { ...observationJson(i), revision: i.revision, source: source.get(id) ?? "INCOMING_COUNT" } : null,
      disputed: sheet.disputed.has(id),
      raw: c.rawMilli === null ? null : fromMilli(c.rawMilli),
      netMovement: c.netMilli === null ? null : fromMilli(c.netMilli),
      expected: c.expectedMilli === null ? null : fromMilli(c.expectedMilli),
      adjusted: c.adjustedMilli === null ? null : fromMilli(c.adjustedMilli),
      movementCount: c.movementCount,
      reliability: c.reliability,
      label: c.label,
      note: c.note,
    };
  });

  const reliability: StockComparisonReliability =
    !out.counted || !inc.counted || lines.every((l) => l.reliability === "UNAVAILABLE")
      ? "UNAVAILABLE"
      // Provisional only when a figure was compared without a ledger cursor;
      // a missing item is counted in `unavailableCount`, not here.
      : lines.some((l) => l.reliability === "PROVISIONAL")
        ? "PROVISIONAL"
        : "CONFIRMED";
  const sameCounter = [...inc.counterIds].some((id) => out.counterIds.has(id));
  const version = createHash("sha256").update(JSON.stringify(lines.map((l) => [
    // A v2-count line hashes exactly as before C1 (no `source` key), so an
    // existing comparison keeps its version and is never re-notified.
    l.inventoryItemId, l.outgoing, l.incoming?.source === "INCOMING_COUNT" ? (({ source: _s, ...rest }) => rest)(l.incoming) : l.incoming,
    l.raw, l.netMovement, l.adjusted, l.reliability,
    // Appended only when set, so a line with no sheet refusal hashes as before.
    ...(l.disputed ? ["DISPUTED"] : []),
  ]))).digest("hex");

  return {
    handoverId: handover.id,
    cafeId: handover.cafeId,
    branchId: handover.branchId,
    version,
    reliability,
    outgoingCounted: out.counted,
    incomingCounted: inc.counted,
    sameCounter,
    lines,
    rawDifferenceCount: lines.filter((l) => l.raw !== null && toMilli(l.raw) !== BigInt(0)).length,
    adjustedDifferenceCount: lines.filter((l) => l.adjusted !== null && toMilli(l.adjusted) !== BigInt(0)).length,
    unavailableCount: lines.filter((l) => l.reliability === "UNAVAILABLE").length,
    disputedCount: lines.filter((l) => l.disputed).length,
  };
}

// ─────────────────────────── recording + notifying ───────────────────────────

/** Branch managers of the branch and owners of the café — active, not archived. */
export async function stockHandoverRecipients(tx: Client, cafeId: string, branchId: string): Promise<string[]> {
  const users = await tx.user.findMany({
    where: {
      cafeId, isActive: true, archivedAt: null,
      OR: [
        { role: "CAFE_OWNER" },
        { role: "BRANCH_MANAGER", OR: [{ branchId }, { temporaryBranchId: branchId }] },
      ],
    },
    select: { id: true },
    orderBy: { id: "asc" },
  });
  return users.map((u) => u.id);
}

/**
 * Persist the current comparison (once per version) and, when it shows any
 * difference, notify each recipient exactly once for that version. Runs on
 * the caller's transaction, so the notification commits with the submission
 * that caused it or not at all; a retry finds the same rows.
 */
export async function recordComparison(tx: Client, handoverId: string, actorId: string) {
  const snapshot = await buildComparison(tx, handoverId);
  let comparison = await tx.stockHandoverComparison.findUnique({
    where: { handoverId_version: { handoverId, version: snapshot.version } },
    select: { id: true },
  });
  if (!comparison) {
    comparison = await tx.stockHandoverComparison.create({
      data: {
        cafeId: snapshot.cafeId, branchId: snapshot.branchId, handoverId, version: snapshot.version,
        reliability: snapshot.reliability, itemCount: snapshot.lines.length,
        rawDifferenceCount: snapshot.rawDifferenceCount, adjustedDifferenceCount: snapshot.adjustedDifferenceCount,
        unavailableCount: snapshot.unavailableCount,
        lines: JSON.parse(JSON.stringify({ lines: snapshot.lines, sameCounter: snapshot.sameCounter, outgoingCounted: snapshot.outgoingCounted, incomingCounted: snapshot.incomingCounted, disputedCount: snapshot.disputedCount })),
      },
      select: { id: true },
    });
    await auditInTransaction(tx, {
      cafeId: snapshot.cafeId, userId: actorId, action: "STOCK_HANDOVER_COMPARED", entity: "HandoverSession", entityId: handoverId,
      details: { comparisonId: comparison.id, version: snapshot.version, reliability: snapshot.reliability, rawDifferenceCount: snapshot.rawDifferenceCount, adjustedDifferenceCount: snapshot.adjustedDifferenceCount, unavailableCount: snapshot.unavailableCount, disputedCount: snapshot.disputedCount },
    });
  }

  // A refusal on the legacy sheet is a disagreement even with no figure (C1).
  const hasDifference = snapshot.rawDifferenceCount > 0 || snapshot.adjustedDifferenceCount > 0 || snapshot.disputedCount > 0;
  let notified = 0;
  if (hasDifference) {
    await ensureReview(tx, snapshot.cafeId, snapshot.branchId, handoverId);
    const recipients = await stockHandoverRecipients(tx, snapshot.cafeId, snapshot.branchId);
    const branch = await tx.branch.findUnique({ where: { id: snapshot.branchId }, select: { name: true } });
    const unexplained = snapshot.adjustedDifferenceCount;
    const created = await tx.notification.createMany({
      data: recipients.map((recipientId) => ({
        cafeId: snapshot.cafeId, branchId: snapshot.branchId, recipientId, kind: "STOCK_HANDOVER_DISCREPANCY" as const,
        handoverId, comparisonId: comparison!.id,
        dedupeKey: `shv2:discrepancy:${comparison!.id}:${recipientId}`,
        title: snapshot.disputedCount > 0 ? `المُستلِم اعترض على جرد التسليم — ${branch?.name ?? ""}` : unexplained > 0 ? `فرق غير مفسَّر في جرد التسليم — ${branch?.name ?? ""}` : `فرق في جرد التسليم مفسَّر بحركات — ${branch?.name ?? ""}`,
        body: `أصناف بفرق خام: ${snapshot.rawDifferenceCount} · أصناف بفرق غير مفسَّر: ${unexplained} · غير متاح: ${snapshot.unavailableCount}${snapshot.disputedCount > 0 ? ` · أصناف عليها اعتراض: ${snapshot.disputedCount}` : ""}`,
        payload: { comparisonId: comparison!.id, version: snapshot.version, rawDifferenceCount: snapshot.rawDifferenceCount, adjustedDifferenceCount: unexplained, reliability: snapshot.reliability, disputedCount: snapshot.disputedCount },
      })),
      skipDuplicates: true,
    });
    notified = created.count;
  }
  return { comparisonId: comparison.id, snapshot, notified };
}

/** Notify that one side's count is missing — once per handover, side and recipient. */
export async function notifyMissingCount(tx: Client, handoverId: string, side: "OUTGOING" | "INCOMING", body?: string) {
  const handover = await tx.handoverSession.findUniqueOrThrow({ where: { id: handoverId }, select: { cafeId: true, branchId: true, branch: { select: { name: true } } } });
  const recipients = await stockHandoverRecipients(tx, handover.cafeId, handover.branchId);
  const created = await tx.notification.createMany({
    data: recipients.map((recipientId) => ({
      cafeId: handover.cafeId, branchId: handover.branchId, recipientId, kind: "STOCK_HANDOVER_MISSING_COUNT" as const, handoverId,
      dedupeKey: `shv2:missing:${handoverId}:${side}:${recipientId}`,
      title: `جرد تسليم ناقص — ${handover.branch.name}`,
      body: body ?? (side === "OUTGOING" ? "الموظف المُسلِّم قفل من غير ما يعدّ الخامات" : "الموظف المُستلِم استلم من غير ما يعدّ الخامات"),
      payload: { side },
    })),
    skipDuplicates: true,
  });
  return created.count;
}

async function ensureReview(tx: Client, cafeId: string, branchId: string, handoverId: string) {
  await tx.stockHandoverReview.upsert({
    where: { handoverId },
    create: { cafeId, branchId, handoverId },
    update: {},
  });
}

// ─────────────────────────── the incoming blind count ───────────────────────────

const NOT_FOUND = "التسليم مش موجود";
const FOREIGN = "ليس لديك صلاحية على فرع تاني";
const ALREADY_SUBMITTED_NEEDS_REASON = "الجرد اتقدّم خلاص — أي تعديل لازم يكون له سبب مكتوب";
const NOT_STARTED = "ابدأ جرد الاستلام الأول";
const NOTHING_COUNTED = "لازم تعدّ صنف واحد على الأقل قبل التقديم";
const FOREIGN_ITEM = "الصنف ده مش من مخزن الفرع ده";
/** A system-coded reason for a figure re-entered before submission — never invented prose. */
export const PRE_SUBMIT_EDIT = "PRE_SUBMIT_EDIT";

type Actor = { actorId: string; cafeId: string; viewerBranchId: string | null };

async function loadHandover(tx: Client, handoverId: string, actor: Actor) {
  const h = await tx.handoverSession.findFirst({
    where: { id: handoverId, cafeId: actor.cafeId },
    select: { id: true, cafeId: true, branchId: true, status: true, incomingShiftId: true, outgoingUserId: true },
  });
  if (!h) throw new ApiError(404, NOT_FOUND);
  if (actor.viewerBranchId !== null && h.branchId !== actor.viewerBranchId) throw new ApiError(403, FOREIGN);
  await tx.$queryRaw`SELECT "id" FROM "HandoverSession" WHERE "id" = ${h.id} FOR UPDATE`;
  return h;
}

/** Start (or return) the incoming count. Allowed whatever the handover status: counting never waits. */
export async function startIncomingCount(tx: Client, args: Actor & { handoverId: string; shiftId?: string | null }) {
  const h = await loadHandover(tx, args.handoverId, args);
  const existing = await tx.stockHandoverIncomingCount.findUnique({ where: { handoverId: h.id } });
  if (existing) return { count: existing, created: false };
  const shift = args.shiftId
    ? await tx.shift.findFirst({ where: { id: args.shiftId, branchId: h.branchId }, select: { id: true } })
    : await tx.shift.findFirst({ where: { branchId: h.branchId, cashierId: args.actorId, status: "OPEN" }, select: { id: true }, orderBy: { openedAt: "desc" } });
  const count = await tx.stockHandoverIncomingCount.create({
    data: { cafeId: h.cafeId, branchId: h.branchId, handoverId: h.id, shiftId: shift?.id ?? h.incomingShiftId ?? null, counterId: args.actorId },
  });
  await auditInTransaction(tx, {
    cafeId: h.cafeId, userId: args.actorId, action: "STOCK_HANDOVER_INCOMING_COUNT_STARTED", entity: "HandoverSession", entityId: h.id,
    details: { countId: count.id, shiftId: count.shiftId, handoverStatus: h.status },
  });
  return { count, created: true };
}

/**
 * Record one observation. The cursor is read under the item's row lock, so it
 * is exactly the ledger position the figure belongs to. A repeat with the same
 * key returns the first row. Any later figure for the same item is a new
 * revision; after submission it must carry a written reason.
 */
export async function recordIncomingLine(tx: Client, args: Actor & {
  handoverId: string; inventoryItemId: string; quantity: unknown; reason?: string | null; idempotencyKey: string;
}) {
  if (!args.idempotencyKey) throw new ApiError(400, "Idempotency-Key مطلوب");
  const h = await loadHandover(tx, args.handoverId, args);
  const count = await tx.stockHandoverIncomingCount.findUnique({ where: { handoverId: h.id } });
  if (!count) throw new ApiError(409, NOT_STARTED);
  const replay = await tx.stockHandoverIncomingLine.findUnique({ where: { countId_idempotencyKey: { countId: count.id, idempotencyKey: args.idempotencyKey } } });
  if (replay) return { line: replay, replayed: true, comparison: null };

  const quantityMilli = toMilli(args.quantity);
  if (quantityMilli < BigInt(0)) throw new ApiError(400, "الكمية مايصحش تكون بالسالب");
  const item = await tx.inventoryItem.findFirst({ where: { id: args.inventoryItemId, branchId: h.branchId, cafeId: h.cafeId }, select: { id: true } });
  if (!item) throw new ApiError(400, FOREIGN_ITEM);
  const locked = await lockItemForUpdate(tx, item.id);

  const previous = await tx.stockHandoverIncomingLine.findFirst({
    where: { countId: count.id, inventoryItemId: item.id }, orderBy: { revision: "desc" }, select: { revision: true },
  });
  const revision = (previous?.revision ?? 0) + 1;
  const typedReason = args.reason?.trim() || null;
  if (count.submittedAt && revision > 1 && !typedReason) throw new ApiError(400, ALREADY_SUBMITTED_NEEDS_REASON);
  if (count.submittedAt && revision === 1 && !typedReason) throw new ApiError(400, ALREADY_SUBMITTED_NEEDS_REASON);
  const reason = typedReason ?? (revision > 1 ? PRE_SUBMIT_EDIT : null);

  const line = await tx.stockHandoverIncomingLine.create({
    data: {
      countId: count.id, inventoryItemId: item.id, unit: locked.unit, quantity: fromMilli(quantityMilli),
      countedAt: new Date(), itemVersion: locked.ledgerVersion, counterId: args.actorId, revision, reason, idempotencyKey: args.idempotencyKey,
    },
  });
  await auditInTransaction(tx, {
    cafeId: h.cafeId, userId: args.actorId, action: revision > 1 ? "STOCK_HANDOVER_INCOMING_LINE_REVISED" : "STOCK_HANDOVER_INCOMING_LINE_RECORDED",
    entity: "HandoverSession", entityId: h.id,
    details: { countId: count.id, lineId: line.id, inventoryItemId: item.id, quantity: fromMilli(quantityMilli), revision, reason, itemVersion: String(locked.ledgerVersion), afterSubmission: !!count.submittedAt },
  });
  // A correction after submission is a new fact: compare again, notify again.
  const comparison = count.submittedAt ? await recordComparison(tx, h.id, args.actorId) : null;
  return { line, replayed: false, comparison };
}

/** Submit the incoming count; compares and notifies in the same transaction. Idempotent. */
export async function submitIncomingCount(tx: Client, args: Actor & { handoverId: string }) {
  const h = await loadHandover(tx, args.handoverId, args);
  const count = await tx.stockHandoverIncomingCount.findUnique({ where: { handoverId: h.id }, select: { id: true, submittedAt: true, _count: { select: { lines: true } } } });
  if (!count) throw new ApiError(409, NOT_STARTED);
  if (count._count.lines === 0) throw new ApiError(400, NOTHING_COUNTED);
  let alreadySubmitted = true;
  if (!count.submittedAt) {
    alreadySubmitted = false;
    await tx.stockHandoverIncomingCount.update({ where: { id: count.id }, data: { submittedAt: new Date() } });
    await auditInTransaction(tx, {
      cafeId: h.cafeId, userId: args.actorId, action: "STOCK_HANDOVER_INCOMING_COUNT_SUBMITTED", entity: "HandoverSession", entityId: h.id,
      details: { countId: count.id, lines: count._count.lines },
    });
  }
  const result = await recordComparison(tx, h.id, args.actorId);
  if (!result.snapshot.outgoingCounted) await notifyMissingCount(tx, h.id, "OUTGOING");
  return { ...result, alreadySubmitted };
}

/** What the incoming counter may see: their own figures, never the outgoing ones before submitting. */
export async function incomingCountView(tx: Client, args: Actor & { handoverId: string; canSeeOutgoing: boolean }) {
  const h = await tx.handoverSession.findFirst({ where: { id: args.handoverId, cafeId: args.cafeId }, select: { id: true, branchId: true, status: true } });
  if (!h) throw new ApiError(404, NOT_FOUND);
  if (args.viewerBranchId !== null && h.branchId !== args.viewerBranchId) throw new ApiError(403, FOREIGN);
  const [count, items] = await Promise.all([
    tx.stockHandoverIncomingCount.findUnique({ where: { handoverId: h.id }, include: { lines: { orderBy: [{ inventoryItemId: "asc" }, { revision: "desc" }] } } }),
    tx.inventoryItem.findMany({ where: { branchId: h.branchId, isActive: true, archivedAt: null }, select: { id: true, name: true, unit: true, isCritical: true }, orderBy: { name: "asc" } }),
  ]);
  const current = new Map<string, { quantity: string; revision: number; countedAt: string }>();
  for (const line of count?.lines ?? []) {
    if (!current.has(line.inventoryItemId)) current.set(line.inventoryItemId, { quantity: line.quantity.toFixed(3), revision: line.revision, countedAt: line.countedAt.toISOString() });
  }
  const submitted = !!count?.submittedAt;
  // Blind by construction: no outgoing quantity is read unless disclosure is allowed.
  const comparison = submitted || args.canSeeOutgoing ? await buildComparison(tx, h.id) : null;
  return {
    handoverId: h.id,
    status: h.status,
    count: count ? { id: count.id, startedAt: count.startedAt.toISOString(), submittedAt: count.submittedAt?.toISOString() ?? null, counterId: count.counterId } : null,
    items: items.map((i) => ({ id: i.id, name: i.name, unit: i.unit, isCritical: i.isCritical, counted: current.get(i.id) ?? null })),
    comparison,
  };
}

/** Whether the outgoing count holds at least one real observation. */
export async function outgoingCountRecorded(tx: Client, handoverId: string): Promise<boolean> {
  const h = await tx.handoverSession.findUnique({ where: { id: handoverId }, select: { stockCountSessionId: true } });
  return (await outgoingObservations(tx, h?.stockCountSessionId ?? null)).counted;
}

/**
 * C1. Record the comparison when the legacy receiving sheet of the current
 * count holds a refusal or a figure that differs from what was handed over.
 * Called on the sheet's own transaction, and again at acceptance so a dispute
 * written before v2 read the sheet still reaches the manager and owner. A
 * sheet that only signed matching figures records nothing new. Idempotent:
 * the comparison is per version and notifications are deduplicated.
 */
export async function recordLegacySheetDisputes(tx: Client, handoverId: string, actorId: string) {
  const h = await tx.handoverSession.findUnique({ where: { id: handoverId }, select: { stockCountSessionId: true } });
  const sheet = await legacySheetEvidence(tx, handoverId, h?.stockCountSessionId ?? null);
  if (sheet.disputed.size === 0 && sheet.differing === 0) return null;
  return recordComparison(tx, handoverId, actorId);
}

export const STOCK_HANDOVER_ACCEPTED_UNCOUNTED = "STOCK_HANDOVER_ACCEPTED_UNCOUNTED";
const UNCOUNTED_BODY = "التسليم اتستلم من غير جرد مُسلِّم مؤكد — الخامات اتنقلت بأرقام الدفتر من غير عدّ";

/**
 * C2. A handover received with no CONFIRMED outgoing count (the outgoing
 * employee never finished, or the count never confirmed) is recorded as an
 * UNCOUNTED handover, never completed silently: one audit row stating what
 * the outgoing count was and what the snapshot holds, and a missing-count
 * notification to every branch manager and owner; the report flags it as
 * received without a confirmed count. The stock snapshot is the boundary the
 * acceptance has just written (every item carried at the book figure,
 * `verified = false`). Runs on the acceptance's transaction, once.
 */
export async function recordUncountedAcceptance(tx: Client, handoverId: string, actorId: string, acceptedSessionId: string | null) {
  if (acceptedSessionId) return false;
  const h = await tx.handoverSession.findUniqueOrThrow({
    where: { id: handoverId },
    select: { cafeId: true, branchId: true, status: true, target: true, stockCountSessionId: true },
  });
  if (await tx.auditLog.findFirst({ where: { entity: "HandoverSession", entityId: handoverId, action: STOCK_HANDOVER_ACCEPTED_UNCOUNTED }, select: { id: true } })) return false;
  const session = h.stockCountSessionId
    ? await tx.stockCountSession.findUnique({ where: { id: h.stockCountSessionId }, select: { status: true, lines: { select: EFFECTIVE_EVIDENCE_SELECT } } })
    : null;
  const [boundaryRows, verifiedRows] = await Promise.all([
    tx.handoverStockBoundary.count({ where: { handoverId } }),
    tx.handoverStockBoundary.count({ where: { handoverId, verified: true } }),
  ]);
  // The unfinished outgoing count is closed as history, exactly as the
  // owner-approved cancel of an unfinished handover closes it (handover-cancel
  // step 5): LOCKED by this handover, figures untouched, pending corrections
  // rejected with the reason. Left open it would hold the branch's single
  // active-count slot forever, and the next shift could never count.
  let lockedUnfinishedCountSessionId: string | null = null;
  if (h.stockCountSessionId && session && session.status !== "LOCKED" && session.status !== "CONFIRMED") {
    const locked = await tx.stockCountSession.updateMany({
      where: { id: h.stockCountSessionId, status: { notIn: ["LOCKED", "CONFIRMED"] } },
      data: { status: "LOCKED", lockedAt: new Date(), lockedByHandoverId: handoverId },
    });
    if (locked.count > 0) lockedUnfinishedCountSessionId = h.stockCountSessionId;
    await tx.stockCountCorrection.updateMany({
      where: { line: { sessionId: h.stockCountSessionId }, status: "PENDING_APPROVAL" },
      data: { status: "REJECTED", rejectedReason: "التسليم اتستلم من غير جرد مُسلِّم مؤكد" },
    });
  }
  await auditInTransaction(tx, {
    cafeId: h.cafeId, userId: actorId, action: STOCK_HANDOVER_ACCEPTED_UNCOUNTED, entity: "HandoverSession", entityId: handoverId,
    details: {
      branchId: h.branchId, target: h.target, handoverStatus: h.status,
      outgoingCountSessionId: h.stockCountSessionId, outgoingCountStatus: session?.status ?? null,
      outgoingLines: session?.lines.length ?? 0,
      outgoingLinesObserved: session?.lines.filter((l) => hasAuthoritativeObservation(l)).length ?? 0,
      boundaryRows, verifiedBoundaryRows: verifiedRows, lockedUnfinishedCountSessionId,
    },
  });
  await notifyMissingCount(tx, handoverId, "OUTGOING", UNCOUNTED_BODY);
  return true;
}

/** Report a missing outgoing count — called by the outgoing finish and by acceptance. Never refuses. */
export async function reportOutgoingCountIfMissing(tx: Client, handoverId: string): Promise<number> {
  if (await outgoingCountRecorded(tx, handoverId)) return 0;
  return notifyMissingCount(tx, handoverId, "OUTGOING");
}

/**
 * The receiving shift is closing: any handover it received without its own
 * submitted count is reported as missing the incoming count. Never refuses.
 */
export async function reportIncomingCountsMissingForShift(tx: Client, shiftId: string): Promise<number> {
  const received = await tx.handoverSession.findMany({
    where: { incomingShiftId: shiftId, target: "SHIFT_TO_SHIFT", incomingStockCount: { is: null } },
    select: { id: true },
  });
  const unsubmitted = await tx.handoverSession.findMany({
    where: { incomingShiftId: shiftId, target: "SHIFT_TO_SHIFT", incomingStockCount: { is: { submittedAt: null } } },
    select: { id: true },
  });
  let notified = 0;
  for (const h of [...received, ...unsubmitted]) notified += await notifyMissingCount(tx, h.id, "INCOMING");
  return notified;
}
