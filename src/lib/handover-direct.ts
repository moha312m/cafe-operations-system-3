// ── Direct handover: the incoming employee's single acknowledgement ──────
// Owner-approved flow: the outgoing and incoming employees hand over physically
// together. The outgoing employee records closing amounts and quantities and where
// the cash went; the incoming employee reviews ONE summary and presses
// «فتح ورديتي واستلام العهدة». That press is an acknowledgement of the physical handover.
// It is not a count, not a per-line signature and not an independent verification, and
// nothing here manufactures one. The branch-custody / overnight path keeps its own rules.
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/api";
import { auditInTransaction } from "@/lib/audit";
import { requestFingerprint } from "@/lib/idempotency";
import { decimal, money, validCurrencyInput } from "@/lib/money";
import { protectedContext, protectedTransaction } from "@/lib/protected-transaction";
import { acceptHandover, acceptHandoverInTransaction, handoverCountVersion, type AcceptHandoverArgs, type AcceptResult } from "@/lib/handover";
import { branchReadiness, type ShiftReadiness } from "@/lib/handover-readiness";
import { dispositionForShift, type PresentedDisposition } from "@/lib/cash-disposition";
import { resolveStaffBranchInTransaction } from "@/lib/staff-branch";
import { lockHandoverIssue, lockHandoverRow } from "@/lib/transaction-locks";

export const HANDOVER_ISSUE_REPORTED_AUDIT_ACTION = "HANDOVER_ISSUE_REPORTED";
export const HANDOVER_ISSUE_RESOLVED_AUDIT_ACTION = "HANDOVER_ISSUE_RESOLVED";

type Client = Prisma.TransactionClient | typeof db;

/**
 * The exact handover the incoming employee reviewed, as an opaque string. It covers the
 * count round and its revisions, the closing allocation (amounts and recipients — NOT the
 * confirmation states, which move independently and never change what the drawer opens
 * with), the closing cash position and the carried orders. Any change requires a refresh.
 */
export async function directReviewVersion(client: Client, handoverId: string): Promise<string> {
  const h = await client.handoverSession.findUnique({
    where: { id: handoverId },
    select: {
      id: true, status: true, target: true, stockCountSessionId: true, outgoingShiftId: true,
      outgoingShift: { select: { actualCashAmount: true, expectedCashAmount: true, cashDifference: true } },
      carriedOrders: { orderBy: { orderId: "asc" }, select: { orderId: true, remainingAtHandover: true } },
    },
  });
  if (!h) throw new ApiError(404, "التسليم مش موجود");
  const disposition = await dispositionForShift(client, h.outgoingShiftId);
  const count = h.stockCountSessionId ? await handoverCountVersion(client, h.stockCountSessionId) : null;
  return requestFingerprint({
    handover: { id: h.id, target: h.target, stockCountSessionId: h.stockCountSessionId },
    count,
    cash: { actual: h.outgoingShift.actualCashAmount?.toString() ?? null, expected: h.outgoingShift.expectedCashAmount.toString(), difference: h.outgoingShift.cashDifference?.toString() ?? null },
    disposition: disposition
      ? { fingerprint: disposition.fingerprint, retained: disposition.retainedAmount, deliveries: disposition.deliveries.map((d) => ({ id: d.id, amount: d.amount, recipientId: d.recipientId })).sort((a, b) => a.id.localeCompare(b.id)) }
      : null,
    carried: h.carriedOrders.map((o) => ({ id: o.orderId, remaining: o.remainingAtHandover.toString() })),
  });
}

export type IncomingState =
  | { state: "NONE" }                                   // the viewer has no shift yet; pressing the button opens one
  | { state: "WAITING"; shiftId: string; shiftNumber: number }
  | { state: "OPERATIONAL"; shiftId: string; shiftNumber: number }   // already running — nothing to receive
  | { state: "AMBIGUOUS"; names: string[] }
  | { state: "UNAVAILABLE"; reason: string };

