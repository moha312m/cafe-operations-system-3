// A real shortage can be confirmed, not merely re-argued.
//
// THE defect this module exists to close: an earlier revision refused
// confirmation while any line was unresolved, and offered no transition by
// which a genuine outside-tolerance variance could ever BECOME resolved. A
// shop with a real 2 kg shortage could never close its count — the only exit
// was to falsify the figure. `VARIANCE_CONFIRMED` is the honest exit: an
// explicit terminal disposition meaning "this difference is real, and
// somebody with the authority to say so said so".
//
// The state machine is `DISPOSITION_TRANSITIONS` (T13), consulted rather than
// re-stated. Every move below goes through `canTransition`, so a future edit
// that invents a shortcut fails at runtime instead of quietly widening the
// machine. Two consequences of following that map exactly:
//
//   • A line outside tolerance reaches a recount VIA `OUTSIDE_TOLERANCE`.
//     There is no COUNTED → RECOUNT_REQUIRED edge, so the reason a recount
//     was demanded is always a state the line actually occupied.
//
//   • Exhausting the attempts does NOT auto-confirm the variance. The line
//     stays `RECOUNT_REQUIRED` with nothing left to try, and its only exit is
//     an authorised acceptance. Auto-confirming would let somebody reach a
//     "confirmed shortage" — a figure that can carry a person's name — by
//     doing nothing but counting badly twice.
//
// RECOUNTING AND SIGNING OFF ARE DIFFERENT POWERS. `recordRecount` rides
// `stock_count.recount`; `acceptLineVariance` rides `stock_count.confirm` and
// demands a reason code. The store keeper who counted the room cannot wave
// their own variance through, which is the whole point of splitting the keys.
//
// EACH RECOUNT TAKES ITS OWN COUNT POINT. The shelf moved on while the
// argument was happening, and reusing the first capture would measure the
// recount against a balance that no longer exists — exactly the staleness the
// lock/version contract exists to prevent.
//
// WHAT A RECOUNT MAY REWRITE. Nothing of the first count. Its quantity,
// expectation, cursor, basis, timestamp and counter all stay on the line
// exactly as capture wrote them, and this recount's equivalents live in its
// own `StockCountRecount` row. Two observations, two rows, each complete.
//
// An earlier version of this function wrote the recount's count point over
// the line's. That produced correct rebase arithmetic — quantity and cursor
// did match — by destroying the first count's provenance, leaving the
// original cursor recoverable only from the `ITEM_COUNTED` audit row. That
// row is written by the best-effort `audit()`, which swallows its own
// failures by design, so the durable copy of the original count point was a
// row the system does not promise to have written.
//
// The pairing that arithmetic needed now comes from
// `effectiveCountEvidence` (src/lib/count-evidence.ts), which hands back a
// quantity and the cursor belonging to that same observation. The line keeps
// two denormalised mirrors — `effectiveCountedQuantity` and
// `varianceQuantity` — so existing readers still see the figure in force;
// the cursor is never mirrored, because a cursor is only correct next to its
// own quantity.

import type { CountLineDisposition, RecountKind } from "@prisma/client";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/api";
import { audit } from "@/lib/audit";
import { round3 } from "@/lib/costing";
import { captureCountPoint } from "@/lib/count-point";
import { canTransition, isTerminal } from "@/lib/count-disposition";
import { resolveRecountPolicy } from "@/lib/variance-case";
import { resolveStockTolerance, withinTolerance } from "@/lib/tolerance";

export const SELF_RECOUNT_AUDIT_ACTION = "STOCK_COUNT_SELF_RECOUNT";
export const VARIANCE_ACCEPTED_AUDIT_ACTION = "COUNT_VARIANCE_ACCEPTED";

const SELF_RECOUNT_FALLBACK =
  "مفيش حد تاني متاح يعيد العد — إعادة عد بنفس الشخص مسموحة كحل أخير";

/**
 * Who is recounting, and whether they may.
 *
 * An independent recount is the point of recounting: a second pair of eyes.
 * A self-recount is a fallback for a branch with one person on shift, so it
 * is allowed only when the owner permits it, is labelled as what it is, and
 * carries a stated reason — a recount that merely repeats the first counter's
 * opinion should never be mistaken for corroboration.
 */
export function classifyRecounter(args: {
  originalCounterId: string;
  recounterId: string;
  allowSelfRecount: boolean;
}): { allowed: boolean; kind: RecountKind; fallbackReason: string | null } {
  if (args.originalCounterId !== args.recounterId) {
    return { allowed: true, kind: "INDEPENDENT", fallbackReason: null };
  }
  return {
    allowed: args.allowSelfRecount,
    kind: "SELF_RECOUNT",
    fallbackReason: SELF_RECOUNT_FALLBACK,
  };
}

