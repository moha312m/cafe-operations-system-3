// ── Closing cash disposition (direct shift handover) ─────────────────────
// The outgoing employee states where the cash they COUNTED went: handed to an
// identified owner/manager (a declaration the recipient later confirms from
// their own account) and/or left in the drawer as custody. The allocation must
// reconcile exactly to the counted cash. Card, InstaPay (WALLET) and other
// electronic totals are payment reconciliation and never appear here.
//
// This module posts nothing to accounting and creates no expense or drawing:
// "owner" and "manager" are destinations of custody until the approved posting
// policy says otherwise. The counted-vs-expected difference is a separate,
// already-recorded finding on the Shift and is only snapshotted here.
import { createHash } from "node:crypto";
import type { Prisma, CashDeliveryDestination } from "@prisma/client";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/api";
import { auditInTransaction } from "@/lib/audit";
import { decimal, money, sumMoney, validCurrencyInput } from "@/lib/money";
import { protectedContext, protectedTransaction } from "@/lib/protected-transaction";
import { lockShifts } from "@/lib/transaction-locks";
import { isBranchStaff, projectStaffBranch, resolveStaffBranchInTransaction } from "@/lib/staff-branch";

export const CASH_DISPOSITION_RECORDED_AUDIT_ACTION = "SHIFT_CASH_DISPOSITION_RECORDED";
export const CASH_DELIVERY_DECLARED_AUDIT_ACTION = "CASH_DELIVERY_DECLARED";
export const CASH_DELIVERY_CONFIRMED_AUDIT_ACTION = "CASH_DELIVERY_CONFIRMED";
export const CASH_DELIVERY_DISPUTED_AUDIT_ACTION = "CASH_DELIVERY_DISPUTED";
export const CASH_DELIVERY_RESOLVED_AUDIT_ACTION = "CASH_DELIVERY_DISPUTE_RESOLVED";
export const DIRECT_CASH_OPENING_AUDIT_ACTION = "HANDOVER_DIRECT_CASH_OPENING";

export const MAX_DELIVERIES = 12;
const NOTE_MAX = 1000;
const REF_MAX = 160;
const RECENT_MS = 12 * 60 * 60 * 1000;

export const DELIVERY_STATUS_LABEL: Record<string, string> = {
  DECLARED: "تسليم مُعلن — بانتظار تأكيد المستلم",
  CONFIRMED: "تم تأكيد الاستلام",
  DISPUTED: "اختلاف مُبلَّغ — بانتظار المراجعة",
  RESOLVED: "تمت تسوية الاختلاف",
};
export const DELIVERY_DESTINATION_LABEL: Record<string, string> = { OWNER: "استلمها المالك", MANAGER: "استلمها المدير" };
export const RETAINED_LABEL = "تُترك في الدرج كعهدة";

export type DeliveryInput = {
  destination: CashDeliveryDestination;
  recipientId: string;
  amount: number | string;
  reference?: string | null;
};
export type DispositionInput = {
  shiftId: string;
  deliveries: DeliveryInput[];
  retainedAmount: number | string;
  note?: string | null;
  idempotencyKey: string;
};
export type NormalizedDelivery = { destination: CashDeliveryDestination; recipientId: string; amount: number; reference: string | null };
export type Allocation = { counted: number; delivered: number; retained: number; deliveries: NormalizedDelivery[] };

/** Pure arithmetic and shape validation; shared by the server, the preview and the tests. */
export function planAllocation(countedCash: number | string, deliveriesIn: DeliveryInput[], retainedIn: number | string): Allocation {
  const bad = (message: string) => new ApiError(400, message);
  if (!validCurrencyInput(countedCash) || decimal(countedCash).lt(0)) throw bad("النقدية المعدودة لازم تكون موجبة أو صفر وبحد أقصى منزلتين عشريتين");
  if (!validCurrencyInput(retainedIn) || decimal(retainedIn).lt(0)) throw bad("المبلغ المتروك في الدرج لازم يكون موجب أو صفر وبحد أقصى منزلتين عشريتين");
  if (deliveriesIn.length > MAX_DELIVERIES) throw bad("عدد التسليمات أكبر من المسموح");
  const deliveries: NormalizedDelivery[] = deliveriesIn.map((d) => {
    if (d.destination !== "OWNER" && d.destination !== "MANAGER") throw bad("جهة التسليم غير صالحة");
    if (!d.recipientId) throw bad("حدد المستلم (المالك أو المدير) من القائمة");
    if (!validCurrencyInput(d.amount) || decimal(d.amount).lte(0)) throw bad("مبلغ التسليم لازم يكون أكبر من صفر وبحد أقصى منزلتين عشريتين");
    const reference = d.reference?.trim() || null;
    if ((reference?.length ?? 0) > REF_MAX) throw bad("المرجع طويل جدًا");
    return { destination: d.destination, recipientId: d.recipientId, amount: money(d.amount).toNumber(), reference };
  });
  const counted = money(countedCash);
  const retained = money(retainedIn);
  const delivered = money(sumMoney(deliveries.map((d) => d.amount)));
  if (!delivered.plus(retained).eq(counted)) {
    throw bad(`توزيع النقدية لازم يساوي المعدود بالظبط: المعدود ${counted.toFixed(2)} والموزّع ${delivered.plus(retained).toFixed(2)}`);
  }
  return { counted: counted.toNumber(), delivered: delivered.toNumber(), retained: retained.toNumber(), deliveries };
}

