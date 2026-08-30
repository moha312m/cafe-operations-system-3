// What the processor says settled, against what the till says was taken.
//
// T34. T33 made the counted drawer a fact that has to be explained, and left
// the two channels that never reach a drawer unexamined: a shift could go
// CLOSED with 3,200 EGP sitting with an acquirer and 1,500 with a wallet
// provider, and nothing had ever asked either of them what came back. The
// money was recorded as collected and never checked against the party holding
// it.
//
// So the shift close becomes the financial close of the whole shift, and this
// module is the part of it that is not cash.
//
// ── THREE TENDERS, NEVER ONE ──
//
// The accounting rule is stated once per channel:
//
//   variance = ACTUAL SETTLEMENT − EXPECTED SETTLEMENT
//
// and the three results are never added together. A 20 EGP card shortfall
// beside a 30 EGP wallet surplus is two findings with two counterparties, two
// causes and two explanations — not a +10 EGP "settlement difference". Netting
// them would destroy the only information that makes either investigable, and
// would let a real shortfall hide behind an unrelated surplus. That is why
// each channel gets its own TenderReconciliation row, its own reason and its
// own VarianceCase, and why nothing here ever sums across methods.
//
// Cash is not in this module at all. It lives on `Shift`, exactly where T33
// left it, and this file neither reads nor writes those columns — see
// `lib/tender.ts` for why CASH has no channel here and MIXED is not a channel
// anywhere.
//
// ── EXPECTED IS NEVER TYPED IN ──
//
// `expectedAmount` comes from `recomputeShiftTotals`, the repository's single
// authoritative aggregate — the same function T33 reconciles cash against.
// `totalCardSales` and `totalWalletSales` are produced there by the same
// arithmetic that produces `expectedCashAmount`: PAID collections add, REFUND
// rows subtract, per method, and nothing else counts. A second formula written
// here would be a second opinion with nothing saying which an owner should
// believe, and a client-supplied expected figure would let the target be moved
// to meet the settlement.
//
// ── NO TOLERANCE ──
//
// As with cash: the ERP records the difference, the owner decides in their own
// books whether it was acceptable. Nothing here reads a tolerance rule, and
// `toleranceAmount`, `approvedById` and `approvedAt` stay NULL on every row
// this module writes. A 3,200 EGP shortfall closes exactly as a 20 EGP one
// does. The only thing a non-zero variance changes is that a reason becomes
// required — evidence, not a verdict.
//
// `status` is set to SUBMITTED and not APPROVED for the same reason. SUBMITTED
// says the figures were stated and by whom; APPROVED is a separate supervisory
// act, and a close that approved its own settlement would be signing off on
// itself.
//
// ── ZERO ACTIVITY IS NOT A ZERO SETTLEMENT ──
//
// A channel that took nothing needs no entry, and gets no row. Demanding a
// figure would make the closer type a number for a terminal that took none,
// and writing `actualAmount = 0` on their behalf would assert a provider
// report nobody read — the schema is explicit that NULL is not zero. But an
// affirmative zero, typed by somebody who looked, IS a settlement statement
// and is stored as one.
//
// Conversely a channel that DID take money cannot be skipped: that is the
// whole invariant, and it is enforced in `resolveTenderSettlement` before any
// write happens.

import type { Prisma } from "@prisma/client";
import { ApiError } from "@/lib/api";
import { auditInTransaction } from "@/lib/audit";
import { openVarianceCase } from "@/lib/variance-case";
import { ELECTRONIC_TENDER_METHODS, type ElectronicTenderMethod } from "@/lib/tender";

/** The column is Decimal(10,2); every comparison happens at that resolution. */
const round2 = (n: number) => Math.round(n * 100) / 100;

export const TENDER_DIFFERENCE_AUDIT_ACTION = "TENDER_DIFFERENCE_DETECTED";

/** How the ERP names the two directions. Neither is a verdict. */
export type TenderVarianceKind = "SHORTAGE" | "OVERAGE" | "EXACT";

/** What the closer is asked for, per channel. Both optional; see below. */
export type TenderSettlementInput = {
  /** The figure on the processor's settlement report. */
  actual?: number | null;
  /** Required when the variance is non-zero; ignored when it is zero. */
  reason?: string | null;
};