export type DirectSummary = {
  handoverId: string; status: string; target: string | null; branchName: string; currency: string; timezone: string;
  outgoing: { name: string; shiftNumber: number; submittedAt: string | null };
  reviewVersion: string;
  stock: { disclosed: boolean; lines: { id: string; name: string; unit: string; quantity: number | null; expectedQuantity?: number | null; varianceQuantity?: number | null; costImpact?: number | null; costImpactAvailable?: boolean; recordedDifference: boolean }[]; notCounted: number; systemValidated: boolean };
  cash: {
    dispositionRecorded: boolean; retained: number | null; delivered: number | null;
    counted: number | null; expected: number | null; difference: number | null;
    deliveries: PresentedDisposition["deliveries"];
  };
  discrepancies: { stockLines: number; cashDifference: number | null; tenders: { method: string; variance: number | null; reason: string | null }[]; openIssues: number };
  carriedOrders: { count: number; unpaidTotal: number | null } | null;
  issues: Array<{
    id: string;
    kind: "CASH" | "STOCK_ITEM" | "OTHER";
    status: "OPEN" | "RESOLVED";
    itemNameSnapshot: string | null;
    amount: number | null;
    description: string;
    afterAcceptance: boolean;
    reportedAt: string;
    reportedByName: string;
    resolvedAt: string | null;
    resolvedByName: string | null;
    resolutionNote: string | null;
  }>;
  incoming: IncomingState;
  acknowledgement: { at: string; byName: string | null; mode: "DIRECT_ACKNOWLEDGEMENT"; independentVerification: false } | null;
  readiness: ShiftReadiness | null;
  can: { acknowledge: boolean; reportIssue: boolean; resolveIssue: boolean };
  blockers: string[];
};

const OPEN_FOR_REVIEW = ["OUTGOING_SUBMITTED", "INCOMING_REVIEW"];

export async function incomingStateFor(client: Client, h: { cafeId: string; branchId: string }, viewerId: string): Promise<IncomingState> {
  const waiting = await client.shift.findMany({
    where: { cafeId: h.cafeId, branchId: h.branchId, status: "OPEN", custodyGateReason: "AWAITING_CUSTODY_TRANSFER" },
    select: { id: true, shiftNumber: true, cashierId: true, cashier: { select: { name: true } } },
    orderBy: { shiftNumber: "asc" },
  });
  if (waiting.length > 1) return { state: "AMBIGUOUS", names: waiting.map((s) => `${s.cashier.name} (شيفت #${s.shiftNumber})`) };
  if (waiting.length === 1) {
    return waiting[0].cashierId === viewerId
      ? { state: "WAITING", shiftId: waiting[0].id, shiftNumber: waiting[0].shiftNumber }
      : { state: "UNAVAILABLE", reason: `الشيفت المنتظر للعهدة بتاع ${waiting[0].cashier.name} (شيفت #${waiting[0].shiftNumber}) — هو اللي يستلم` };
  }
  const own = await client.shift.findFirst({ where: { cafeId: h.cafeId, branchId: h.branchId, cashierId: viewerId, status: "OPEN" }, select: { id: true, shiftNumber: true, custodyGateReason: true } });
  if (own) {
    return own.custodyGateReason === null
      ? { state: "OPERATIONAL", shiftId: own.id, shiftNumber: own.shiftNumber }
      : { state: "UNAVAILABLE", reason: "شيفتك المفتوح مستني خطوة تانية غير استلام عهدة الشيفت السابق" };
  }
  return { state: "NONE" };
}

