// Who a stock difference may be pinned on — and when nobody may be.
//
// Corrections #3 and #4. Two separate failures, one module.
//
// #4 is the deferral. A count taken FOR a handover is a proposal, not
// evidence: nobody has accepted that the figure is right. Opening variance
// cases at confirmation would mean a shortage is investigated, and a custody
// named on it, before anyone agreed the count was correct. So the deferral
// lives in `confirmCountSession` and the writer lives here, called by the
// acceptance transaction (SH-20/21/22) and by nothing else.
//
// #3 is the attribution. Between two counts a shelf can cross boundaries
// nobody stood in front of, or change hands entirely. The figure at the end
// is real; the custody it would name is an accident of who happened to be
// counting. `PERIOD_UNRESOLVED` says exactly that, carries a NULL custody so
// there is no name to read by mistake, and records the boundaries it did
// cross in a companion row instead.
//
// THE RULE IS PURE. `classifyStockVariance` takes no database, because the
// thing being decided is a judgement about evidence, and a judgement you can
// only exercise by building six handovers is a judgement nobody will
// exercise. The database work is gathering its input, and that is a separate
// function.
//
// NO TOLERANCE IN THE ACCEPTED WRITER. Its predicate is `variance !== 0` on
// the accepted evidence, and `StockCountLine.disposition` is deliberately not
// read: a difference the generic tolerance called acceptable is still a
// difference somebody physically observed, and handover accountability
// records it.

