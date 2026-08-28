// A confirmed difference becomes a case, once.
//
// Two properties live here that the schema alone cannot give.
//
// ONCE. Confirmation runs in a transaction that can be retried, and a caller
// may reach the same counted line twice without knowing it already succeeded.
// So `openVarianceCase` is idempotent: it returns `created: false` and the
// existing case rather than throwing or opening a twin. The `@unique` on each
// source column is what makes that safe under concurrency — two callers
// racing produce one winner and one P2002, and the loser reads the winner's
// row rather than guessing. A `findFirst`-then-`create` would be a race with
// a comfortable-looking shape.
//
// INSIDE THE CALLER'S TRANSACTION. `openVarianceCase` takes a
// `Prisma.TransactionClient` and never opens its own, for the same reason
// custody's mutators do not: confirming a count writes dispositions and opens
// cases as ONE act, and a rolled-back confirmation must leave no cases behind
// for a count that never happened. A function that opened its own transaction
// could not take part in that guarantee.
//
// `FinancialImpact` is a discriminated union rather than a nullable number,
// which makes spec §12 a compile-time property: a caller cannot supply a
// value without asserting it trustworthy, nor assert unavailability without
// naming a reason. There is no way to spell "zero, because we could not price
// it" — which is the mistake the union exists to prevent. A missing cost is
// not a shortage that cost nothing.
//
// The `source` union maps one-to-one onto T18's CHECK, so an illegal shape is
// unrepresentable in TypeScript *and* rejected by the database. Neither is
// asked to carry the rule alone.
//
// What this module deliberately does NOT do: move stock, and assign blame.
// A physical count is evidence, and rebasing it belongs to the rebase task
// through `applyStockMutation`. Responsibility is an investigation outcome
// somebody records, never a side effect of a difference being found.

import type { Prisma, TheoreticalConfidence, VarianceCaseStatus, VarianceCaseType } from "@prisma/client";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/api";
import { audit } from "@/lib/audit";
import { mayAssignResponsibility } from "@/lib/variance-confidence";

/**
 * A priced impact, or a stated reason it could not be priced.
 *
 * Never `{ available: true, value: 0 }` standing in for "unknown" — that
 * shape is legal only when zero is the real, trustworthy answer.
 */
export type FinancialImpact =
  | { available: true; value: number }
  | { available: false; reason: "MISSING_COST" | "UNTRUSTED_COST" | "CONFIDENCE_NOT_VERIFIED" };

/** Exactly one arm, matching `VarianceCase_single_source_check`. */
export type VarianceSource =
  | { kind: "STOCK_LINE"; stockCountLineId: string }
  | { kind: "TENDER"; tenderReconciliationId: string }
  | { kind: "OPENING"; openingExceptionId: string }
  | { kind: "CASH_SHIFT" };

type OpenArgs = {
  cafeId: string;
  branchId: string;
  type: VarianceCaseType;
  shiftId?: string | null;
  custodyPeriodId?: string | null;
  source: VarianceSource;
  quantityVariance?: number | null;
  amountVariance?: number | null;
  financialImpact: FinancialImpact;
  confidence?: TheoreticalConfidence;
  openedById: string;
};

/** The source column this arm fills, or none for CASH. */
function sourceColumns(source: VarianceSource) {
  switch (source.kind) {
    case "STOCK_LINE":
      return { stockCountLineId: source.stockCountLineId };
    case "TENDER":
      return { tenderReconciliationId: source.tenderReconciliationId };
    case "OPENING":
      return { openingExceptionId: source.openingExceptionId };
    case "CASH_SHIFT":
      // No column: a cash case is sourced by its shift, which is the fourth
      // arm of the CHECK. See T16 — the shift close is where cash lives.
      return {};
  }
}

/** How to find the case this source already raised, if it raised one. */
function existingWhere(source: VarianceSource, args: OpenArgs) {
  switch (source.kind) {
    case "STOCK_LINE":
      return { stockCountLineId: source.stockCountLineId };
    case "TENDER":
      return { tenderReconciliationId: source.tenderReconciliationId };
    case "OPENING":
      return { openingExceptionId: source.openingExceptionId };
    case "CASH_SHIFT":
      // Cash has no unique source column, so uniqueness is per shift: one
      // close, one cash case.
      return { type: "CASH" as const, shiftId: args.shiftId ?? undefined };
  }
}