/** Everything the incoming employee reviews before the single action, as the viewer may see it. */
export async function directHandoverSummary(args: { handoverId: string; viewerId: string; cafeId: string; viewerBranchId: string | null; keys: Set<string> }): Promise<DirectSummary> {
  const { keys } = args;
  const h = await db.handoverSession.findFirst({
    where: { id: args.handoverId, cafeId: args.cafeId },
    select: {
      id: true, cafeId: true, branchId: true, status: true, target: true, submittedAt: true, stockCountSessionId: true, outgoingShiftId: true,
      directAcknowledgedAt: true, directAcknowledgedBy: { select: { name: true } },
      branch: { select: { name: true } }, outgoingUser: { select: { name: true } },
      outgoingShift: { select: { shiftNumber: true, cashDifference: true, tenderReconciliations: { select: { method: true, varianceAmount: true, reasonNote: true } } } },
      carriedOrders: { select: { remainingAtHandover: true } },
      issues: {
        orderBy: { reportedAt: "desc" },
        select: {
          id: true, kind: true, status: true, itemNameSnapshot: true, amount: true, description: true,
          afterAcceptance: true, reportedAt: true, resolutionNote: true, resolvedAt: true,
          reportedBy: { select: { name: true } }, resolvedBy: { select: { name: true } },
        },
      },
    },
  });
  if (!h) throw new ApiError(404, "التسليم مش موجود");
  if (args.viewerBranchId && h.branchId !== args.viewerBranchId) throw new ApiError(403, "ليس لديك صلاحية على فرع تاني");
  const canFinance = keys.has("shifts.view_reports");
  const canSeeStock = keys.has("handover.accept") || keys.has("handover.manage") || keys.has("handover.submit") || canFinance;
  const status = h.status;
  const directTarget = h.target === "SHIFT_TO_SHIFT";

  const [cafe, reporting, disposition, reviewVersion] = await Promise.all([
    db.cafe.findUniqueOrThrow({ where: { id: args.cafeId }, select: { currency: true } }),
    db.branchReportingVersion.findFirst({ where: { branchId: h.branchId }, orderBy: [{ effectiveDate: "desc" }, { createdAt: "desc" }], select: { timezone: true } }),
    dispositionForShift(db, h.outgoingShiftId),
    directReviewVersion(db, h.id),
  ]);

  const session = h.stockCountSessionId
    ? await db.stockCountSession.findUnique({
        where: { id: h.stockCountSessionId },
        select: { confirmedById: true, lines: { orderBy: { inventoryItem: { name: "asc" } }, select: { id: true, unit: true, disposition: true, countedQuantity: true, effectiveCountedQuantity: true, expectedQuantity: true, varianceQuantity: true, costImpact: true, costImpactAvailable: true, inventoryItem: { select: { name: true } } } } },
      })
    : null;
  const disclosed = directTarget && canSeeStock && (OPEN_FOR_REVIEW.includes(status) || status === "COMPLETED");
  const lines = (session?.lines ?? []).filter((l) => l.countedQuantity !== null || l.effectiveCountedQuantity !== null);
  const incoming = await incomingStateFor(db, h, args.viewerId);
  const readiness = (await branchReadiness(args.cafeId, h.branchId)).find((r) => (incoming.state === "WAITING" || incoming.state === "OPERATIONAL") && r.shiftId === incoming.shiftId) ?? null;

  const blockers: string[] = [];
  if (!directTarget) blockers.push("التسليم ده مش وردية لوردية — الاستلام المباشر مش متاح");
  else if (!OPEN_FOR_REVIEW.includes(status) && status !== "COMPLETED") blockers.push("الموظف المُسلِّم لسه ما قدّمش التسليم");
  if (directTarget && !disposition && !h.directAcknowledgedAt) blockers.push("الموظف المُسلِّم لسه ما حدّدش مصير النقدية");
  if (incoming.state === "AMBIGUOUS") blockers.push(`في أكتر من شيفت مستني العهدة: ${incoming.names.join("، ")} — لازم يفضل شيفت واحد بس`);
  if (incoming.state === "UNAVAILABLE") blockers.push(incoming.reason);
  if (incoming.state === "OPERATIONAL" && status !== "COMPLETED") blockers.push("عندك شيفت مفتوح بالفعل في الفرع ده");

  const canAcknowledge = blockers.length === 0 && OPEN_FOR_REVIEW.includes(status) && keys.has("handover.accept") && (incoming.state === "NONE" || incoming.state === "WAITING");
  return {
    handoverId: h.id, status, target: h.target, branchName: h.branch.name, currency: cafe.currency, timezone: reporting?.timezone ?? "Africa/Cairo",
    outgoing: { name: h.outgoingUser.name, shiftNumber: h.outgoingShift.shiftNumber, submittedAt: h.submittedAt?.toISOString() ?? null },
    reviewVersion,
    stock: {
      disclosed,
      lines: disclosed ? lines.map((l) => ({ id: l.id, name: l.inventoryItem.name, unit: l.unit, quantity: Number(l.effectiveCountedQuantity ?? l.countedQuantity), expectedQuantity: l.expectedQuantity !== null ? Number(l.expectedQuantity) : null, varianceQuantity: l.varianceQuantity !== null ? Number(l.varianceQuantity) : null, costImpact: l.costImpactAvailable && l.costImpact !== null ? Number(l.costImpact) : null, costImpactAvailable: l.costImpactAvailable, recordedDifference: l.disposition === "VARIANCE_RECORDED" || (l.varianceQuantity !== null && Number(l.varianceQuantity) !== 0) })) : [],
      notCounted: (session?.lines.length ?? 0) - lines.length,
      systemValidated: session?.confirmedById === null && !!session,
    },
    cash: {
      dispositionRecorded: !!disposition,
      retained: disposition?.retainedAmount ?? null, delivered: disposition?.deliveredAmount ?? null,
      counted: canFinance ? disposition?.countedCash ?? null : null, expected: canFinance ? disposition?.expectedCash ?? null : null,
      difference: canFinance ? disposition?.cashDifference ?? null : null,
      deliveries: disposition?.deliveries ?? [],
    },
    discrepancies: {
      stockLines: lines.filter((l) => l.disposition === "VARIANCE_RECORDED" || (l.varianceQuantity !== null && Number(l.varianceQuantity) !== 0)).length,
      cashDifference: canFinance && h.outgoingShift.cashDifference !== null ? Number(h.outgoingShift.cashDifference) : null,
      tenders: canFinance ? h.outgoingShift.tenderReconciliations.filter((t) => t.varianceAmount !== null && Number(t.varianceAmount) !== 0).map((t) => ({ method: t.method, variance: Number(t.varianceAmount), reason: t.reasonNote })) : [],
      openIssues: h.issues.filter((i) => i.status === "OPEN").length,
    },
    issues: h.issues.map((i) => ({
      id: i.id,
      kind: i.kind,
      status: i.status,
      itemNameSnapshot: i.itemNameSnapshot,
      amount: i.amount === null ? null : Number(i.amount),
      description: i.description,
      afterAcceptance: i.afterAcceptance,
      reportedAt: i.reportedAt.toISOString(),
      reportedByName: i.reportedBy.name,
      resolvedAt: i.resolvedAt?.toISOString() ?? null,
      resolvedByName: i.resolvedBy?.name ?? null,
      resolutionNote: i.resolutionNote,
    })),
    carriedOrders: h.carriedOrders.length ? { count: h.carriedOrders.length, unpaidTotal: canFinance ? money(h.carriedOrders.reduce((s, o) => s.plus(o.remainingAtHandover), decimal(0))).toNumber() : null } : null,
    incoming,
    acknowledgement: h.directAcknowledgedAt ? { at: h.directAcknowledgedAt.toISOString(), byName: h.directAcknowledgedBy?.name ?? null, mode: "DIRECT_ACKNOWLEDGEMENT", independentVerification: false } : null,
    readiness,
    can: { acknowledge: canAcknowledge, reportIssue: keys.has("handover.view") || keys.has("handover.accept"), resolveIssue: keys.has("handover.manage") },
    blockers,
  };
}

