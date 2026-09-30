// The shift's money becomes a fact, and its evidence commits with it.
//
// T33 for cash, extended by T34 to the channels that never reach a drawer.
// Three properties live here that the route could not give on its own.
//
// ── ONE ACT ──
//
// Closing a shift with a non-zero variance is not one write plus some notes
// about it. It is: freshen the aggregates, write the close snapshot, open the
// CASH variance case, link it to the shift, write every processor settlement
// with the cases and audit rows those raise, and write both cash audit rows.
// The close path used to do those through `db` and `audit` — separate implicit
// transactions, in an order where the later ones were allowed to disappear,
// because `audit` swallows. A café whose AuditLog insert failed got a shift
// that had gone CLOSED 300 EGP short with nothing recording who accepted the
// count or what the figures were.
//
// T34 widens that invariant rather than adding a second one beside it. The
// card and wallet settlements join THIS transaction (see
// `lib/tender-settlement`), so a card difference that cannot be announced
// leaves the drawer unclosed — a shift marked CLOSED asserts that the whole
// shift was settled, and a partially reconciled close is a worse record than
// no reconciliation at all.
//
// The three tenders are accounted separately and never netted: cash on
// `Shift`, card and wallet on their own `TenderReconciliation` rows, each with
// its own reason and its own case. A −20 card shortfall beside a +30 wallet
// surplus is two findings with two counterparties, not a +10 anything.
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

import type { HandoverTarget, Prisma, ShiftStatus } from "@prisma/client";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/api";
import { auditInTransaction } from "@/lib/audit";
import { openVarianceCase } from "@/lib/variance-case";
import { recomputeShiftTotals } from "@/lib/shifts";
import {
  persistTenderSettlements,
  resolveTenderSettlements,
  type PersistedTenderSettlement,
  type TenderSettlementInputs,
} from "@/lib/tender-settlement";
import { handoverStartBlockers } from "@/lib/handover-blockers";
import {
  resolveBranchHandoverConfigReadOnly,
  type HandoverConfigError,
} from "@/lib/handover-config";
import { acquireInventoryExclusiveLock } from "@/lib/inventory-freeze";
import {
  createHandoverInClose,
  finalizeCashCustodyAtFinancialClose,
  HandoverBlockedError,
  type CashCustodyFinalization,
} from "@/lib/handover";

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

/** The two handover capabilities a close may need, resolved by the route. */
export type CloseHandoverGrants = {
  /** `handover.submit` — may hand the branch's stock to the next shift. */
  handoverSubmit: boolean;
  /** `handover.exception` — may end employee stock custody entirely. */
  handoverException: boolean;
};

export type ShiftCloseArgs = {
  shiftId: string;
  /** The physically counted drawer. */
  actualCash: number;
  /** Required when the cash variance is non-zero; ignored when it is zero. */
  reason?: string | null;
  /**
   * The electronic channels, each with what the processor settled and why it
   * differed. Keyed by method rather than flattened into `actualCardAmount` /
   * `actualWalletAmount` pairs, so adding a channel is a change to
   * `ELECTRONIC_TENDER_METHODS` and not to four call sites.
   */
  tenders?: TenderSettlementInputs;
  /** Free-text shift note, unrelated to any variance reason. */
  notes?: string | null;
  actorId: string;
  /** True when the closer is not the custodian — recorded, never blocked. */
  closedByManager: boolean;
  /**
   * Where the stock this shift held is going. Required when, and only
   * when, the branch's effective policy requires a handover — a café that
   * does not count at handover must not be made to answer a question about
   * one.
   *
   * It is INTENT, stated by whoever pressed Close, and nothing here derives
   * it: no clock, no count of open shifts, no readiness check, no query
   * asking whether this is the day's last handover. A reconstruction would
   * be this system guessing at responsibility, and responsibility is the
   * one thing it is not allowed to guess at.
   */
  handoverTarget?: HandoverTarget | null;
  /**
   * What the ROUTE established this actor may do, resolved before the
   * transaction opened.
   *
   * Authorization is the route's job and always was. It is passed in rather
   * than re-read here because whether a handover is required at all is only
   * settled INSIDE this transaction, under the shift lock — so the route
   * cannot know in advance which permission to demand, and this function
   * has no session to ask. Absent grants DENY: a caller that established
   * nothing gets a handover-free close or a refusal, never an unchecked
   * handover.
   */
  grants?: CloseHandoverGrants;
};

