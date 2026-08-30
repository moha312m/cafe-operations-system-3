// The drawer count becomes a fact, and its evidence commits with it.
//
// T33. Three properties live here that the route could not give on its own.
//
// ── ONE ACT ──
//
// Closing a shift with a non-zero variance is not one write plus some notes
// about it. It is: freshen the aggregates, write the close snapshot, open the
// CASH variance case, link it to the shift, and write both audit rows. The
// close path used to do those through `db` and `audit` — separate implicit
// transactions, in an order where the later ones were allowed to disappear,
// because `audit` swallows. A café whose AuditLog insert failed got a shift
// that had gone CLOSED 300 EGP short with nothing recording who accepted the
// count or what the figures were.
//
// That is not a missing log line. The close is the moment a named custodian is
// discharged of money they were holding, and the audit row plus the case ARE
// the record of that discharge. Once responsibility is assigned on the case, a
// close nobody can reconstruct is an accusation with its evidence deleted.
//
// So everything runs on one `Prisma.TransactionClient`, through
// `auditInTransaction`, which throws where `audit` swallows, and
// `openVarianceCase`, which was already built to take the caller's client for
// exactly this reason. Either all of it lands or none of it does.
//
// ── ONE WINNER ──
//
// Two cashiers, or a cashier and a manager, can press Close at the same
// instant. The old path read the status, saw OPEN in both requests, and wrote
// twice — the surviving snapshot was whichever write happened to be last, and
// the shift carried a counted figure that could not be attributed to anybody's
// decision. Five concurrent closes produced five 200s.
//
// The fix is a row lock taken before the status is read, plus a status-guarded
// UPDATE, and both are needed. `SELECT … FOR UPDATE` serialises the attempts;
// the `status: "OPEN"` in the update's WHERE is what makes the loser's write
// affect zero rows instead of overwriting a completed close, on the read
// committed isolation Postgres gives us by default. The loser then sees the
// ordinary "already closed" refusal, which is the existing convention for a
// second close and needs no new status code.
//
// ── NO TOLERANCE ──
//
// The ERP records the factual variance. It does not decide whether that
// variance was acceptable — the café owner does that in their own books,
// against their own accounting principles.
//
// So nothing here reads `resolveCashTolerance`, and nothing writes
// `Shift.cashWithinTolerance` or `Shift.cashToleranceAmount`. Those columns
// arrived with T16 and stay NULL on every close this module performs. A large
// variance is not treated differently from a small one: 5,000 EGP short closes
// exactly as 30 EGP short does, because size is a fact about the difference,
// not a verdict on it. The only thing a non-zero variance changes is that a
// reason becomes required — and that is a demand for evidence, not a judgement.
//
// What this module deliberately does NOT do: touch sales, payments or expected
// cash to make a variance smaller. The variance is the finding. Reconciling it
// away by rewriting the takings is the failure the whole feature exists to
// make impossible.

import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/api";
import { auditInTransaction } from "@/lib/audit";
import { openVarianceCase } from "@/lib/variance-case";
import { recomputeShiftTotals } from "@/lib/shifts";

/** The column is Decimal(10,2); every comparison happens at that resolution. */
const round2 = (n: number) => Math.round(n * 100) / 100;

export const SHIFT_CLOSED_AUDIT_ACTION = "SHIFT_CLOSED";
export const CASH_DIFFERENCE_AUDIT_ACTION = "CASH_DIFFERENCE_DETECTED";

/** How the ERP names the two directions. Neither is a verdict. */
export type CashVarianceKind = "SHORTAGE" | "OVERAGE" | "EXACT";

/**
 * The accounting rule, in one place.
 *
 *   variance = ACTUAL CASH COUNTED − EXPECTED CASH
 *
 * Negative is a shortage, positive an overage, zero exact. Both operands are
 * rounded to the stored resolution BEFORE subtracting, so a count typed with
 * sub-piastre noise cannot manufacture a variance the column could not hold
 * and nobody could explain.
 */
export function cashVariance(actualCash: number, expectedCash: number): number {
  return round2(round2(actualCash) - round2(expectedCash));
}

export function varianceKind(variance: number): CashVarianceKind {
  if (variance < 0) return "SHORTAGE";
  if (variance > 0) return "OVERAGE";
  return "EXACT";
}

/**
 * The reason rule.
 *
 * Required when, and only when, the variance is non-zero. A zero variance must
 * NOT demand one: there is nothing to explain, and forcing the field would
 * only teach cashiers to type "No variance" into an evidence column.
 *
 * Whitespace is not an explanation, so the value is trimmed before it is
 * judged and the trimmed form is what gets stored — the same treatment
 * `refundOrder` gives the reason it requires.
 */
export function resolveVarianceReason(
  variance: number,
  reason: string | null | undefined
): string | null {
  const trimmed = (reason ?? "").trim();
  if (variance === 0) {
    // Accepted if offered, never required, never invented.
    return trimmed || null;
  }
  if (!trimmed) {
    throw new ApiError(400, "لازم تكتب سبب فرق الكاش قبل ما تقفل الشيفت");
  }
  return trimmed;
}

export type CashCloseArgs = {
  shiftId: string;
  /** The physically counted drawer. */
  actualCash: number;
  /** Required when the variance is non-zero; ignored when it is zero. */
  reason?: string | null;
  /** Free-text shift note, unrelated to the variance reason. */
  notes?: string | null;
  actorId: string;
  /** True when the closer is not the custodian — recorded, never blocked. */
  closedByManager: boolean;
};