/**
 * The single action: complete the viewer's own waiting shift (the shift itself is opened by the
 * route when none exists) and accept the handover. Ambiguity is refused with who is waiting.
 */
type DirectAcceptArgs = { handoverId: string; actorId: string; cafeId: string; viewerBranchId: string | null; reviewVersion: string; idempotencyKey: string };
export const acceptDirectHandover = (args: DirectAcceptArgs) => directAccept(db, args, acceptHandover);
/** On an idempotent route's protected transaction. */
export const acceptDirectHandoverInTransaction = (tx: Prisma.TransactionClient, args: DirectAcceptArgs) => directAccept(tx, args, (a) => acceptHandoverInTransaction(tx, a));

async function directAccept(client: Client, args: DirectAcceptArgs, accept: (a: AcceptHandoverArgs) => Promise<AcceptResult>): Promise<AcceptResult> {
  if (!args.reviewVersion) throw new ApiError(400, "لازم تبعت نسخة الملخص اللي راجعته");
  const h = await client.handoverSession.findFirst({ where: { id: args.handoverId, cafeId: args.cafeId }, select: { id: true, cafeId: true, branchId: true, status: true } });
  if (!h) throw new ApiError(404, "التسليم مش موجود");
  let incomingShiftId: string | undefined;
  if (h.status !== "COMPLETED") {
    const state = await incomingStateFor(client, h, args.actorId);
    if (state.state === "AMBIGUOUS") throw new ApiError(409, `في أكتر من شيفت مستني العهدة: ${state.names.join("، ")} — لازم يفضل شيفت واحد بس قبل الاستلام`);
    if (state.state === "UNAVAILABLE") throw new ApiError(409, state.reason);
    if (state.state === "OPERATIONAL") throw new ApiError(409, "عندك شيفت مفتوح بالفعل في الفرع ده");
    if (state.state === "NONE") throw new ApiError(409, "افتح ورديتك الأول — شيفتك لسه ما اتفتحش");
    incomingShiftId = state.shiftId;
  }
  return accept({
    handoverId: args.handoverId, incomingUserId: args.actorId, incomingShiftId, idempotencyKey: args.idempotencyKey,
    cafeId: args.cafeId, viewerBranchId: args.viewerBranchId,
    direct: { reviewVersion: args.reviewVersion, computeVersion: directReviewVersion },
  });
}