const impactColumns = (impact: FinancialImpact) =>
  impact.available
    ? {
        financialImpact: impact.value,
        financialImpactAvailable: true,
        financialImpactUnavailableReason: null,
      }
    : {
        // NULL, never 0. The reason is what keeps "unknown" legible.
        financialImpact: null,
        financialImpactAvailable: false,
        financialImpactUnavailableReason: impact.reason,
      };

// ───────────────────── Blocking and recount policy ───────────────────
// Whether a variance stops a handover is a business decision, not a product
// constant, so it is read from the café rather than assumed.

export type VarianceBlockingPolicy = {
  blocksHandover: boolean;
  hardBlockAmount: number | null;
};

export type RecountPolicy = { required: boolean; maxAttempts: number; allowSelf: boolean };

/** Defaults for a café with no settings row yet — permissive, like the column defaults. */
const NO_BLOCKING: VarianceBlockingPolicy = { blocksHandover: false, hardBlockAmount: null };

export async function resolveVarianceBlocking(
  cafeId: string,
  client: Prisma.TransactionClient | typeof db = db
): Promise<VarianceBlockingPolicy> {
  const settings = await client.cafeSettings.findUnique({
    where: { cafeId },
    select: { varianceBlocksHandover: true, varianceHardBlockAmount: true },
  });
  if (!settings) return NO_BLOCKING;
  return {
    blocksHandover: settings.varianceBlocksHandover,
    hardBlockAmount:
      settings.varianceHardBlockAmount === null ? null : Number(settings.varianceHardBlockAmount),
  };
}

/**
 * Whether one case stops the shop.
 *
 * The `financialImpactAvailable` gate is spec §12 read in the direction that
 * is easy to get backwards. It is tempting to treat "we cannot price this" as
 * the dangerous case and block — but that turns missing cost data into an
 * operational outage, and missing cost data is what a café with an incomplete
 * recipe book has every single day. Unknown is not "presumed large", so an
 * unquantified impact never blocks, whatever the policy says.
 */
export function caseIsBlocking(args: {
  policy: VarianceBlockingPolicy;
  amountVariance: number | null;
  financialImpactAvailable: boolean;
}): boolean {
  if (!args.policy.blocksHandover) return false;
  if (!args.financialImpactAvailable) return false;

  // "Blocking on, no threshold" is a coherent instruction: stop for anything
  // we can actually price.
  if (args.policy.hardBlockAmount === null) return true;

  // A threshold with nothing to measure against it cannot be exceeded.
  if (args.amountVariance === null) return false;

  // At the amount counts as blocking — it is the block amount, not the
  // largest permitted one. Sign is irrelevant: an unexplained surplus is as
  // much a discrepancy as an unexplained shortage.
  return Math.abs(args.amountVariance) >= args.policy.hardBlockAmount;
}

export async function resolveRecountPolicy(
  cafeId: string,
  client: Prisma.TransactionClient | typeof db = db
): Promise<RecountPolicy> {
  const settings = await client.cafeSettings.findUnique({
    where: { cafeId },
    select: {
      recountRequiredOutsideTolerance: true,
      recountMaxAttempts: true,
      allowSelfRecount: true,
    },
  });
  // The column defaults, restated for a café whose settings row is not there
  // yet: a recount is required, twice, and may be done by the same person.
  if (!settings) return { required: true, maxAttempts: 2, allowSelf: true };
  return {
    required: settings.recountRequiredOutsideTolerance,
    maxAttempts: settings.recountMaxAttempts,
    allowSelf: settings.allowSelfRecount,
  };
}

