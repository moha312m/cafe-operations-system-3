// ── Manager approval, as a sequence of the audited acts ────────────────────
//
// The first version of "approve" was a fourth acceptance path with its own
// rules: it confirmed an unfinished count, rewrote line dispositions, waived
// every uncounted required item with a canned note, recorded the manager as
// the person who RECEIVED the stock, closed custody with no successor, and
// swallowed every error on the way. This version owns no rule of its own.
// It is the three things a manager can already do, in order:
//
//   1. the count must be finished and CONFIRMED (system-validated, declared
//      or manager-confirmed) — a manager cannot finish somebody else's count;
//   2. a DRAFT handover whose count is confirmed is SUBMITTED in the
//      manager's name (the audit says who pressed it);
//   3. every counted, unsigned line is signed "without counting" by the
//      manager, the same signature the branch-signing panel records;
//   4. then the handover ends through its own audited door:
//        BRANCH_CUSTODY  → `acceptToBranchCustody` (omission reason + note);
//        SHIFT_TO_SHIFT  → `overrideAcceptHandover` (manager exception, an
//                          arriving shift is still required — when nobody is
//                          arriving the honest act is ending the handover
//                          into branch custody with a reason, not approving).
//
// Every refusal those doors make is kept. Nothing here writes a status,
// a custody period or a boundary of its own.

import { db } from "@/lib/db";
import { ApiError } from "@/lib/api";
import {
  acceptToBranchCustody,
  acknowledgeStockLine,
  overrideAcceptHandover,
  submitHandover,
} from "@/lib/handover";
import { EFFECTIVE_EVIDENCE_SELECT, hasAuthoritativeObservation } from "@/lib/count-evidence";

export type ApproveHandoverArgs = {
  handoverId: string;
  /** The authenticated manager. From the session; never from a body. */
  managerId: string;
  cafeId: string;
  viewerBranchId?: string | null;
  reasonCodeId: string;
  note: string;
  /** SHIFT_TO_SHIFT only. Defaults to a manager adjustment. */
  kind?: "MANAGER_ADJUSTMENT" | "NO_INCOMING";
  idempotencyKey: string;
};

export type ApproveHandoverResult = {
  success: true;
  handoverId: string;
  alreadyApproved: boolean;
  path: "BRANCH_CUSTODY" | "SHIFT_TO_SHIFT";
  submittedByManager: boolean;
  signedLines: number;
  itemsRebased: number;
  omitted: string[];
  message: string;
};

const NO_INCOMING_SHIFT_MESSAGE = "مفيش وردية مستلمة مستنية العهدة";