// ─────────────────────────── «الإبلاغ عن اختلاف» ───────────────────────────

export type IssueInput = {
  handoverId: string; kind: "CASH" | "STOCK_ITEM" | "OTHER"; inventoryItemId?: string | null; amount?: number | string | null;
  description: string; idempotencyKey: string;
};

/**
 * Record a disagreement about a handover. Before acceptance it stays visible on the handover and
 * the report; after acceptance it is a traceable issue — a report never edits a count, a receipt
 * or an opening balance, and an incoming acknowledgement never erases an outgoing discrepancy.
 */
type ReportArgs = { actorId: string; cafeId: string; viewerBranchId: string | null; input: IssueInput };
export const reportHandoverIssue = (args: ReportArgs) => protectedTransaction((tx) => reportHandoverIssueInTransaction(tx, args));
export async function reportHandoverIssueInTransaction(tx: Prisma.TransactionClient, args: ReportArgs) {
  const { input } = args;
  const description = input.description?.trim() ?? "";
  if (!description) throw new ApiError(400, "اوصف الاختلاف");
  if (description.length > 1000) throw new ApiError(400, "الوصف طويل جدًا");
  if (!input.idempotencyKey || input.idempotencyKey.length > 200) throw new ApiError(400, "لازم تبعت مفتاح إعادة المحاولة");
  if (!["CASH", "STOCK_ITEM", "OTHER"].includes(input.kind)) throw new ApiError(400, "نوع الاختلاف غير صالح");
  if (input.kind === "CASH" && (input.amount === undefined || input.amount === null || !validCurrencyInput(input.amount) || decimal(input.amount).lt(0))) throw new ApiError(400, "اكتب مبلغ الكاش المختلف عليه (منزلتين عشريتين كحد أقصى)");
  if (input.kind === "STOCK_ITEM" && !input.inventoryItemId) throw new ApiError(400, "اختار الصنف");
  {
    await resolveStaffBranchInTransaction(tx, args.actorId);
    const h = await tx.handoverSession.findFirst({ where: { id: input.handoverId, cafeId: args.cafeId }, select: { id: true, cafeId: true, branchId: true, status: true, target: true } });
    if (!h) throw new ApiError(404, "التسليم مش موجود");
    if (args.viewerBranchId && h.branchId !== args.viewerBranchId) throw new ApiError(403, "ليس لديك صلاحية على فرع تاني");
    protectedContext(tx).scope = { cafeId: h.cafeId, branchId: h.branchId };
    await lockHandoverRow(tx, h.id);
    if (h.status === "DRAFT") throw new ApiError(409, "التسليم لسه ما اتقدمش");
    let itemName: string | null = null;
    if (input.kind === "STOCK_ITEM") {
      const item = await tx.inventoryItem.findFirst({ where: { id: input.inventoryItemId!, cafeId: h.cafeId, branchId: h.branchId }, select: { name: true } });
      if (!item) throw new ApiError(400, "الصنف مش تابع للفرع");
      itemName = item.name;
    }
    const prior = await tx.handoverIssue.findUnique({ where: { handoverId_reportedById_idempotencyKey: { handoverId: h.id, reportedById: args.actorId, idempotencyKey: input.idempotencyKey } } });
    if (prior) {
      if (prior.description !== description || prior.kind !== input.kind) throw new ApiError(409, "مفتاح الإبلاغ مستخدم لإبلاغ مختلف");
      return { id: prior.id, status: prior.status, alreadyReported: true };
    }
    const afterAcceptance = h.status === "COMPLETED";
    const row = await tx.handoverIssue.create({
      data: {
        cafeId: h.cafeId, branchId: h.branchId, handoverId: h.id, kind: input.kind,
        inventoryItemId: input.kind === "STOCK_ITEM" ? input.inventoryItemId! : null, itemNameSnapshot: itemName,
        amount: input.amount === undefined || input.amount === null ? null : money(input.amount).toNumber(),
        description, afterAcceptance, reportedById: args.actorId, idempotencyKey: input.idempotencyKey,
      },
    });
    await auditInTransaction(tx, {
      cafeId: h.cafeId, userId: args.actorId, action: HANDOVER_ISSUE_REPORTED_AUDIT_ACTION, entity: "HandoverIssue", entityId: row.id,
      details: { handoverId: h.id, kind: input.kind, inventoryItemId: row.inventoryItemId, itemName, amount: row.amount === null ? null : Number(row.amount), afterAcceptance, description },
    });
    return { id: row.id, status: row.status, alreadyReported: false };
  }
}