/**
 * Refuse a source that belongs to somebody else.
 *
 * A foreign key proves the row exists; it does not prove the row is ours. A
 * counted line from another café satisfies every constraint on the table
 * while belonging to another business, and attaching it would put that café's
 * figures inside this one's investigation — and, once responsibility is
 * assigned, inside the wrong person's record.
 *
 * Branch matters as well as café: a case names a branch, and a shortage found
 * in one store room is not evidence about another.
 *
 * This lives here rather than in a database trigger because every case goes
 * through this one door, and Revision 3 asks for no cross-table enforcement
 * in the schema. It runs BEFORE the insert, so a refusal writes nothing.
 */
async function assertSourceBelongsToCafe(
  tx: Prisma.TransactionClient,
  args: OpenArgs
): Promise<void> {
  const mismatch = (what: string, owner: { cafeId: string; branchId: string } | null) => {
    if (!owner) return `${what} غير موجود`;
    if (owner.cafeId !== args.cafeId) return `${what} تابع لكافيه تاني — does not belong to this café`;
    if (owner.branchId !== args.branchId) return `${what} تابع لفرع تاني — does not belong to this branch`;
    return null;
  };

  let problem: string | null = null;

  switch (args.source.kind) {
    case "STOCK_LINE": {
      // The line carries no café of its own; its session does, which is
      // exactly the ownership that matters.
      const line = await tx.stockCountLine.findUnique({
        where: { id: args.source.stockCountLineId },
        select: { session: { select: { cafeId: true, branchId: true } } },
      });
      problem = mismatch("سطر الجرد", line?.session ?? null);
      break;
    }
    case "TENDER": {
      const recon = await tx.tenderReconciliation.findUnique({
        where: { id: args.source.tenderReconciliationId },
        select: { cafeId: true, branchId: true },
      });
      problem = mismatch("تسوية الدفع", recon);
      break;
    }
    case "OPENING": {
      const exception = await tx.openingException.findUnique({
        where: { id: args.source.openingExceptionId },
        select: { cafeId: true, branchId: true },
      });
      problem = mismatch("استثناء الفتح", exception);
      break;
    }
    case "CASH_SHIFT": {
      // Cash evidence is the shift close, so the shift IS the source and is
      // checked with the same strictness as an explicit source column.
      const shift = args.shiftId
        ? await tx.shift.findUnique({
            where: { id: args.shiftId },
            select: { cafeId: true, branchId: true },
          })
        : null;
      problem = mismatch("الشيفت", shift);
      break;
    }
  }

  if (problem) throw new ApiError(400, problem);
}

/**
 * Open a variance case for one piece of evidence, inside the caller's
 * transaction, at most once.
 */
export async function openVarianceCase(
  tx: Prisma.TransactionClient,
  args: OpenArgs
): Promise<{ caseId: string; created: boolean }> {
  if (args.source.kind === "CASH_SHIFT" && !args.shiftId) {
    throw new ApiError(400, "فرق الكاش لازم يكون مربوط بشيفت — a CASH case has no evidence without a shift");
  }

  await assertSourceBelongsToCafe(tx, args);

  const where = existingWhere(args.source, args);
  const existing = await tx.varianceCase.findFirst({ where, select: { id: true } });
  if (existing) return { caseId: existing.id, created: false };

  // Resolved once, at open time, and stored. A verdict recomputed at read
  // time would silently change under a case that was already decided when
  // the owner edited the policy afterwards.
  const policy = await resolveVarianceBlocking(args.cafeId, tx);
  const blocking = caseIsBlocking({
    policy,
    amountVariance: args.amountVariance ?? null,
    financialImpactAvailable: args.financialImpact.available,
  });

  try {
    const created = await tx.varianceCase.create({
      data: {
        cafeId: args.cafeId,
        branchId: args.branchId,
        type: args.type,
        shiftId: args.shiftId ?? null,
        custodyPeriodId: args.custodyPeriodId ?? null,
        ...sourceColumns(args.source),
        quantityVariance: args.quantityVariance ?? null,
        amountVariance: args.amountVariance ?? null,
        ...impactColumns(args.financialImpact),
        confidence: args.confidence ?? "UNVERIFIABLE",
        blocking,
        openedById: args.openedById,
      },
      select: { id: true },
    });
    return { caseId: created.id, created: true };
  } catch (e) {
    // Somebody else won the race. The unique index is what makes this a
    // reliable answer rather than a hopeful retry: the row it collided with
    // is the row we wanted.
    if ((e as { code?: string }).code === "P2002") {
      const winner = await tx.varianceCase.findFirst({ where, select: { id: true } });
      if (winner) return { caseId: winner.id, created: false };
    }
    throw e;
  }
}

