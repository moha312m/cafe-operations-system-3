import { db } from "@/lib/db";
import { ApiError } from "@/lib/api";
import { auditInTransaction } from "@/lib/audit";

// A required explanation for an already-observed handover difference. This
// does not accept a variance, change its disposition or rewrite count evidence.
export async function recordHandoverVarianceReason(args: {
  sessionId: string; lineId: string; cafeId: string; viewerBranchId: string | null;
  actorId: string; reasonCodeId: string; note?: string;
}) {
  return db.$transaction(async tx => {
    const pointer = await tx.stockCountSession.findUnique({ where: { id: args.sessionId }, select: { handoverId: true, cafeId: true, branchId: true } });
    if (!pointer || pointer.cafeId !== args.cafeId || !pointer.handoverId) throw new ApiError(404, "جرد التسليم غير موجود");
    if (args.viewerBranchId && pointer.branchId !== args.viewerBranchId) throw new ApiError(403, "ليس لديك صلاحية على فرع تاني");
    // Same order as handover operations: handover first, then its count.
    await tx.$queryRaw`SELECT id FROM "HandoverSession" WHERE id = ${pointer.handoverId} FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "StockCountSession" WHERE id = ${args.sessionId} FOR UPDATE`;
    const handover = await tx.handoverSession.findUniqueOrThrow({ where: { id: pointer.handoverId }, select: { status: true, stockCountSessionId: true, cafeId: true, branchId: true } });
    const session = await tx.stockCountSession.findUniqueOrThrow({ where: { id: args.sessionId }, select: { status: true, accountabilityContext: true, handoverId: true } });
    if (handover.cafeId !== args.cafeId || handover.branchId !== pointer.branchId || session.handoverId !== pointer.handoverId) throw new ApiError(404, "جرد التسليم غير موجود");
    if (handover.status !== "DRAFT" || handover.stockCountSessionId !== args.sessionId || session.accountabilityContext !== "HANDOVER" || !["SUBMITTED", "RECOUNT_REQUIRED", "CONFIRMED"].includes(session.status)) throw new ApiError(409, "الجرد أو التسليم تغيّر — حدّث الحالة قبل تسجيل السبب");
    await tx.$queryRaw`SELECT id FROM "StockCountLine" WHERE id = ${args.lineId} FOR UPDATE`;
    const line = await tx.stockCountLine.findUnique({ where: { id: args.lineId }, select: { sessionId: true, countedQuantity: true, varianceQuantity: true, reasonCodeId: true, reasonNote: true } });
    if (!line || line.sessionId !== args.sessionId) throw new ApiError(404, "سطر الجرد غير موجود");
    if (line.countedQuantity === null || line.varianceQuantity === null || Number(line.varianceQuantity) === 0) throw new ApiError(409, "لا يوجد فرق معدود يحتاج سببًا");
    if (line.reasonCodeId) {
      if (line.reasonCodeId === args.reasonCodeId && line.reasonNote === (args.note ?? null)) return { recorded: true, reused: true };
      throw new ApiError(409, "سبب الفرق مسجل بالفعل — لن نستبدله بإجراء مكرر");
    }
    const reason = await tx.reasonCode.findFirst({ where: { id: args.reasonCodeId, cafeId: args.cafeId, domain: "STOCK", isActive: true }, select: { id: true } });
    if (!reason) throw new ApiError(400, "اختر سبب مخزون نشطًا من نفس الكافيه");
    await tx.stockCountLine.update({ where: { id: args.lineId }, data: { reasonCodeId: reason.id, reasonNote: args.note ?? null } });
    await auditInTransaction(tx, { cafeId: args.cafeId, userId: args.actorId, action: "HANDOVER_VARIANCE_REASON_RECORDED", entity: "StockCountLine", entityId: args.lineId, details: { sessionId: args.sessionId, handoverId: pointer.handoverId, reasonCodeId: reason.id, note: args.note ?? null } });
    return { recorded: true, reused: false };
  });
}