/** A manager/owner closes a reported issue with a recorded outcome. Nothing historical is rewritten. */
type ResolveIssueArgs = { issueId: string; actorId: string; cafeId: string; note: string };
export const resolveHandoverIssue = (args: ResolveIssueArgs) => protectedTransaction((tx) => resolveHandoverIssueInTransaction(tx, args));
export async function resolveHandoverIssueInTransaction(tx: Prisma.TransactionClient, args: ResolveIssueArgs) {
  const note = args.note?.trim() ?? "";
  if (!note) throw new ApiError(400, "اكتب نتيجة المراجعة");
  if (note.length > 1000) throw new ApiError(400, "النص طويل جدًا");
  {
    await resolveStaffBranchInTransaction(tx, args.actorId);
    const issue = await tx.handoverIssue.findFirst({ where: { id: args.issueId, cafeId: args.cafeId }, select: { id: true, cafeId: true, branchId: true, handoverId: true, status: true } });
    if (!issue) throw new ApiError(404, "الإبلاغ مش موجود");
    protectedContext(tx).scope = { cafeId: issue.cafeId, branchId: issue.branchId };
    await lockHandoverIssue(tx, issue.id);
    const fresh = await tx.handoverIssue.findUniqueOrThrow({ where: { id: issue.id }, select: { status: true } });
    if (fresh.status === "RESOLVED") return { id: issue.id, status: "RESOLVED" as const, alreadyResolved: true };
    const at = new Date();
    const moved = await tx.handoverIssue.updateMany({ where: { id: issue.id, status: "OPEN" }, data: { status: "RESOLVED", resolvedById: args.actorId, resolvedAt: at, resolutionNote: note } });
    if (moved.count !== 1) throw new ApiError(409, "الإبلاغ ده اتغير — حدّث وجرّب تاني");
    await auditInTransaction(tx, { cafeId: issue.cafeId, userId: args.actorId, action: HANDOVER_ISSUE_RESOLVED_AUDIT_ACTION, entity: "HandoverIssue", entityId: issue.id, details: { handoverId: issue.handoverId, note, resolvedAt: at.toISOString() } });
    return { id: issue.id, status: "RESOLVED" as const, alreadyResolved: false };
  }
}
