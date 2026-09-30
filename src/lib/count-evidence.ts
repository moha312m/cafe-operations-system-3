// Which observation the business is acting on, and the cursor that belongs
// to it.
//
// A counted line can end up with more than one observation behind it. The
// first count is on `StockCountLine`. Each recount is its own
// `StockCountRecount` row. An approved `StockCountCorrection` supersedes a
// figure without anybody looking at the shelf again. All three are evidence,
// all three are kept, and exactly one of them is the thing to act on.
//
// THE PAIRING RULE, which is the whole reason this module exists:
//
//     the quantity and the ledger cursor must come from the SAME observation.
//
// The rebase target is `quantity + every movement above that cursor`. Take a
// recount's quantity with the first count's cursor and every movement between
// the two counts is replayed a second time — the recounter already saw them
// on the shelf, so the shop ends up holding stock it does not have and the
// next count reports a shortage nobody caused. Take the first quantity with
// the recount's cursor and those same movements vanish instead. Both halves
// are returned together here so a caller cannot take them apart.
//
// HOW THIS USED TO BE WRONG. `recordRecount` originally wrote the recount's
// count point over the line's — expectedQuantity, itemVersion, expectedBasis,
// countedAt, counterId — which produced correct rebase arithmetic by
// destroying the first count's provenance. The only surviving copy of the
// original cursor was the `ITEM_COUNTED` audit row, written through the
// best-effort `audit()` that swallows its own failures. Evidence whose
// durability depends on a log the system does not promise to write is not
// evidence. Now nothing overwrites the line, and this resolver does the
// pairing instead.
//
// PRECEDENCE. Latest physical observation first: a recount is somebody
// walking to the shelf and looking again, which supersedes both the first
// count and any correction of it. Then an approved correction, which changes
// the figure but not when it was observed — so it keeps the ORIGINAL cursor,
// because no new observation happened. Then the first count.
//
// A correction on a line a recount already superseded is refused upstream
// (`createCountCorrection`), because `StockCountCorrection` records which
// FIGURE it replaces but not which OBSERVATION, so there would be nothing
// able to say which cursor the corrected quantity belonged to. That refusal
// is what keeps the two upper branches here mutually exclusive.

import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/api";
import { round3 } from "@/lib/costing";

export type EffectiveEvidenceSource =
  | "ORIGINAL_COUNT"
  | "RECOUNT"
  | "APPROVED_CORRECTION";

export type EffectiveCountEvidence = {
  /** The physical figure to act on. */
  quantity: number;
  /** What was expected at this observation's own count point. */
  expectedQuantity: number;
  varianceQuantity: number;
  /** The cursor belonging to `quantity`. Movements above it are replayed. */
  itemVersion: bigint | null;
  expectedBasis: string | null;
  countedAt: Date | null;
  counterId: string | null;
  source: EffectiveEvidenceSource;
  /** Set when `source` is RECOUNT — which attempt is in force. */
  recountId: string | null;
  /** Set when `source` is APPROVED_CORRECTION. */
  correctionId: string | null;
};

/**
 * Everything the resolver reads, as a Prisma select.
 *
 * Exported so a caller loading many lines can fetch the evidence in one query
 * rather than one per line, and so the shape the pure function expects cannot
 * drift from the shape callers pass it.
 */
export const EFFECTIVE_EVIDENCE_SELECT = {
  id: true,
  countedQuantity: true,
  expectedQuantity: true,
  itemVersion: true,
  expectedBasis: true,
  countedAt: true,
  counterId: true,
  recounts: {
    orderBy: { attempt: "desc" },
    take: 1,
    select: {
      id: true,
      attempt: true,
      countedQuantity: true,
      expectedQuantity: true,
      varianceQuantity: true,
      itemVersion: true,
      countedAt: true,
      counterId: true,
      resolved: true,
    },
  },
  corrections: {
    where: { status: "APPROVED" as const },
    orderBy: { approvedAt: "desc" },
    take: 1,
    select: { id: true, newCountedQuantity: true, approvedAt: true },
  },
} satisfies Prisma.StockCountLineSelect;

export type LineWithEvidence = Prisma.StockCountLineGetPayload<{
  select: typeof EFFECTIVE_EVIDENCE_SELECT;
}>;

const num = (v: unknown): number => round3(Number(v));