const sortedForFingerprint = (a: Allocation) =>
  [...a.deliveries].sort((x, y) => `${x.destination}|${x.recipientId}|${x.amount}|${x.reference ?? ""}`.localeCompare(`${y.destination}|${y.recipientId}|${y.amount}|${y.reference ?? ""}`));

export function allocationFingerprint(shiftId: string, a: Allocation, note: string | null): string {
  return createHash("sha256").update(JSON.stringify({ shiftId, counted: a.counted, retained: a.retained, deliveries: sortedForFingerprint(a), note })).digest("hex");
}

type Actor = { id: string; role: string; cafeId: string | null };

/** Owners, and managers assigned to this branch. Never the outgoing employee, never a platform admin. */
export async function listEligibleRecipients(client: Prisma.TransactionClient | typeof db, args: { cafeId: string; branchId: string; excludeUserId?: string }) {
  const users = await client.user.findMany({
    where: { cafeId: args.cafeId, isActive: true, archivedAt: null, role: { in: ["CAFE_OWNER", "BRANCH_MANAGER"] }, ...(args.excludeUserId ? { id: { not: args.excludeUserId } } : {}) },
    select: { id: true, name: true, role: true, branchId: true, temporaryBranchId: true },
    orderBy: [{ role: "asc" }, { name: "asc" }],
  });
  return users
    .filter((u) => u.role === "CAFE_OWNER" || u.branchId === args.branchId || u.temporaryBranchId === args.branchId)
    .map((u) => ({ id: u.id, name: u.name, role: u.role as "CAFE_OWNER" | "BRANCH_MANAGER", destination: (u.role === "CAFE_OWNER" ? "OWNER" : "MANAGER") as CashDeliveryDestination }));
}

async function assertRecipient(tx: Prisma.TransactionClient, d: NormalizedDelivery, shift: { cafeId: string; branchId: string; cashierId: string }) {
  const refusal = new ApiError(400, "المستلم لازم يكون مالك أو مدير نشط في نفس الفرع");
  if (d.recipientId === shift.cashierId) throw new ApiError(400, "مينفعش تسلّم الكاش لنفسك — اختار المالك أو المدير");
  const user = await tx.user.findFirst({
    where: { id: d.recipientId, cafeId: shift.cafeId, isActive: true, archivedAt: null },
    select: { id: true, cafeId: true, role: true, branchId: true, temporaryBranchId: true, temporaryBranchUntil: true, temporaryBranchStartedAt: true, temporaryBranchCancelledAt: true },
  });
  if (!user) throw refusal;
  if (d.destination === "OWNER" && user.role !== "CAFE_OWNER") throw refusal;
  if (d.destination === "MANAGER") {
    if (user.role !== "BRANCH_MANAGER") throw refusal;
    const assignment = await projectStaffBranch(tx, user);
    if (assignment.branchId !== shift.branchId) throw refusal;
  }
}

const SHIFT_NOT_CLOSED = "اقفل الشيفت ماليًا الأول (إدخال المعدود) قبل تحديد مصير النقدية";

/** The closing figures a disposition is measured against, read from the persisted close. */
export async function closingCashPosition(client: Prisma.TransactionClient | typeof db, shiftId: string) {
  const shift = await client.shift.findUnique({
    where: { id: shiftId },
    select: {
      id: true, cafeId: true, branchId: true, cashierId: true, shiftNumber: true, status: true, financiallyClosedAt: true,
      openingCashAmount: true, expectedCashAmount: true, actualCashAmount: true, cashDifference: true,
      totalCashSales: true, totalCardSales: true, totalWalletSales: true, totalCashPayouts: true, totalExpensePayouts: true, totalExpenseReturns: true,
    },
  });
  if (!shift) return null;
  return shift;
}

const DISPOSITION_INCLUDE = {
  declaredBy: { select: { id: true, name: true } },
  shift: { select: { shiftNumber: true, branchId: true } },
  handover: { select: { id: true, status: true, incomingShift: { select: { id: true, shiftNumber: true, cashier: { select: { name: true } } } } } },
  deliveries: { include: { recipient: { select: { id: true, name: true, role: true } } } },
} satisfies Prisma.ShiftCashDispositionInclude;