/**
 * The only legal moves.
 *
 * WAIVED is reachable from anywhere that is not already terminal — an owner
 * may accept a difference at any point in looking at it. RESOLVED and WAIVED
 * are ends: a closed case is history, and reopening it would let the record
 * of what was decided be quietly rewritten.
 */
const LEGAL: Record<VarianceCaseStatus, VarianceCaseStatus[]> = {
  OPEN: ["UNDER_INVESTIGATION", "WAIVED"],
  UNDER_INVESTIGATION: ["RESPONSIBILITY_ASSIGNED", "APPROVED", "WAIVED"],
  RESPONSIBILITY_ASSIGNED: ["APPROVED", "WAIVED"],
  APPROVED: ["RESOLVED", "WAIVED"],
  RESOLVED: [],
  WAIVED: [],
};

const STATUS_LABEL: Record<VarianceCaseStatus, string> = {
  OPEN: "مفتوحة",
  UNDER_INVESTIGATION: "تحت الفحص",
  RESPONSIBILITY_ASSIGNED: "محددة المسؤولية",
  APPROVED: "معتمدة",
  RESOLVED: "مقفولة",
  WAIVED: "متجاوَز عنها",
};

/**
 * Move a case along, or refuse.
 *
 * Opens its own transaction on purpose, unlike `openVarianceCase`: advancing
 * a case is a deliberate human act on one record, not part of a larger write
 * that must succeed or fail together.
 */
export async function advanceVarianceCase(args: {
  caseId: string;
  to: VarianceCaseStatus;
  actorId: string;
  note?: string;
  assignedResponsibilityUserId?: string;
}): Promise<{ caseId: string; status: VarianceCaseStatus }> {
  const current = await db.varianceCase.findUnique({
    where: { id: args.caseId },
    select: { id: true, cafeId: true, status: true, confidence: true },
  });
  if (!current) throw new ApiError(404, "حالة الفرق غير موجودة");

  if (!LEGAL[current.status].includes(args.to)) {
    throw new ApiError(
      400,
      `مينفعش تنقل الحالة من «${STATUS_LABEL[current.status]}» إلى «${STATUS_LABEL[args.to]}»`
    );
  }

  // Evidence nobody could verify must never quietly become somebody's fault.
  // Checked BEFORE the update, so a refusal leaves no name written: a guard
  // that assigned first and complained afterwards would be no guard at all.
  if (args.to === "RESPONSIBILITY_ASSIGNED" && !mayAssignResponsibility(current.confidence)) {
    throw new ApiError(
      400,
      "مينفعش تحدد مسؤولية على فرق تقديره غير مؤكد — لازم الأدلة تكون VERIFIED"
    );
  }

  const terminal = args.to === "RESOLVED" || args.to === "WAIVED";
  const updated = await db.varianceCase.update({
    where: { id: args.caseId },
    data: {
      status: args.to,
      ...(args.assignedResponsibilityUserId
        ? { assignedResponsibilityUserId: args.assignedResponsibilityUserId }
        : {}),
      ...(terminal
        ? { resolvedAt: new Date(), resolvedById: args.actorId }
        : {}),
      ...(args.note ? { resolutionNote: args.note } : {}),
    },
    select: { id: true, status: true },
  });

  await audit({
    cafeId: current.cafeId,
    userId: args.actorId,
    action: "VARIANCE_CASE_ADVANCED",
    entity: "VarianceCase",
    entityId: args.caseId,
    details: {
      from: current.status,
      to: args.to,
      ...(args.assignedResponsibilityUserId
        ? { assignedResponsibilityUserId: args.assignedResponsibilityUserId }
        : {}),
    },
  });

  return { caseId: updated.id, status: updated.status };
}