/**
 * The evidence in force for one line, from an already-loaded row.
 *
 * Pure, so the precedence can be reasoned about and tested without a database
 * round trip. Deliberately does NOT read `effectiveCountedQuantity`: that
 * column is a denormalised mirror of this result, and a resolver that read it
 * could not be used to prove the mirror had not drifted.
 */
export function effectiveCountEvidence(line: LineWithEvidence): EffectiveCountEvidence {
  const recount = line.recounts[0];
  if (recount) {
    return {
      quantity: num(recount.countedQuantity),
      expectedQuantity: num(recount.expectedQuantity),
      varianceQuantity: num(recount.varianceQuantity),
      itemVersion: recount.itemVersion,
      // A recount takes the same kind of count point a first count does.
      expectedBasis: "LOCKED_ITEM_VERSION",
      countedAt: recount.countedAt,
      counterId: recount.counterId,
      source: "RECOUNT",
      recountId: recount.id,
      correctionId: null,
    };
  }

  const expected = line.expectedQuantity === null ? 0 : num(line.expectedQuantity);
  const correction = line.corrections[0];
  if (correction) {
    const quantity = num(correction.newCountedQuantity);
    return {
      quantity,
      expectedQuantity: expected,
      varianceQuantity: round3(quantity - expected),
      // The original cursor, on purpose: a correction changes the number
      // somebody wrote down, not the moment the shelf was looked at.
      itemVersion: line.itemVersion,
      expectedBasis: line.expectedBasis,
      countedAt: line.countedAt,
      counterId: line.counterId,
      source: "APPROVED_CORRECTION",
      recountId: null,
      correctionId: correction.id,
    };
  }

  const quantity = line.countedQuantity === null ? 0 : num(line.countedQuantity);
  return {
    quantity,
    expectedQuantity: expected,
    varianceQuantity: round3(quantity - expected),
    itemVersion: line.itemVersion,
    expectedBasis: line.expectedBasis,
    countedAt: line.countedAt,
    counterId: line.counterId,
    source: "ORIGINAL_COUNT",
    recountId: null,
    correctionId: null,
  };
}

/** Load one line's evidence and resolve it. */
export async function resolveEffectiveCountEvidence(
  lineId: string,
  client: Prisma.TransactionClient | typeof db = db
): Promise<EffectiveCountEvidence> {
  const line = await client.stockCountLine.findUnique({
    where: { id: lineId },
    select: EFFECTIVE_EVIDENCE_SELECT,
  });
  if (!line) throw new ApiError(404, "سطر الجرد غير موجود");
  return effectiveCountEvidence(line);
}

/**
 * Whether a later physical observation has superseded the first count.
 *
 * Used to refuse a correction that would have no unambiguous cursor.
 */
export function hasSupersedingRecount(line: { recounts: unknown[] }): boolean {
  return line.recounts.length > 0;
}

/**
 * Whether anybody physically observed this line, after precedence.
 *
 * The one question every consumer of a count line asks, asked once. A line
 * can exist without an observation: `startHandoverCount` creates one per item
 * in scope, and under a handover count somebody may never reach that shelf.
 * "In scope" and "observed" are different facts, and reading the first as the
 * second is how an unlooked-at shelf becomes a shortage somebody answers for.
 *
 * ANSWERED ON THE CURSOR, not on the quantity. `effectiveCountEvidence`
 * collapses an absent figure to 0 — it has to, because every arithmetic
 * consumer needs a number — so `quantity === 0` cannot tell "the shelf was
 * empty" from "nobody looked". The cursor is not collapsed: it is NULL until
 * an observation locks one, and `recordCountLine` and `recordRecount` each
 * write the figure and the cursor together inside one locked transaction. So
 * a resolved cursor means an observation happened, AND it means the pairing
 * rule at the top of this file can still be satisfied — which is the only
 * sense in which evidence is usable at all.
 *
 * A figure written with no cursor is therefore not an observation by this
 * rule. That state is unreachable through production capture and appears only
 * in malformed fixtures; the one caller that must tell it apart from a
 * genuinely untouched line — the boundary, which refuses it rather than
 * carrying it — reads the raw columns itself.
 */
export function hasAuthoritativeObservation(line: LineWithEvidence): boolean {
  return effectiveCountEvidence(line).itemVersion !== null;
}