type DispositionRow = Prisma.ShiftCashDispositionGetPayload<{ include: typeof DISPOSITION_INCLUDE }>;
type NextDrawerShift = { id: string; shiftNumber: number; cashierName: string } | null;

export function presentDisposition(row: DispositionRow, nextDrawerShift: NextDrawerShift = null) {
  const deliveries = [...row.deliveries].sort((a, b) => a.declaredAt.getTime() - b.declaredAt.getTime() || a.id.localeCompare(b.id)).map((d) => ({
    id: d.id, destination: d.destination, destinationLabel: DELIVERY_DESTINATION_LABEL[d.destination], recipientId: d.recipientId, recipientName: d.recipient.name,
    amount: Number(d.amount), reference: d.reference, status: d.status, statusLabel: DELIVERY_STATUS_LABEL[d.status],
    declaredAt: d.declaredAt.toISOString(), confirmedAt: d.confirmedAt?.toISOString() ?? null,
    disputedAt: d.disputedAt?.toISOString() ?? null, disputeNote: d.disputeNote, claimedReceivedAmount: d.claimedReceivedAmount === null ? null : Number(d.claimedReceivedAmount),
    resolvedAt: d.resolvedAt?.toISOString() ?? null, resolutionNote: d.resolutionNote, resolvedAmount: d.resolvedAmount === null ? null : Number(d.resolvedAmount),
  }));
  const incomingFromHandover = row.handover?.status === "COMPLETED" && row.handover.incomingShift
    ? { id: row.handover.incomingShift.id, shiftNumber: row.handover.incomingShift.shiftNumber, cashierName: row.handover.incomingShift.cashier.name }
    : null;
  const receivedByShift = incomingFromHandover ?? nextDrawerShift;
  const retainedAmount = Number(row.retainedAmount);
  const retainedStatus = receivedByShift
    ? ("HANDED_TO_SHIFT" as const)
    : row.handoverId
      ? ("AWAITING_HANDOVER_ACCEPTANCE" as const)
      : ("IN_DRAWER_FOR_NEXT_SHIFT" as const);
  const retainedStatusLabel = receivedByShift
    ? `انتقلت لعهدة الشيفت #${receivedByShift.shiftNumber} (${receivedByShift.cashierName})`
    : row.handoverId
      ? "في الدرج كعهدة — بانتظار استلام الشيفت التالي"
      : "في الدرج كعهدة — بانتظار فتح الشيفت التالي";
  return {
    id: row.id, shiftId: row.shiftId, handoverId: row.handoverId, countedCash: Number(row.countedCash), expectedCash: Number(row.expectedCash),
    cashDifference: Number(row.cashDifference), deliveredAmount: Number(row.deliveredAmount), retainedAmount,
    note: row.note, declaredById: row.declaredById, declaredByName: row.declaredBy.name, declaredAt: row.declaredAt.toISOString(), fingerprint: row.fingerprint, deliveries,
    retainedCustody: {
      destinationLabel: RETAINED_LABEL,
      amount: retainedAmount,
      status: retainedStatus,
      statusLabel: retainedStatusLabel,
      holderName: receivedByShift ? receivedByShift.cashierName : row.declaredBy.name,
      incomingShiftId: receivedByShift?.id ?? null,
      incomingShiftNumber: receivedByShift?.shiftNumber ?? null,
    },
  };
}
export type PresentedDisposition = ReturnType<typeof presentDisposition>;

export async function dispositionForShift(client: Prisma.TransactionClient | typeof db, shiftId: string): Promise<PresentedDisposition | null> {
  const row = await client.shiftCashDisposition.findUnique({
    where: { shiftId },
    include: DISPOSITION_INCLUDE,
  });
  if (!row) return null;
  let nextDrawerShift: NextDrawerShift = null;
  if (!row.handoverId) {
    const next = await client.shift.findFirst({
      where: { branchId: row.shift.branchId, shiftNumber: { gt: row.shift.shiftNumber } },
      orderBy: { shiftNumber: "asc" },
      select: { id: true, shiftNumber: true, cashier: { select: { name: true } } },
    });
    if (next) nextDrawerShift = { id: next.id, shiftNumber: next.shiftNumber, cashierName: next.cashier.name };
  }
  return presentDisposition(row, nextDrawerShift);
}

export type RecordDispositionResult = { disposition: PresentedDisposition; alreadyRecorded: boolean };

/**
 * Record the closing allocation. Written once per outgoing shift:
 * the same allocation retried returns the stored record; a different one is refused
 * (a stale form must never silently replace what the next shift will open with).
 */