/** Dispositions a recount may act on. Anything else is settled or unstarted. */
const RECOUNTABLE: readonly CountLineDisposition[] = ["RECOUNT_REQUIRED", "OUTSIDE_TOLERANCE"];

/** Sessions whose evidence is closed. */
const CLOSED: readonly string[] = ["CONFIRMED", "LOCKED"];

/** Load a line with everything a recount or an acceptance needs to decide. */
async function lineForResolution(args: {
  lineId: string;
  sessionId?: string;
  cafeId?: string;
  viewerBranchId?: string | null;
}) {
  const line = await db.stockCountLine.findUnique({
    where: { id: args.lineId },
    select: {
      id: true,
      sessionId: true,
      inventoryItemId: true,
      disposition: true,
      counterId: true,
      countedQuantity: true,
      session: { select: { id: true, cafeId: true, branchId: true, status: true } },
      inventoryItem: { select: { category: true } },
    },
  });

  const wrongSession = args.sessionId !== undefined && line?.sessionId !== args.sessionId;
  const wrongCafe = args.cafeId !== undefined && line?.session.cafeId !== args.cafeId;
  if (!line || wrongSession || wrongCafe) {
    throw new ApiError(404, "سطر الجرد غير موجود");
  }
  if (args.viewerBranchId && line.session.branchId !== args.viewerBranchId) {
    throw new ApiError(403, "ليس لديك صلاحية على فرع تاني");
  }
  if (CLOSED.includes(line.session.status)) {
    throw new ApiError(409, "الجرد ده اتقفل خلاص");
  }
  return line;
}

/** Refuse a move the accepted map does not contain. */
function assertLegal(from: CountLineDisposition, to: CountLineDisposition) {
  if (from === to) return;
  if (!canTransition(from, to)) {
    throw new ApiError(409, `مينفعش تنقل سطر الجرد من ${from} إلى ${to}`);
  }
}

export type RecountResult = {
  attempt: number;
  kind: RecountKind;
  disposition: CountLineDisposition;
  attemptsRemaining: number;
};

/**
 * Count one contested shelf again.
 *
 * Lands inside tolerance → the line is resolved and terminal. Lands outside
 * with attempts remaining → it stays contested. Lands outside with none
 * remaining → it stays contested and further recounts are refused, leaving
 * the authorised acceptance as the only exit.
 */