import type { CustodyHolderType, Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/api";
import { EFFECTIVE_EVIDENCE_SELECT, effectiveCountEvidence } from "@/lib/count-evidence";
import { openVarianceCase } from "@/lib/variance-case";

export type AttributionInput = {
  branchId: string;
  inventoryItemId: string;
  /// The accepted count, by construction — acceptance is what makes it one.
  closingBoundaryVerified: true;
  closingCustodyPeriodId: string | null;
  closingCustodyHolderType: CustodyHolderType | null;
  /**
   * The last VERIFIED accepted boundary before the closing evidence. A
   * carried figure is not an observation, so it does not start a span; the
   * `verified` flag is still carried because the classifier is pure and must
   * give the right answer on input that says otherwise.
   */
  openingBoundary: {
    boundaryId: string;
    verified: boolean;
    acceptedAt: Date;
    custodyPeriodId: string | null;
  } | null;
  interveningUnverifiedBoundaryCount: number;
  /**
   * Every STOCK custody the interval crossed, gathered by the resolver. Left
   * out, the classifier names the two custodies its own input reveals — which
   * is what a synthetic caller can honestly know.
   */
  crossedCustodyPeriodIds?: string[];
};

export type AttributionVerdict =
  | { attribution: "VERIFIED_SHIFT"; custodyPeriodId: string; span: null }
  | { attribution: "BRANCH_CUSTODY"; custodyPeriodId: string; span: null }
  | {
      attribution: "PERIOD_UNRESOLVED";
      custodyPeriodId: null;
      span: {
        fromBoundaryId: string | null;
        fromVerifiedAt: Date | null;
        unverifiedBoundaryCount: number;
        custodyPeriodIds: string[];
      };
    };

const dedupe = (ids: Array<string | null | undefined>): string[] =>
  [...new Set(ids.filter((id): id is string => typeof id === "string" && id.length > 0))];

/**
 * The attribution rule, stated once (Requirements 12, 13, 7).
 *
 * Pure. No database, so the rule is testable on synthetic input.
 */
export function classifyStockVariance(input: AttributionInput): AttributionVerdict {
  const opening = input.openingBoundary;
  const verifiedOpening = opening && opening.verified ? opening : null;

  const unresolved = (): AttributionVerdict => ({
    attribution: "PERIOD_UNRESOLVED",
    custodyPeriodId: null,
    span: {
      // The span starts at the last VERIFIED point. An unverified opening is
      // a figure nobody observed, so it is not where the evidence begins.
      fromBoundaryId: verifiedOpening?.boundaryId ?? null,
      fromVerifiedAt: verifiedOpening?.acceptedAt ?? null,
      unverifiedBoundaryCount: input.interveningUnverifiedBoundaryCount,
      custodyPeriodIds:
        input.crossedCustodyPeriodIds !== undefined
          ? dedupe(input.crossedCustodyPeriodIds)
          : dedupe([opening?.custodyPeriodId, input.closingCustodyPeriodId]),
    },
  });

  // Never counted before. "No opening figure" is not "an opening of zero".
  if (!opening) return unresolved();
  // Carried, not observed.
  if (!opening.verified) return unresolved();
  // Somewhere in between, a boundary nobody stood in front of.
  if (input.interveningUnverifiedBoundaryCount > 0) return unresolved();
  // The stock changed hands. A custody answers for what it held, not for what
  // it inherited unexamined.
  if (opening.custodyPeriodId !== input.closingCustodyPeriodId) return unresolved();
  // And a difference found against no custody at all can be pinned on nothing
  // — which is the same verdict, reached from the other direction.
  if (input.closingCustodyPeriodId === null) return unresolved();

  if (input.closingCustodyHolderType === "BRANCH") {
    return {
      attribution: "BRANCH_CUSTODY",
      custodyPeriodId: input.closingCustodyPeriodId,
      span: null,
    };
  }
  return {
    attribution: "VERIFIED_SHIFT",
    custodyPeriodId: input.closingCustodyPeriodId,
    span: null,
  };
}

/** Only a COMPLETED handover leaves a boundary anybody accepted. */
const acceptedBefore = (branchId: string, at: Date) => ({
  branchId,
  status: "COMPLETED" as const,
  // Strictly before: the acceptance being written right now is the closing
  // evidence, not part of the span it measures.
  acceptedAt: { lt: at },
});

/**
 * Gathers the input for one item at one branch, then classifies.
 *
 * Reads outside any caller's transaction, exactly as `lastAcceptedBoundary`
 * does: what it needs is the settled history of completed handovers, and the
 * acceptance in flight is deliberately not part of that.
 */
export async function resolveVarianceAttribution(args: {
  branchId: string;
  inventoryItemId: string;
  countedAt: Date;
  custodyPeriodId: string | null;
}): Promise<AttributionVerdict> {
  const closingCustody = args.custodyPeriodId
    ? await db.custodyPeriod.findUnique({
        where: { id: args.custodyPeriodId },
        select: { id: true, holderType: true },
      })
    : null;

  const opening = await db.handoverStockBoundary.findFirst({
    where: {
      inventoryItemId: args.inventoryItemId,
      verified: true,
      handover: acceptedBefore(args.branchId, args.countedAt),
    },
    select: {
      id: true,
      verified: true,
      handover: { select: { acceptedAt: true, outgoingStockCustodyId: true } },
    },
    orderBy: { handover: { acceptedAt: "desc" } },
  });
  const openingAcceptedAt = opening?.handover.acceptedAt ?? null;

  // Everything the item crossed since that observation. With no observation at
  // all the whole accepted history is the interval, which is the honest
  // reading of "we have never seen this shelf".
  const since = openingAcceptedAt
    ? { gt: openingAcceptedAt, lt: args.countedAt }
    : { lt: args.countedAt };
  const crossed = await db.handoverStockBoundary.findMany({
    where: {
      inventoryItemId: args.inventoryItemId,
      handover: { ...acceptedBefore(args.branchId, args.countedAt), acceptedAt: since },
    },
    select: {
      verified: true,
      // STOCK custody only. A cash custody has no business in a stock span.
      handover: { select: { outgoingStockCustodyId: true } },
    },
  });

  return classifyStockVariance({
    branchId: args.branchId,
    inventoryItemId: args.inventoryItemId,
    closingBoundaryVerified: true,
    closingCustodyPeriodId: closingCustody?.id ?? null,
    closingCustodyHolderType: closingCustody?.holderType ?? null,
    openingBoundary:
      opening && openingAcceptedAt
        ? {
            boundaryId: opening.id,
            verified: opening.verified,
            acceptedAt: openingAcceptedAt,
            custodyPeriodId: opening.handover.outgoingStockCustodyId,
          }
        : null,
    interveningUnverifiedBoundaryCount: crossed.filter((b) => !b.verified).length,
    crossedCustodyPeriodIds: dedupe([
      opening?.handover.outgoingStockCustodyId,
      ...crossed.map((b) => b.handover.outgoingStockCustodyId),
      closingCustody?.id,
    ]),
  });
}

/**
 * The companion row for a difference no single custody answers for.
 *
 * One per case — `varianceCaseId` is unique — and every custody the span
 * crossed is a joinable row rather than a JSON array, because the dashboard's
 * responsible-shift summary has to be a bounded aggregate query.
 */
export async function persistVarianceSpan(
  tx: Prisma.TransactionClient,
  args: {
    varianceCaseId: string;
    inventoryItemId: string;
    toBoundaryId: string | null;
    toVerifiedAt: Date;
    verdict: Extract<AttributionVerdict, { attribution: "PERIOD_UNRESOLVED" }>;
  }
): Promise<{ spanId: string }> {
  if (!args.toBoundaryId) {
    // The closing boundary IS the evidence that found the gap. A span without
    // one would be a record of nothing.
    throw new ApiError(400, "الفرق لازم يكون له حد إقفال — a span needs a closing boundary");
  }

  const existing = await tx.stockVarianceSpan.findUnique({
    where: { varianceCaseId: args.varianceCaseId },
    select: { id: true },
  });
  if (existing) return { spanId: existing.id };

  const span = await tx.stockVarianceSpan.create({
    data: {
      varianceCaseId: args.varianceCaseId,
      inventoryItemId: args.inventoryItemId,
      fromBoundaryId: args.verdict.span.fromBoundaryId,
      fromVerifiedAt: args.verdict.span.fromVerifiedAt,
      toBoundaryId: args.toBoundaryId,
      toVerifiedAt: args.toVerifiedAt,
      unverifiedBoundaryCount: args.verdict.span.unverifiedBoundaryCount,
      custodyLinks: {
        createMany: {
          data: args.verdict.span.custodyPeriodIds.map((custodyPeriodId) => ({
            custodyPeriodId,
          })),
        },
      },
    },
    select: { id: true },
  });
  return { spanId: span.id };
}

const ACCEPTED_LINE_SELECT = {
  ...EFFECTIVE_EVIDENCE_SELECT,
  inventoryItemId: true,
  confidence: true,
  costImpact: true,
  costImpactAvailable: true,
  costUnavailableReason: true,
} satisfies Prisma.StockCountLineSelect;

/**
 * The final accountability record for one accepted handover. Called ONLY by
 * the accept transaction (SH-20/21/22), never by a count.
 *
 * NO TOLERANCE: the predicate is `variance !== 0` on the accepted evidence.
 * `StockCountLine.disposition` is deliberately not read here — a difference
 * the generic tolerance called acceptable is still a difference somebody
 * physically observed, and Handover Accountability records it.
 *
 * Idempotent by the same construction the count path uses: one case per
 * `stockCountLineId`, which is unique, so a second acceptance of the same
 * evidence reads the first one's rows instead of doubling the investigation.
 */
export async function openHandoverVarianceCases(
  tx: Prisma.TransactionClient,
  args: {
    cafeId: string;
    branchId: string;
    handoverId: string;
    acceptedSessionId: string;
    outgoingCustodyPeriodId: string | null;
    boundaryByItemId: Map<string, string>;
    openedById: string;
  }
): Promise<{ caseIds: string[]; spanIds: string[]; skippedZeroVariance: number }> {
  const handover = await tx.handoverSession.findUnique({
    where: { id: args.handoverId },
    select: { id: true, cafeId: true, branchId: true, acceptedAt: true, outgoingShiftId: true },
  });
  if (!handover || handover.cafeId !== args.cafeId || handover.branchId !== args.branchId) {
    throw new ApiError(404, "التسليم غير موجود");
  }
  // Acceptance is the instant the closing boundary became verified evidence.
  const toVerifiedAt = handover.acceptedAt ?? new Date();

  const lines = await tx.stockCountLine.findMany({
    where: { sessionId: args.acceptedSessionId },
    select: ACCEPTED_LINE_SELECT,
    orderBy: { id: "asc" },
  });

  const caseIds: string[] = [];
  const spanIds: string[] = [];
  let skippedZeroVariance = 0;

  for (const line of lines) {
    const variance = effectiveCountEvidence(line).varianceQuantity;
    if (variance === 0) {
      skippedZeroVariance += 1;
      continue;
    }

    const verdict = await resolveVarianceAttribution({
      branchId: args.branchId,
      inventoryItemId: line.inventoryItemId,
      countedAt: toVerifiedAt,
      custodyPeriodId: args.outgoingCustodyPeriodId,
    });

    const impact = line.costImpactAvailable
      ? ({ available: true, value: Number(line.costImpact) } as const)
      : ({
          available: false,
          reason:
            (line.costUnavailableReason as
              | "MISSING_COST"
              | "UNTRUSTED_COST"
              | "CONFIDENCE_NOT_VERIFIED") ?? "MISSING_COST",
        } as const);

    const { caseId } = await openVarianceCase(tx, {
      cafeId: args.cafeId,
      branchId: args.branchId,
      type: "STOCK",
      // Contextual, and only where it is true. An unresolved span must not
      // carry the outgoing shift either: a reader who found one there would
      // read it as the answer this whole module refuses to give.
      shiftId: verdict.attribution === "VERIFIED_SHIFT" ? handover.outgoingShiftId : null,
      custodyPeriodId: verdict.custodyPeriodId,
      source: { kind: "STOCK_LINE", stockCountLineId: line.id },
      quantityVariance: variance,
      amountVariance: impact.available ? impact.value : null,
      financialImpact: impact,
      confidence: line.confidence,
      attribution: verdict.attribution,
      acceptedHandoverId: args.handoverId,
      openedById: args.openedById,
    });
    caseIds.push(caseId);

    if (verdict.attribution === "PERIOD_UNRESOLVED") {
      const { spanId } = await persistVarianceSpan(tx, {
        varianceCaseId: caseId,
        inventoryItemId: line.inventoryItemId,
        toBoundaryId: args.boundaryByItemId.get(line.inventoryItemId) ?? null,
        toVerifiedAt,
        verdict,
      });
      spanIds.push(spanId);
    }
  }

  return { caseIds, spanIds, skippedZeroVariance };
}