export type TenderSettlementInputs = Partial<
  Record<ElectronicTenderMethod, TenderSettlementInput>
>;

/** One channel, resolved and validated, ready to be written. */
export type ResolvedTenderSettlement = {
  method: ElectronicTenderMethod;
  expected: number;
  actual: number;
  variance: number;
  kind: TenderVarianceKind;
  reason: string | null;
};

/** What the caller needs back once a settlement has been persisted. */
export type PersistedTenderSettlement = ResolvedTenderSettlement & {
  reconciliationId: string;
  varianceCaseId: string | null;
};

/**
 * The accounting rule, in one place.
 *
 *   variance = ACTUAL SETTLEMENT − EXPECTED SETTLEMENT
 *
 * Negative is an under-settlement, positive an over-settlement, zero exact.
 * Both operands are rounded to the stored resolution BEFORE subtracting, so a
 * figure typed with sub-piastre noise cannot manufacture a variance the column
 * could not hold and nobody could explain. The same shape `cashVariance` uses,
 * deliberately: one rule, applied three times, never merged into one number.
 */
export function tenderVariance(actual: number, expected: number): number {
  return round2(round2(actual) - round2(expected));
}

export function tenderVarianceKind(variance: number): TenderVarianceKind {
  if (variance < 0) return "SHORTAGE";
  if (variance > 0) return "OVERAGE";
  return "EXACT";
}

/** How a refusal names the channel to the person closing the shift. */
const CHANNEL_LABEL: Record<ElectronicTenderMethod, string> = {
  CARD: "الكارت",
  WALLET: "المحفظة",
};

/**
 * Turn one channel's raw input into a settlement, or refuse it, or decide
 * there is nothing to reconcile.
 *
 * Returns `null` — and ONLY null — when the channel took nothing this shift
 * and the closer offered no figure. That is the zero-activity case: no record,
 * no case, no invented difference.
 *
 * Throws when the channel took money and no settlement was stated, and when a
 * non-zero variance arrives without a reason. Both run before any write, so a
 * close missing its evidence leaves the shift untouched rather than being
 * rolled back from halfway through.
 */
export function resolveTenderSettlement(
  method: ElectronicTenderMethod,
  expectedAmount: number,
  input: TenderSettlementInput | undefined
): ResolvedTenderSettlement | null {
  const expected = round2(expectedAmount);
  const supplied = input?.actual;

  if (supplied === undefined || supplied === null) {
    if (expected === 0) return null;
    throw new ApiError(
      400,
      `لازم تدخل مبلغ تسوية ${CHANNEL_LABEL[method]} قبل ما تقفل الشيفت`
    );
  }

  const actual = round2(supplied);
  const variance = tenderVariance(actual, expected);
  const trimmed = (input?.reason ?? "").trim();

  if (variance !== 0 && !trimmed) {
    throw new ApiError(
      400,
      `لازم تكتب سبب فرق تسوية ${CHANNEL_LABEL[method]} قبل ما تقفل الشيفت`
    );
  }

  return {
    method,
    expected,
    actual,
    variance,
    kind: tenderVarianceKind(variance),
    // Accepted if offered on an exact settlement, never required, never
    // invented — the treatment `resolveVarianceReason` gives cash.
    reason: trimmed || null,
  };
}

/**
 * Resolve every electronic channel for one shift.
 *
 * Iterating `ELECTRONIC_TENDER_METHODS` rather than the caller's keys is what
 * makes a channel impossible to skip by omission: a shift with card takings is
 * refused whether the request left `actualCardAmount` out or the UI forgot to
 * send it. The order is the constant's order, so the audit reads the same way
 * every time.
 */
export function resolveTenderSettlements(
  expected: Record<ElectronicTenderMethod, number>,
  inputs: TenderSettlementInputs
): ResolvedTenderSettlement[] {
  const resolved: ResolvedTenderSettlement[] = [];
  for (const method of ELECTRONIC_TENDER_METHODS) {
    const one = resolveTenderSettlement(method, expected[method], inputs[method]);
    if (one) resolved.push(one);
  }
  return resolved;
}