export async function recordCashDisposition(args: {
  actor: { id: string; cafeId: string | null; role: string };
  canActForOthers: boolean;
  input: DispositionInput;
}): Promise<RecordDispositionResult> {
  const { input } = args;
  if (!input.idempotencyKey || input.idempotencyKey.length > 200) throw new ApiError(400, "لازم تبعت مفتاح إعادة المحاولة");
  const note = input.note?.trim() || null;
  if ((note?.length ?? 0) > NOTE_MAX) throw new ApiError(400, "الملاحظة طويلة جدًا");
  return protectedTransaction(async (tx) => {
    // User first (assignment changes), then Shift, then the handover row — the established order.
    await resolveStaffBranchInTransaction(tx, args.actor.id);
    const candidate = await tx.shift.findFirst({ where: { id: input.shiftId, ...(args.actor.cafeId ? { cafeId: args.actor.cafeId } : {}) }, select: { id: true, cafeId: true, branchId: true, cashierId: true, shiftNumber: true } });
    if (!candidate) throw new ApiError(404, "الشيفت مش موجود");
    protectedContext(tx).scope = { cafeId: candidate.cafeId, branchId: candidate.branchId };
    const actorRow = await tx.user.findUnique({ where: { id: args.actor.id }, select: { isActive: true, archivedAt: true, cafeId: true, role: true, branchId: true, temporaryBranchId: true, temporaryBranchUntil: true, temporaryBranchStartedAt: true, temporaryBranchCancelledAt: true, id: true } });
    if (!actorRow?.isActive || actorRow.archivedAt || (actorRow.role !== "SUPER_ADMIN" && actorRow.cafeId !== candidate.cafeId)) throw new ApiError(403, "ليس لديك صلاحية لتنفيذ الإجراء ده");
    if (isBranchStaff(actorRow.role)) {
      const assignment = await projectStaffBranch(tx, actorRow);
      if (assignment.branchId !== candidate.branchId) throw new ApiError(403, "ليس لديك صلاحية على فرع تاني");
    }
    if (candidate.cashierId !== args.actor.id && !args.canActForOthers) throw new ApiError(403, "مش مسموح تحدد مصير نقدية شيفت موظف تاني");
    const discoveredNext = await tx.shift.findFirst({
      where: { cafeId: candidate.cafeId, branchId: candidate.branchId, shiftNumber: { gt: candidate.shiftNumber } },
      orderBy: { shiftNumber: "asc" },
      select: { id: true },
    });
    await lockShifts(tx, discoveredNext ? [candidate.id, discoveredNext.id] : [candidate.id]);

    const shift = await tx.shift.findUniqueOrThrow({
      where: { id: candidate.id },
      select: { id: true, cafeId: true, branchId: true, cashierId: true, shiftNumber: true, status: true, financiallyClosedAt: true, actualCashAmount: true, expectedCashAmount: true, cashDifference: true },
    });
    const handover = await tx.handoverSession.findFirst({ where: { outgoingShiftId: shift.id }, orderBy: { createdAt: "desc" }, select: { id: true, status: true, target: true } });
    if (handover) await tx.$queryRaw`SELECT "id" FROM "HandoverSession" WHERE "id" = ${handover.id} FOR UPDATE`;

    const existing = await dispositionForShift(tx, shift.id);
    if (shift.status === "OPEN" || shift.financiallyClosedAt === null || shift.actualCashAmount === null) {
      if (existing) throw new ApiError(409, SHIFT_NOT_CLOSED);
      throw new ApiError(409, SHIFT_NOT_CLOSED);
    }
    const allocation = planAllocation(shift.actualCashAmount.toString(), input.deliveries, input.retainedAmount);
    const fingerprint = allocationFingerprint(shift.id, allocation, note);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new ApiError(409, "مصير النقدية اتسجل قبل كده بتوزيع مختلف — حدّث الصفحة وراجع المسجل");
      return { disposition: existing, alreadyRecorded: true };
    }
    if (shift.status === "CLOSED" && Date.now() - shift.financiallyClosedAt.getTime() > RECENT_MS) throw new ApiError(409, "الشيفت اتقفل من فترة طويلة — مصير النقدية لازم يتحدد عند الإقفال");
    if (handover && !["DRAFT", "REJECTED"].includes(handover.status)) throw new ApiError(409, "التسليم اتقدم خلاص — مصير النقدية متقفل");
    if (handover && handover.target !== "SHIFT_TO_SHIFT") throw new ApiError(409, "مصير النقدية للتسليم المباشر (وردية لوردية). عهدة الفرع لها إقرار الخزنة الليلي");
    if (await tx.cashStorage.findUnique({ where: { outgoingShiftId: shift.id }, select: { id: true } })) throw new ApiError(409, "نقدية الشيفت ده مسجلة بالفعل كإقرار خزنة ليلي — مينفعش تتسجل مرتين");

    const seen = new Set<string>();
    for (const d of allocation.deliveries) {
      await assertRecipient(tx, d, shift);
      const key = `${d.destination}|${d.recipientId}|${d.reference ?? ""}`;
      if (seen.has(key)) throw new ApiError(400, "تسليمان لنفس المستلم والمرجع — اجمعهم في مبلغ واحد");
      seen.add(key);
    }

    const expectedCash = money(shift.expectedCashAmount).toNumber();
    const created = await tx.shiftCashDisposition.create({
      data: {
        cafeId: shift.cafeId, branchId: shift.branchId, shiftId: shift.id, handoverId: handover?.id ?? null,
        countedCash: allocation.counted, expectedCash, cashDifference: money(decimal(allocation.counted).minus(expectedCash)).toNumber(),
        deliveredAmount: allocation.delivered, retainedAmount: allocation.retained, note, fingerprint, idempotencyKey: input.idempotencyKey,
        declaredById: args.actor.id,
        deliveries: {
          create: allocation.deliveries.map((d) => ({
            cafeId: shift.cafeId, branchId: shift.branchId, shiftId: shift.id, handoverId: handover?.id ?? null,
            destination: d.destination, recipientId: d.recipientId, amount: d.amount, reference: d.reference, declaredById: args.actor.id,
          })),
        },
      },
      include: DISPOSITION_INCLUDE,
    });
    let nextDrawerShift: NextDrawerShift = null;
    if (!handover) {
      const nextShift = await tx.shift.findFirst({
        where: { cafeId: shift.cafeId, branchId: shift.branchId, shiftNumber: { gt: shift.shiftNumber } },
        orderBy: { shiftNumber: "asc" },
        select: { id: true, shiftNumber: true, status: true, openingCashAmount: true, cashier: { select: { name: true } } },
      });
      if (nextShift) {
        if (nextShift.id !== discoveredNext?.id) throw new ApiError(409, "الشيفت التالي اتفتح أثناء التسجيل — أعد المحاولة");
        const nextPayments = await tx.payment.count({ where: { shiftId: nextShift.id } });
        if (nextShift.status === "OPEN" && nextPayments === 0) {
          await tx.shift.update({
            where: { id: nextShift.id },
            data: { openingCashAmount: allocation.retained, expectedCashAmount: allocation.retained },
          });
          const cashLink = await tx.shiftCustody.findUnique({ where: { shiftId_scope: { shiftId: nextShift.id, scope: "CASH" } }, select: { custodyPeriodId: true } });
          if (cashLink) {
            await tx.custodyPeriod.update({ where: { id: cashLink.custodyPeriodId }, data: { openingCashAmount: allocation.retained } });
          }
        } else if (Number(nextShift.openingCashAmount) !== allocation.retained) {
          throw new ApiError(409, "الشيفت التالي اتفتح واشتغل بالفعل — المتروك في الدرج لازم يطابق رصيد افتتاحه");
        }
        nextDrawerShift = { id: nextShift.id, shiftNumber: nextShift.shiftNumber, cashierName: nextShift.cashier.name };
        await auditInTransaction(tx, {
          cafeId: shift.cafeId, userId: args.actor.id, action: DIRECT_CASH_OPENING_AUDIT_ACTION, entity: "ShiftCashDisposition", entityId: created.id,
          details: {
            outgoingShiftId: shift.id, incomingShiftId: nextShift.id, retainedDrawerCash: allocation.retained,
            countedCash: allocation.counted, deliveredAmount: allocation.delivered,
            acknowledgement: "NO_HANDOVER_DRAWER_CARRYFORWARD", independentVerification: false,
          },
        });
      }
    }
    const presented = presentDisposition(created, nextDrawerShift);
    await auditInTransaction(tx, {
      cafeId: shift.cafeId, userId: args.actor.id, action: CASH_DISPOSITION_RECORDED_AUDIT_ACTION, entity: "ShiftCashDisposition", entityId: created.id,
      details: {
        branchId: shift.branchId, shiftId: shift.id, handoverId: handover?.id ?? null, countedCash: allocation.counted, expectedCash,
        cashDifference: presented.cashDifference, deliveredAmount: allocation.delivered, retainedAmount: allocation.retained,
        deliveries: presented.deliveries.map((d) => ({ id: d.id, destination: d.destination, recipientId: d.recipientId, amount: d.amount, reference: d.reference })),
        idempotencyKey: input.idempotencyKey, fingerprint,
      },
    });
    for (const d of presented.deliveries) {
      await auditInTransaction(tx, {
        cafeId: shift.cafeId, userId: args.actor.id, action: CASH_DELIVERY_DECLARED_AUDIT_ACTION, entity: "CashDeliveryDeclaration", entityId: d.id,
        details: { shiftId: shift.id, dispositionId: created.id, handoverId: handover?.id ?? null, destination: d.destination, recipientId: d.recipientId, amount: d.amount },
      });
    }
    return { disposition: presented, alreadyRecorded: false };
  });
}