export async function approveHandoverAsManager(args: ApproveHandoverArgs): Promise<ApproveHandoverResult> {
  const note = args.note?.trim() ?? "";
  if (!note) throw new ApiError(400, "لازم تكتب سبب الاعتماد بالتفصيل");
  if (!args.reasonCodeId) throw new ApiError(400, "لازم تحدد سبب الاعتماد");

  const manager = await db.user.findUnique({
    where: { id: args.managerId },
    select: { id: true, role: true, cafeId: true, isActive: true, archivedAt: true },
  });
  if (!manager || !manager.isActive || manager.archivedAt) throw new ApiError(403, "حساب المستخدم غير نشط");
  if (manager.role !== "SUPER_ADMIN" && manager.cafeId !== args.cafeId) {
    throw new ApiError(403, "ليس لديك صلاحية على هذا الكافيه");
  }

  const handover = await db.handoverSession.findFirst({
    where: { id: args.handoverId, cafeId: args.cafeId },
    select: {
      id: true, branchId: true, status: true, target: true, outgoingUserId: true, stockCountSessionId: true,
      stockCountSession: { select: { id: true, status: true, lines: { select: { ...EFFECTIVE_EVIDENCE_SELECT } } } },
    },
  });
  if (!handover) throw new ApiError(404, "التسليم غير موجود");
  if (args.viewerBranchId && handover.branchId !== args.viewerBranchId) {
    throw new ApiError(403, "التسليم يتبع فرعاً آخر");
  }
  if (handover.outgoingUserId === args.managerId) {
    throw new ApiError(403, "مينفعش تعتمد تسليمك انت — الاعتماد من مدير أو مالك تاني");
  }
  const path = handover.target === "BRANCH_CUSTODY" ? "BRANCH_CUSTODY" : "SHIFT_TO_SHIFT";

  if (handover.status === "COMPLETED") {
    return {
      success: true, handoverId: handover.id, alreadyApproved: true, path, submittedByManager: false,
      signedLines: 0, itemsRebased: 0, omitted: [], message: "تم اعتماد هذا التسليم وتحديث المخزون مسبقاً",
    };
  }
  if (!handover.stockCountSessionId || !handover.stockCountSession) {
    throw new ApiError(409, "لا يمكن اعتماد تسليم لم يبدأ جرده — المُسلّم يبدأ الجرد الأول");
  }
  const count = handover.stockCountSession;
  if (count.status !== "CONFIRMED" && count.status !== "LOCKED") {
    throw new ApiError(409,
      count.status === "SUBMITTED" || count.status === "RECOUNT_REQUIRED"
        ? "الجرد مُرسل ولسه ما اتأكدش — اعتمده من شاشة الجرد («تأكيد الجرد») وبعدين اعتمد التسليم"
        : "الجرد لسه ما اتسجلش بالكامل — المُسلّم ينهي العد («إنهاء التسليم») قبل ما يتعتمد");
  }

  // 2. A draft whose count is confirmed is submitted in the manager's name.
  let submittedByManager = false;
  if (handover.status === "DRAFT") {
    const submitted = await submitHandover({
      handoverId: handover.id, outgoingUserId: args.managerId, cafeId: args.cafeId, viewerBranchId: args.viewerBranchId ?? null,
    });
    submittedByManager = !submitted.alreadySubmitted;
  } else if (handover.status === "REJECTED") {
    throw new ApiError(409, "التسليم اترجع لإعادة الجرد — المُسلّم يفتح جرد إعادة التسليم الأول");
  }

  // 3. Sign what is counted and unsigned, without counting, in the manager's name.
  const signed = await db.handoverStockAcknowledgement.findMany({
    where: { handoverId: handover.id, line: { sessionId: count.id } },
    select: { stockCountLineId: true },
  });
  const signedIds = new Set(signed.map((row) => row.stockCountLineId));
  const unsigned = count.lines.filter((line) => hasAuthoritativeObservation(line) && !signedIds.has(line.id));
  let signedLines = 0;
  for (const line of unsigned) {
    try {
      await acknowledgeStockLine({
        handoverId: handover.id, stockCountLineId: line.id, acknowledgedById: args.managerId,
        incomingCountedQuantity: null, cafeId: args.cafeId, viewerBranchId: args.viewerBranchId ?? null,
      });
      signedLines += 1;
    } catch (error) {
      // A line signed by somebody else between the read and the write is not
      // a failure of this approval.
      if (!(error instanceof ApiError && error.status === 409 && /متسجل استلامه/.test(error.message))) throw error;
    }
  }

  // 4. The audited door for this target.
  if (path === "BRANCH_CUSTODY") {
    const result = await acceptToBranchCustody({
      handoverId: handover.id, managerId: args.managerId, idempotencyKey: args.idempotencyKey,
      omissionReasonCodeId: args.reasonCodeId, omissionNote: note,
      cafeId: args.cafeId, viewerBranchId: args.viewerBranchId ?? null,
    });
    const itemsRebased = result.rebase?.itemsRebased ?? 0;
    return {
      success: true, handoverId: handover.id, alreadyApproved: result.alreadyAccepted, path, submittedByManager, signedLines,
      itemsRebased, omitted: result.requiredItems.omitted,
      message: result.alreadyAccepted
        ? "العهدة كانت اتحفظت في عهدة الفرع قبل كده — نفس النتيجة بدون تكرار"
        : `اتحفظت العهدة في عهدة الفرع وتحدثت أرصدة المخزون (${itemsRebased} صنف)${result.redecidedShiftIds?.length ? ` — ${result.redecidedShiftIds.length} شيفت مستني انتقل للتحقق من العهدة الافتتاحية` : ""}`,
    };
  }

  try {
    const result = await overrideAcceptHandover({
      handoverId: handover.id, managerId: args.managerId, reasonCodeId: args.reasonCodeId, note,
      kind: args.kind ?? "MANAGER_ADJUSTMENT", idempotencyKey: args.idempotencyKey,
      cafeId: args.cafeId, viewerBranchId: args.viewerBranchId ?? null,
    });
    const itemsRebased = result.rebase?.itemsRebased ?? 0;
    return {
      success: true, handoverId: handover.id, alreadyApproved: result.alreadyAccepted, path, submittedByManager, signedLines,
      itemsRebased, omitted: result.requiredItems.omitted,
      message: result.alreadyAccepted
        ? "الاستلام الاستثنائي كان اتسجل قبل كده — نفس النتيجة بدون تكرار"
        : `اتعمل استلام استثنائي للشيفت المستلم وتحدثت أرصدة المخزون (${itemsRebased} صنف)`,
    };
  } catch (error) {
    if (error instanceof ApiError && error.message === NO_INCOMING_SHIFT_MESSAGE) {
      throw new ApiError(409, "مفيش شيفت مستلم مفتوح لاستلام العهدة. لو مفيش حد هيستلم، استخدم «إنهاء التسليم لعهدة الفرع» بسبب مسجل من صفحة التسليم");
    }
    throw error;
  }
}