export async function recordRecount(args: {
  lineId: string;
  countedQuantity: number;
  recounterId: string;
  sessionId?: string;
  cafeId?: string;
  viewerBranchId?: string | null;
}): Promise<RecountResult> {
  if (!Number.isFinite(args.countedQuantity) || args.countedQuantity < 0) {
    throw new ApiError(400, "الكمية المعدودة لازم تكون رقم مش سالب");
  }

  const line = await lineForResolution(args);
  if (!RECOUNTABLE.includes(line.disposition)) {
    throw new ApiError(
      409,
      isTerminal(line.disposition)
        ? "السطر ده اتقفل خلاص — مينفعش يتعاد عده"
        : "السطر ده لسه محتاج يتقفل بالعد الأول قبل إعادة العد"
    );
  }

  const [policy, tolerance, attempts] = await Promise.all([
    resolveRecountPolicy(line.session.cafeId),
    resolveStockTolerance({
      cafeId: line.session.cafeId,
      branchId: line.session.branchId,
      inventoryItemId: line.inventoryItemId,
      category: line.inventoryItem.category,
    }),
    db.stockCountRecount.findMany({
      where: { lineId: line.id },
      orderBy: { attempt: "desc" },
      select: { attempt: true, counterId: true },
    }),
  ]);

  if (attempts.length >= policy.maxAttempts) {
    throw new ApiError(
      409,
      `خلصت محاولات إعادة العد (${policy.maxAttempts}) — لازم حد معاه صلاحية التأكيد يعتمد الفرق`
    );
  }

  // "The same person counts again" means the same person as the LAST count,
  // which is the previous recounter once there has been one.
  const originalCounterId = attempts[0]?.counterId ?? line.counterId ?? "";
  const who = classifyRecounter({
    originalCounterId,
    recounterId: args.recounterId,
    allowSelfRecount: policy.allowSelf,
  });
  if (!who.allowed) {
    throw new ApiError(403, "لازم حد تاني يعيد العد — إعادة العد بنفس الشخص مقفولة");
  }

  const attempt = (attempts[0]?.attempt ?? 0) + 1;
  const counted = round3(args.countedQuantity);

  const outcome = await db.$transaction(async (tx) => {
    const point = await captureCountPoint(tx, line.inventoryItemId);
    const variance = round3(counted - point.expectedQuantity);
    const resolved = withinTolerance({
      varianceQuantity: variance,
      expectedQuantity: point.expectedQuantity,
      tolerance,
    });

    const next: CountLineDisposition = resolved
      ? "RESOLVED_WITHIN_TOLERANCE"
      : line.disposition;
    assertLegal(line.disposition, next);

    await tx.stockCountRecount.create({
      data: {
        lineId: line.id,
        attempt,
        kind: who.kind,
        countedQuantity: counted,
        expectedQuantity: point.expectedQuantity,
        itemVersion: point.itemVersion,
        varianceQuantity: variance,
        countedAt: point.capturedAt,
        counterId: args.recounterId,
        resolved,
      },
    });

    await tx.stockCountLine.update({
      where: { id: line.id },
      data: {
        // The FIRST count's evidence is absent from this payload, all of it:
        // countedQuantity, expectedQuantity, itemVersion, expectedBasis,
        // countedAt and counterId stay exactly as capture wrote them. A later
        // count disagreeing with the first does not make the first untrue, and
        // an investigation into a repeated shortage needs both.
        //
        // What IS written are the two denormalised operational mirrors, kept
        // equal to `effectiveCountEvidence(line)` so existing readers of the
        // line get the figure in force. The CURSOR is never mirrored: it is
        // only correct alongside its own quantity, so callers that need the
        // pair take it from the resolver, which hands both over together.
        effectiveCountedQuantity: counted,
        varianceQuantity: variance,
        disposition: next,
      },
    });

    return { point, variance, resolved, next };
  });

  const attemptsRemaining = Math.max(0, policy.maxAttempts - attempt);

  if (who.kind === "SELF_RECOUNT") {
    await audit({
      cafeId: line.session.cafeId,
      userId: args.recounterId,
      action: SELF_RECOUNT_AUDIT_ACTION,
      entity: "StockCountLine",
      entityId: line.id,
      details: {
        sessionId: line.session.id,
        inventoryItemId: line.inventoryItemId,
        attempt,
        fallbackReason: who.fallbackReason,
      },
    });
  }

  await audit({
    cafeId: line.session.cafeId,
    userId: args.recounterId,
    action: "STOCK_COUNT_RECOUNTED",
    entity: "StockCountLine",
    entityId: line.id,
    details: {
      sessionId: line.session.id,
      inventoryItemId: line.inventoryItemId,
      attempt,
      kind: who.kind,
      countedQuantity: counted,
      itemVersion: String(outcome.point.itemVersion),
      resolved: outcome.resolved,
      disposition: outcome.next,
      attemptsRemaining,
    },
  });

  return { attempt, kind: who.kind, disposition: outcome.next, attemptsRemaining };
}

/**
 * Accept a difference as real, and close the line.
 *
 * The escape an earlier revision lacked. Deliberately expensive to reach: a
 * reason code from the café's own STOCK vocabulary, and the `stock_count
 * .confirm` key, which the counting roles do not hold. Accepting a variance
 * does not edit the evidence that found it — the counted figure stays exactly
 * as recorded, and what changes is only that nobody is waiting on it.
 */
export async function acceptLineVariance(args: {
  lineId: string;
  actorId: string;
  reasonCodeId: string;
  note?: string;
  sessionId?: string;
  cafeId?: string;
  viewerBranchId?: string | null;
}): Promise<{ disposition: "VARIANCE_CONFIRMED" }> {
  if (!args.reasonCodeId) {
    throw new ApiError(400, "لازم تحدد سبب الفرق قبل ما تعتمده");
  }

  const line = await lineForResolution(args);
  assertLegal(line.disposition, "VARIANCE_CONFIRMED");

  const reason = await db.reasonCode.findUnique({
    where: { id: args.reasonCodeId },
    select: { cafeId: true, domain: true, isActive: true },
  });
  if (!reason || reason.cafeId !== line.session.cafeId || reason.domain !== "STOCK") {
    throw new ApiError(400, "سبب الفرق مش من أسباب المخزون بتاعة الكافيه");
  }
  if (!reason.isActive) throw new ApiError(400, "سبب الفرق ده متوقف");

  await db.stockCountLine.update({
    where: { id: line.id },
    data: {
      disposition: "VARIANCE_CONFIRMED",
      reasonCodeId: args.reasonCodeId,
      reasonNote: args.note ?? null,
    },
  });

  await audit({
    cafeId: line.session.cafeId,
    userId: args.actorId,
    action: VARIANCE_ACCEPTED_AUDIT_ACTION,
    entity: "StockCountLine",
    entityId: line.id,
    details: {
      sessionId: line.session.id,
      inventoryItemId: line.inventoryItemId,
      previousDisposition: line.disposition,
      reasonCodeId: args.reasonCodeId,
      note: args.note ?? null,
    },
  });

  return { disposition: "VARIANCE_CONFIRMED" };
}