export type CashCloseResult = {
  shiftId: string;
  expectedCash: number;
  actualCash: number;
  cashVariance: number;
  kind: CashVarianceKind;
  reason: string | null;
  varianceCaseId: string | null;
};

/**
 * Lock the shift row for the duration of the transaction.
 *
 * Returns nothing but the fact that the row exists: the caller re-reads
 * through Prisma once the lock is held, so the status it validates is the
 * status it is about to update rather than one read a moment earlier that a
 * concurrent close may already have changed. The same shape `lockItemForUpdate`
 * uses for stock, and for the same reason.
 */
async function lockShift(tx: Prisma.TransactionClient, shiftId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "Shift" WHERE "id" = ${shiftId} FOR UPDATE
  `;
  return rows.length > 0;
}

/**
 * Close a shift against a counted drawer, atomically.
 *
 * Authorization and tenancy are the ROUTE's job and have already happened by
 * the time this runs — this function is the financial act, and it assumes the
 * actor was allowed to perform it. What it does not assume is that the shift is
 * still open, which is why the status is re-read under the lock.
 */
export async function closeShiftWithCashCount(
  args: CashCloseArgs
): Promise<CashCloseResult> {
  return db.$transaction(async (tx) => {
    if (!(await lockShift(tx, args.shiftId))) {
      throw new ApiError(404, "الشيفت مش موجود");
    }

    const locked = await tx.shift.findUniqueOrThrow({
      where: { id: args.shiftId },
      select: { id: true, cafeId: true, branchId: true, shiftNumber: true, status: true },
    });
    if (locked.status === "CLOSED") {
      throw new ApiError(400, "الشيفت مقفول بالفعل");
    }

    // The authoritative figure, freshened inside this transaction so a
    // rollback takes the recomputed aggregates with it.
    const fresh = await recomputeShiftTotals(args.shiftId, tx);
    if (!fresh) throw new ApiError(404, "الشيفت مش موجود");

    const expectedCash = round2(Number(fresh.expectedCashAmount));
    const actualCash = round2(args.actualCash);
    const variance = cashVariance(actualCash, expectedCash);
    const kind = varianceKind(variance);

    // Before any write: a close missing its required evidence must leave the
    // shift untouched rather than be rolled back from halfway through.
    const reason = resolveVarianceReason(variance, args.reason);

    // Status-guarded, so a racing second close updates zero rows rather than
    // overwriting the first completed one. The lock above makes this the
    // decisive check rather than a hopeful one.
    const written = await tx.shift.updateMany({
      where: { id: args.shiftId, status: "OPEN" },
      data: {
        actualCashAmount: actualCash,
        cashDifference: variance,
        cashReasonNote: reason,
        // Only when offered. Prisma reads `undefined` as "leave alone", and
        // writing an explicit null instead would let a close that mentioned no
        // note erase one the shift was already carrying.
        ...(args.notes === undefined ? {} : { notes: args.notes }),
        closedById: args.actorId,
        closedAt: new Date(),
        status: "CLOSED",
        // `cashWithinTolerance` and `cashToleranceAmount` are deliberately not
        // written. See the header: the ERP records the difference, it does not
        // rule on it.
      },
    });
    if (written.count !== 1) {
      throw new ApiError(400, "الشيفت مقفول بالفعل");
    }

    // A difference is evidence, so it becomes a case in the architecture that
    // already exists for evidence. Zero opens nothing — there is no finding to
    // investigate, and a case per close would bury the real ones.
    let varianceCaseId: string | null = null;
    if (variance !== 0) {
      const opened = await openVarianceCase(tx, {
        cafeId: locked.cafeId,
        branchId: locked.branchId,
        type: "CASH",
        shiftId: locked.id,
        source: { kind: "CASH_SHIFT" },
        // Signed, so the case says shortage or overage without a second field.
        amountVariance: variance,
        // Cash is money already. Unlike a stock variance, there is no cost to
        // look up and nothing that can make the figure unpriceable, so the
        // impact is always available — and it is the magnitude, because the
        // direction is already carried by `amountVariance`.
        financialImpact: { available: true, value: Math.abs(variance) },
        // A counted drawer is direct physical evidence of an exact amount, not
        // a theoretical figure derived from recipes. This is the one variance
        // type whose number is never an estimate.
        confidence: "VERIFIED",
        openedById: args.actorId,
      });
      varianceCaseId = opened.caseId;

      await tx.shift.update({
        where: { id: args.shiftId },
        data: { cashVarianceCaseId: varianceCaseId },
      });
    }

    const evidence = {
      branchId: locked.branchId,
      shiftId: locked.id,
      shiftNumber: locked.shiftNumber,
      expectedCash,
      actualCash,
      cashDifference: variance,
      reason,
    };

    await auditInTransaction(tx, {
      cafeId: locked.cafeId,
      userId: args.actorId,
      action: SHIFT_CLOSED_AUDIT_ACTION,
      entity: "Shift",
      entityId: locked.id,
      details: { ...evidence, closedByManager: args.closedByManager, varianceCaseId },
    });

    if (variance !== 0) {
      await auditInTransaction(tx, {
        cafeId: locked.cafeId,
        userId: args.actorId,
        action: CASH_DIFFERENCE_AUDIT_ACTION,
        entity: "Shift",
        entityId: locked.id,
        // `kind` names the direction. It is not a classification of whether
        // the difference was acceptable — that judgement is the owner's, and
        // this system does not hold an opinion on it.
        details: { ...evidence, kind, varianceCaseId },
      });
    }

    return {
      shiftId: locked.id,
      expectedCash,
      actualCash,
      cashVariance: variance,
      kind,
      reason,
      varianceCaseId,
    };
  });
}