export type ShiftCloseResult = {
  shiftId: string;
  expectedCash: number;
  actualCash: number;
  cashVariance: number;
  kind: CashVarianceKind;
  reason: string | null;
  varianceCaseId: string | null;
  /**
   * One entry per channel actually reconciled. A channel with no activity
   * that nobody settled is absent rather than present-and-zero, because
   * "nothing happened here" and "the provider reported zero" are different
   * facts and the schema keeps them apart.
   */
  tenders: PersistedTenderSettlement[];
  /**
   * `CLOSED`, or `AWAITING_HANDOVER` when the money is settled and the
   * shelf is frozen but the stock has still to change hands.
   */
  status: ShiftStatus;
  handoverRequired: boolean;
  handoverTarget: HandoverTarget | null;
  handoverId: string | null;
  freezeId: string | null;
  requiredItemCount: number | null;
  /**
   * A configuration this feature cannot serve, recorded rather than thrown.
   * Today that is `CYCLE` alone: the café keeps closing shifts exactly as it
   * does now and simply does not get handovers until an owner changes the
   * policy themselves.
   */
  handoverConfigIssue: HandoverConfigError | null;
  /** The CASH discharge a BRANCH_CUSTODY close performed, if it performed one. */
  cashCustodyFinalization: CashCustodyFinalization | null;
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
 * Close a shift against a counted drawer and its processor settlements,
 * atomically.
 *
 * Authorization and tenancy are the ROUTE's job and have already happened by
 * the time this runs — this function is the financial act, and it assumes the
 * actor was allowed to perform it. What it does not assume is that the shift is
 * still open, which is why the status is re-read under the lock.
 */
export async function closeShiftWithSettlement(
  args: ShiftCloseArgs
): Promise<ShiftCloseResult> {
  const grants = args.grants ?? {
    handoverSubmit: false,
    handoverException: false,
  };

  return db.$transaction(async (tx) => {
    if (!(await lockShift(tx, args.shiftId))) {
      throw new ApiError(404, "الشيفت مش موجود");
    }

    const locked = await tx.shift.findUniqueOrThrow({
      where: { id: args.shiftId },
      select: {
        id: true,
        cafeId: true,
        branchId: true,
        cashierId: true,
        shiftNumber: true,
        status: true,
      },
    });
    // AWAITING_HANDOVER is refused as firmly as CLOSED: its money is settled
    // and its snapshot is history, and a second close would rewrite both.
    if (locked.status !== "OPEN") {
      throw new ApiError(400, "الشيفت مقفول بالفعل");
    }

    // ── Does this branch owe a handover, and where is the stock going? ──
    //
    // Resolved from the effective configuration inside this transaction, not
    // from anything the caller asserted. `enabled` is the policy question
    // (NO_SHIFT_COUNT closes as it always has); CYCLE is enabled but has no
    // engine behind it, so it is recorded and stepped around rather than
    // thrown — a café must not discover at 2 a.m., with a counted drawer in
    // hand, that it cannot close a shift at all.
    //
    // Every OTHER configuration error stays a blocker below, where it was.
    // Suppressing those would be silently closing over a broken setup.
    const config = await resolveBranchHandoverConfigReadOnly(
      tx,
      locked.cafeId,
      locked.branchId
    );
    const cycleIssue =
      config.enabled && config.configError?.code === "CYCLE_POLICY_UNSUPPORTED"
        ? config.configError
        : null;
    const handoverRequired = config.enabled && cycleIssue === null;

    let target: HandoverTarget | null = null;
    if (handoverRequired) {
      const stated = args.handoverTarget ?? null;
      if (stated !== "SHIFT_TO_SHIFT" && stated !== "BRANCH_CUSTODY") {
        throw new ApiError(
          400,
          "لازم تحدد وجهة تسليم العهدة: SHIFT_TO_SHIFT أو BRANCH_CUSTODY"
        );
      }
      target = stated;

      // Authorization, before the lock and long before any write. Handing
      // stock to the next shift is an ordinary custodial act; ENDING employee
      // stock custody is not, and it takes the manager capability on top.
      if (!grants.handoverSubmit) {
        throw new ApiError(403, "مش مسموح لك تسلّم عهدة المخزن");
      }
      if (target === "BRANCH_CUSTODY" && !grants.handoverException) {
        throw new ApiError(403, "تسليم عهدة الفرع محتاج موافقة مدير");
      }

      // The EXCLUSIVE branch inventory lock, BEFORE the blockers are read.
      //
      // Every ordinary stock mutator holds the SHARED form until its own
      // commit, so this waits for all of them; every later one waits for this
      // transaction and then sees the durable freeze. Taking it here rather
      // than beside the freeze is the whole point: blockers read under it are
      // answers about a shelf that cannot move while they are being read.
      await acquireInventoryExclusiveLock(tx, locked.branchId);

      const blockers = await handoverStartBlockers(tx, {
        cafeId: locked.cafeId,
        branchId: locked.branchId,
      });
      // Nothing has been written yet. A refusal here leaves the shift OPEN
      // and fully operational rather than settled into a state it cannot
      // leave — which is the only ordering that makes "reject BEFORE
      // financial close" a true statement.
      if (blockers.length > 0) throw new HandoverBlockedError(blockers);
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
    // shift untouched rather than be rolled back from halfway through. That
    // now covers all three tenders — every reason is demanded here, so a
    // close that is going to be refused for a missing card explanation is
    // refused before the drawer snapshot is written.
    const reason = resolveVarianceReason(variance, args.reason);
    const settlements = resolveTenderSettlements(
      {
        // The authoritative per-method aggregates, from the same freshened
        // row `expectedCash` came from. Never a second formula, and never a
        // figure the client supplied.
        CARD: Number(fresh.totalCardSales),
        WALLET: Number(fresh.totalWalletSales),
      },
      args.tenders ?? {}
    );

    const status: ShiftStatus = handoverRequired ? "AWAITING_HANDOVER" : "CLOSED";
    const closedAt = new Date();

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
        // The money became a fact on BOTH paths, so both stamp this.
        // `closedAt` is the shift finishing, which on the handover path has
        // not happened yet — acceptance answers for the shelf and writes
        // `closedAt` and `stockClosedAt` together. A shift claiming it closed
        // at a moment its stock was still in dispute would be a false record.
        financiallyClosedAt: closedAt,
        ...(handoverRequired ? {} : { closedAt }),
        handoverRequired,
        status,
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

    // The electronic channels, after the status guard so a losing racer never
    // reaches them, and inside this same transaction so a settlement that
    // cannot be recorded takes the cash close down with it. A shift marked
    // CLOSED asserts the WHOLE shift was settled; a partially reconciled one
    // would be a worse record than no reconciliation at all.
    const tenders = await persistTenderSettlements(tx, {
      cafeId: locked.cafeId,
      branchId: locked.branchId,
      shiftId: locked.id,
      shiftNumber: locked.shiftNumber,
      actorId: args.actorId,
      settlements,
    });

    // ── The handover half, in this same transaction ──
    let handoverId: string | null = null;
    let freezeId: string | null = null;
    let requiredItemCount: number | null = null;
    let cashCustodyFinalization: CashCustodyFinalization | null = null;

    if (handoverRequired && target) {
      // BRANCH_CUSTODY is the target that ends employee custody of the
      // drawer, so the outgoing CASH period is discharged here at the counted
      // figure and NO successor is opened — nobody has been appointed to hold
      // it. SHIFT_TO_SHIFT leaves CASH open for SH-20's atomic transfer to
      // the arriving custodian. STOCK is untouched by both.
      if (target === "BRANCH_CUSTODY") {
        cashCustodyFinalization = await finalizeCashCustodyAtFinancialClose(tx, {
          cafeId: locked.cafeId,
          branchId: locked.branchId,
          outgoingShiftId: locked.id,
          actualCash,
        });
      }

      const created = await createHandoverInClose(tx, {
        cafeId: locked.cafeId,
        branchId: locked.branchId,
        outgoingShiftId: locked.id,
        // The custodian being discharged, not whoever signed the close. A
        // manager closing somebody else's shift is ordinary and supervised,
        // and naming them here would move the stock onto the wrong person.
        outgoingUserId: locked.cashierId,
        at: closedAt,
        target,
      });
      handoverId = created.handoverId;
      freezeId = created.freezeId;
      requiredItemCount = created.requiredItemCount;
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
      details: {
        ...evidence,
        closedByManager: args.closedByManager,
        varianceCaseId,
        // The whole close, reconstructible from one row: cash above, and
        // every channel that was settled here. Listed separately rather than
        // summed — a net figure would make the two counterparties
        // indistinguishable and the record unusable as evidence.
        tenders: tenders.map((t) => ({
          method: t.method,
          expected: t.expected,
          actual: t.actual,
          variance: t.variance,
          kind: t.kind,
          reason: t.reason,
          reconciliationId: t.reconciliationId,
          varianceCaseId: t.varianceCaseId,
        })),
        // What this close decided about the stock, in the same row as what it
        // decided about the money — including the CASH custody discharge,
        // which gets no audit action of its own precisely so the two can
        // never disagree about one act.
        resultingStatus: status,
        handoverRequired,
        handoverTarget: target,
        handoverId,
        freezeId,
        requiredItemCount,
        handoverConfigIssue: cycleIssue
          ? { code: cycleIssue.code, message: cycleIssue.message }
          : null,
        cashCustodyFinalization: cashCustodyFinalization
          ? {
              closedCashCustodyId: cashCustodyFinalization.closedCashCustodyId,
              closingCashAmount: cashCustodyFinalization.closingCashAmount,
              successorOpened: cashCustodyFinalization.successorOpened,
            }
          : null,
      },
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
      tenders,
      status,
      handoverRequired,
      handoverTarget: target,
      handoverId,
      freezeId,
      requiredItemCount,
      handoverConfigIssue: cycleIssue,
      cashCustodyFinalization,
    };
  });
}