export type PersistArgs = {
  cafeId: string;
  branchId: string;
  shiftId: string;
  shiftNumber: number;
  actorId: string;
  settlements: ResolvedTenderSettlement[];
};

/**
 * Write the settlements, their cases and their audit rows — inside the
 * caller's transaction, never its own.
 *
 * This is the T34 half of the close's atomicity guarantee. The cash snapshot,
 * every settlement here, every case they raise and every audit row recording
 * them are ONE act: a card difference that could not be announced must leave
 * the drawer unclosed, because a shift marked CLOSED asserts that the whole
 * shift was settled. A partially reconciled close is the single outcome that
 * must be unreachable, which is why this function takes `tx` and could not
 * open one of its own.
 *
 * It runs AFTER the caller's status-guarded UPDATE, so a losing racer never
 * reaches it. `@@unique([shiftId, method])` is the database's own backstop
 * behind that.
 */
export async function persistTenderSettlements(
  tx: Prisma.TransactionClient,
  args: PersistArgs
): Promise<PersistedTenderSettlement[]> {
  const written: PersistedTenderSettlement[] = [];

  for (const s of args.settlements) {
    const row = await tx.tenderReconciliation.create({
      data: {
        cafeId: args.cafeId,
        branchId: args.branchId,
        shiftId: args.shiftId,
        method: s.method,
        expectedAmount: s.expected,
        actualAmount: s.actual,
        varianceAmount: s.variance,
        reasonNote: s.reason,
        // The figures were stated, by a named person, at a known time. They
        // were not approved — that is a separate act by somebody checking
        // this one, and a close that approved itself would check nothing.
        status: "SUBMITTED",
        submittedById: args.actorId,
        submittedAt: new Date(),
        // `toleranceAmount` is deliberately not written. See the header: the
        // ERP records the difference, it does not rule on it.
      },
      select: { id: true },
    });

    // A difference is evidence, so it becomes a case in the architecture that
    // already exists for evidence — sourced by the settlement itself, which
    // is `@unique`, so a retry collides instead of opening a twin. Zero opens
    // nothing: there is no finding to investigate, and a case per channel per
    // close would bury the real ones.
    let varianceCaseId: string | null = null;
    if (s.variance !== 0) {
      const opened = await openVarianceCase(tx, {
        cafeId: args.cafeId,
        branchId: args.branchId,
        type: "TENDER",
        shiftId: args.shiftId,
        source: { kind: "TENDER", tenderReconciliationId: row.id },
        // Signed, so the case says shortfall or surplus without a second
        // field — and so two channels' cases never look interchangeable.
        amountVariance: s.variance,
        // A settlement difference is money already. Unlike a stock variance
        // there is no cost to look up and nothing that can make the figure
        // unpriceable, so the impact is always available — and it is the
        // magnitude, because the direction is carried by `amountVariance`.
        financialImpact: { available: true, value: Math.abs(s.variance) },
        // A processor's settlement report states an exact amount that was or
        // was not received. It is a direct external statement, not a figure
        // derived from recipes, so it is verified in the same sense a counted
        // drawer is.
        confidence: "VERIFIED",
        openedById: args.actorId,
      });
      varianceCaseId = opened.caseId;

      await auditInTransaction(tx, {
        cafeId: args.cafeId,
        userId: args.actorId,
        action: TENDER_DIFFERENCE_AUDIT_ACTION,
        entity: "TenderReconciliation",
        entityId: row.id,
        details: {
          // `shiftId` and `branchId` travel with the event so a settlement
          // difference is answerable — which shift, which branch, which
          // channel — without joining back through the row it names.
          shiftId: args.shiftId,
          shiftNumber: args.shiftNumber,
          branchId: args.branchId,
          method: s.method,
          expected: s.expected,
          actual: s.actual,
          variance: s.variance,
          // `kind` names the direction. It is not a classification of whether
          // the difference was acceptable — that judgement is the owner's.
          kind: s.kind,
          reason: s.reason,
          varianceCaseId,
        },
      });
    }

    written.push({ ...s, reconciliationId: row.id, varianceCaseId });
  }

  return written;
}