// ───────────────────────── recipient confirmation ─────────────────────────

async function loadLockedDelivery(tx: Prisma.TransactionClient, id: string, actor: Actor) {
  const candidate = await tx.cashDeliveryDeclaration.findUnique({ where: { id }, select: { id: true, cafeId: true, branchId: true, recipientId: true } });
  // Another café's declaration is not confirmed to exist.
  if (!candidate || (actor.role !== "SUPER_ADMIN" && candidate.cafeId !== actor.cafeId)) throw new ApiError(404, "التسليم مش موجود");
  await resolveStaffBranchInTransaction(tx, actor.id);
  protectedContext(tx).scope = { cafeId: candidate.cafeId, branchId: candidate.branchId };
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "CashDeliveryDeclaration" WHERE "id" = ${id} FOR UPDATE`;
  if (rows.length !== 1) throw new ApiError(404, "التسليم مش موجود");
  return tx.cashDeliveryDeclaration.findUniqueOrThrow({ where: { id }, include: { recipient: { select: { id: true, name: true } } } });
}

async function assertLiveActor(tx: Prisma.TransactionClient, actor: Actor, cafeId: string) {
  const row = await tx.user.findUnique({ where: { id: actor.id }, select: { isActive: true, archivedAt: true, cafeId: true, role: true } });
  if (!row?.isActive || row.archivedAt || row.cafeId !== cafeId) throw new ApiError(403, "ليس لديك صلاحية لتنفيذ الإجراء ده");
  return row;
}

export type ConfirmDeliveryResult = { id: string; status: string; alreadyConfirmed: boolean };

/**
 * The named recipient confirms receipt from their own account. Nobody else can confirm for them:
 * not the outgoing employee, not a colleague, not another manager and — until the owner approves a
 * written proxy-confirmation exception policy — not the café owner either. (No such policy exists
 * today, and the handover manager exception covers stock acceptance, not cash receipts.) The
 * `confirmedByException` / `exceptionReason` columns therefore stay at their defaults.
 */
export async function confirmCashDelivery(args: { declarationId: string; actor: Actor; idempotencyKey: string }): Promise<ConfirmDeliveryResult> {
  if (!args.idempotencyKey || args.idempotencyKey.length > 200) throw new ApiError(400, "لازم تبعت مفتاح إعادة المحاولة");
  return protectedTransaction(async (tx) => {
    const d = await loadLockedDelivery(tx, args.declarationId, args.actor);
    await assertLiveActor(tx, args.actor, d.cafeId);
    if (d.recipientId !== args.actor.id) throw new ApiError(403, "التأكيد للمستلم المُسمّى فقط");
    if (d.status === "CONFIRMED") {
      if (d.confirmKey === args.idempotencyKey && d.confirmedById === args.actor.id) return { id: d.id, status: d.status, alreadyConfirmed: true };
      throw new ApiError(409, "التسليم ده اتأكد استلامه قبل كده");
    }
    if (d.status !== "DECLARED") throw new ApiError(409, d.status === "DISPUTED" ? "التسليم ده عليه اختلاف مُبلَّغ — يتسوّى الأول" : "التسليم ده اتقفل");
    const at = new Date();
    const moved = await tx.cashDeliveryDeclaration.updateMany({
      where: { id: d.id, status: "DECLARED" },
      data: { status: "CONFIRMED", confirmedById: args.actor.id, confirmedAt: at, confirmKey: args.idempotencyKey },
    });
    if (moved.count !== 1) throw new ApiError(409, "التسليم ده اتغير — حدّث وجرّب تاني");
    await auditInTransaction(tx, {
      cafeId: d.cafeId, userId: args.actor.id, action: CASH_DELIVERY_CONFIRMED_AUDIT_ACTION, entity: "CashDeliveryDeclaration", entityId: d.id,
      details: { shiftId: d.shiftId, dispositionId: d.dispositionId, amount: Number(d.amount), recipientId: d.recipientId, confirmedAt: at.toISOString(), idempotencyKey: args.idempotencyKey },
    });
    return { id: d.id, status: "CONFIRMED", alreadyConfirmed: false };
  });
}

/** The recipient reports that the declared delivery does not match what they received. Writes only the declaration. */
export async function disputeCashDelivery(args: { declarationId: string; actor: Actor; note: string; claimedReceivedAmount?: number | string | null }) {
  const note = args.note?.trim() ?? "";
  if (!note) throw new ApiError(400, "اكتب وصف الاختلاف");
  if (note.length > NOTE_MAX) throw new ApiError(400, "الوصف طويل جدًا");
  const claimedIn = args.claimedReceivedAmount;
  if (claimedIn !== undefined && claimedIn !== null && (!validCurrencyInput(claimedIn) || decimal(claimedIn).lt(0))) throw new ApiError(400, "المبلغ المستلم فعليًا غير صالح");
  return protectedTransaction(async (tx) => {
    const d = await loadLockedDelivery(tx, args.declarationId, args.actor);
    await assertLiveActor(tx, args.actor, d.cafeId);
    if (d.recipientId !== args.actor.id) throw new ApiError(403, "الإبلاغ عن اختلاف التسليم للمستلم المُسمّى فقط");
    if (d.status === "DISPUTED") return { id: d.id, status: d.status, alreadyDisputed: true };
    if (d.status !== "DECLARED") throw new ApiError(409, d.status === "CONFIRMED" ? "التسليم ده اتأكد استلامه — الاختلاف بعد التأكيد يتسجل كمسألة مستقلة عبر المالك" : "التسليم ده اتقفل");
    const claimed = claimedIn === undefined || claimedIn === null ? null : money(claimedIn);
    if (claimed && claimed.gt(d.amount)) throw new ApiError(400, "المبلغ المستلم فعليًا أكبر من المُعلن — اكتب الفرق في الوصف");
    const at = new Date();
    const moved = await tx.cashDeliveryDeclaration.updateMany({
      where: { id: d.id, status: "DECLARED" },
      data: { status: "DISPUTED", disputedById: args.actor.id, disputedAt: at, disputeNote: note, claimedReceivedAmount: claimed ? claimed.toNumber() : null },
    });
    if (moved.count !== 1) throw new ApiError(409, "التسليم ده اتغير — حدّث وجرّب تاني");
    await auditInTransaction(tx, {
      cafeId: d.cafeId, userId: args.actor.id, action: CASH_DELIVERY_DISPUTED_AUDIT_ACTION, entity: "CashDeliveryDeclaration", entityId: d.id,
      details: { shiftId: d.shiftId, dispositionId: d.dispositionId, declaredAmount: Number(d.amount), claimedReceivedAmount: claimed ? claimed.toNumber() : null, note, disputedAt: at.toISOString() },
    });
    return { id: d.id, status: "DISPUTED" as const, alreadyDisputed: false };
  });
}

/** The café owner closes a delivery dispute with a recorded outcome. It never edits the closed shift, the declaration or the next shift's opening. */
export async function resolveCashDeliveryDispute(args: { declarationId: string; actor: Actor; resolutionNote: string; resolvedAmount: number | string }) {
  const note = args.resolutionNote?.trim() ?? "";
  if (!note) throw new ApiError(400, "اكتب نتيجة مراجعة الاختلاف");
  if (note.length > NOTE_MAX) throw new ApiError(400, "النص طويل جدًا");
  if (!validCurrencyInput(args.resolvedAmount) || decimal(args.resolvedAmount).lt(0)) throw new ApiError(400, "المبلغ المعتمد غير صالح");
  return protectedTransaction(async (tx) => {
    const d = await loadLockedDelivery(tx, args.declarationId, args.actor);
    const actor = await assertLiveActor(tx, args.actor, d.cafeId);
    if (actor.role !== "CAFE_OWNER") throw new ApiError(403, "تسوية اختلاف التسليم للمالك فقط");
    if (d.status === "RESOLVED") return { id: d.id, status: d.status, alreadyResolved: true };
    if (d.status !== "DISPUTED") throw new ApiError(409, "مفيش اختلاف مفتوح على التسليم ده");
    const resolved = money(args.resolvedAmount);
    if (resolved.gt(d.amount)) throw new ApiError(400, "المبلغ المعتمد أكبر من المُعلن");
    const at = new Date();
    const moved = await tx.cashDeliveryDeclaration.updateMany({
      where: { id: d.id, status: "DISPUTED" },
      data: { status: "RESOLVED", resolvedById: args.actor.id, resolvedAt: at, resolutionNote: note, resolvedAmount: resolved.toNumber() },
    });
    if (moved.count !== 1) throw new ApiError(409, "التسليم ده اتغير — حدّث وجرّب تاني");
    await auditInTransaction(tx, {
      cafeId: d.cafeId, userId: args.actor.id, action: CASH_DELIVERY_RESOLVED_AUDIT_ACTION, entity: "CashDeliveryDeclaration", entityId: d.id,
      details: { shiftId: d.shiftId, declaredAmount: Number(d.amount), resolvedAmount: resolved.toNumber(), shortfall: money(decimal(d.amount).minus(resolved)).toNumber(), note, resolvedAt: at.toISOString() },
    });
    return { id: d.id, status: "RESOLVED" as const, alreadyResolved: false };
  });
}

/** Deliveries a viewer may act on: their own pending ones, and (owner) every open dispute plus every pending one. */
export async function deliveriesAwaitingViewer(client: Prisma.TransactionClient | typeof db, viewer: Actor) {
  if (!viewer.cafeId) return [];
  const rows = await client.cashDeliveryDeclaration.findMany({
    where: {
      cafeId: viewer.cafeId, status: { in: ["DECLARED", "DISPUTED"] },
      ...(viewer.role === "CAFE_OWNER" ? {} : { recipientId: viewer.id }),
    },
    orderBy: { declaredAt: "asc" },
    take: 100,
    select: {
      id: true, amount: true, destination: true, status: true, declaredAt: true, reference: true, recipientId: true, disputeNote: true, claimedReceivedAmount: true,
      recipient: { select: { name: true } }, declaredBy: { select: { name: true } },
      shift: { select: { shiftNumber: true } }, branch: { select: { name: true } },
    },
  });
  return rows.map((r) => ({
    id: r.id, amount: Number(r.amount), destination: r.destination, destinationLabel: DELIVERY_DESTINATION_LABEL[r.destination], status: r.status, statusLabel: DELIVERY_STATUS_LABEL[r.status],
    declaredAt: r.declaredAt.toISOString(), reference: r.reference, recipientId: r.recipientId, recipientName: r.recipient.name, declaredByName: r.declaredBy.name,
    shiftNumber: r.shift.shiftNumber, branchName: r.branch.name, disputeNote: r.disputeNote,
    claimedReceivedAmount: r.claimedReceivedAmount === null ? null : Number(r.claimedReceivedAmount),
    mine: r.recipientId === viewer.id,
  }));
}

// ─────────────────── what the incoming shift opens with ───────────────────

/**
 * The drawer custody a direct acceptance transfers: exactly the retained amount.
 * Called under the acceptance's handover and shift locks. Writes the incoming shift's
 * opening figures and the handover's `proposedOpeningCash`; deliberately writes no
 * `countedOpeningCash`, `cashVerifiedAt` or `cashVerifiedBy` — nobody counted or verified
 * anything here, and those columns mean exactly that.
 */
export async function recordDirectCashOpening(tx: Prisma.TransactionClient, args: { handoverId: string; incomingShiftId: string; incomingUserId: string; at: Date }) {
  const h = await tx.handoverSession.findUniqueOrThrow({ where: { id: args.handoverId }, select: { id: true, cafeId: true, branchId: true, outgoingShiftId: true } });
  const incoming = await tx.shift.findUniqueOrThrow({ where: { id: args.incomingShiftId }, select: { cafeId: true, branchId: true, status: true, custodyGateReason: true } });
  if (incoming.cafeId !== h.cafeId || incoming.branchId !== h.branchId || incoming.status !== "OPEN" || incoming.custodyGateReason !== "AWAITING_CUSTODY_TRANSFER") {
    throw new ApiError(409, "الشيفت المستلم مش منتظر استلام العهدة");
  }
  const disposition = await dispositionForShift(tx, h.outgoingShiftId);
  if (!disposition) throw new ApiError(409, "الموظف المُسلِّم لسه ما حدّدش مصير النقدية — مينفعش تستلم العهدة قبله");
  if (await tx.payment.count({ where: { shiftId: args.incomingShiftId } })) throw new ApiError(409, "الشيفت المستلم فيه حركات مالية — مينفعش تتغير بداية الدرج");
  const retained = disposition.retainedAmount;
  await tx.handoverSession.update({ where: { id: h.id }, data: { proposedOpeningCash: retained } });
  await tx.shift.update({ where: { id: args.incomingShiftId }, data: { openingCashAmount: retained, expectedCashAmount: retained } });
  await auditInTransaction(tx, {
    cafeId: h.cafeId, userId: args.incomingUserId, action: DIRECT_CASH_OPENING_AUDIT_ACTION, entity: "HandoverSession", entityId: h.id,
    details: {
      incomingShiftId: args.incomingShiftId, retainedDrawerCash: retained, countedCash: disposition.countedCash, deliveredAmount: disposition.deliveredAmount,
      pendingDeliveries: disposition.deliveries.filter((d) => d.status === "DECLARED").map((d) => ({ id: d.id, amount: d.amount, recipientId: d.recipientId })),
      acknowledgement: "DIRECT_ACKNOWLEDGEMENT", independentVerification: false,
    },
  });
  return { counted: retained, caseId: null as string | null, disposition };
}
