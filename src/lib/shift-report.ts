import { db } from "@/lib/db";
import { DEFAULT_TZ, zonedBusinessDayStart } from "@/lib/date-range";
import { dispositionForShift, type PresentedDisposition } from "@/lib/cash-disposition";

// The shift close report: what the drawer held against what it should have,
// what was sold, and what was handed on to the next shift. Built only from
// committed rows, after the money is settled (CLOSED or AWAITING_HANDOVER),
// so the printed page and the WhatsApp message say the same thing.

export type ShiftReport = {
  shiftId: string;
  shiftNumber: number;
  status: string;
  cafe: { name: string; currency: string };
  branch: { id: string; name: string };
  cashierName: string;
  closedByName: string | null;
  openedAt: string;
  closedAt: string | null;
  cash: {
    opening: number;
    expected: number;
    actual: number | null;
    difference: number | null;
    withinTolerance: boolean | null;
    tolerance: number | null;
    reasonNote: string | null;
    supplierPayouts?: number;
    expensePayouts?: number;
    expenseReturns?: number;
  };
  sales: {
    total: number; cash: number; card: number; wallet: number;
    refunds: number; discounts: number; orderCount: number;
  };
  tenders: Array<{ method: string; expected: number; actual: number | null; variance: number | null; reasonNote: string | null }>;
  carried: {
    count: number;
    unpaidTotal: number;
    orders: Array<{ orderNumber: number; status: string; paymentStatus: string; remaining: number }>;
  };
  cashDisposition: PresentedDisposition | null;
  handover: null | {
    status: string;
    target: string | null;
    incomingName: string | null;
    acceptedAt: string | null;
    directHandover: boolean;
    directAcknowledgedAt: string | null;
    directAcknowledgedByName: string | null;
    issues: Array<{
      id: string;
      kind: string;
      status: string;
      afterAcceptance: boolean;
      itemNameSnapshot: string | null;
      amount: number | null;
      description: string;
      reportedByName: string;
      reportedAt: string;
      resolutionNote: string | null;
      resolvedByName: string | null;
      resolvedAt: string | null;
    }>;
  };
};

const num = (v: { toString(): string } | null | undefined) => (v === null || v === undefined ? null : Number(v.toString()));
const SETTLED = ["CLOSED", "AWAITING_HANDOVER"];

/** null when the shift is not this café's, or its money is not settled yet. */
export async function buildShiftReport(shiftId: string, cafeId: string): Promise<ShiftReport | null> {
  const shift = await db.shift.findFirst({
    where: { id: shiftId, cafeId },
    include: {
      cafe: { select: { name: true, currency: true } },
      branch: { select: { id: true, name: true } },
      cashier: { select: { name: true } },
      closedBy: { select: { name: true } },
      tenderReconciliations: {
        orderBy: { method: "asc" },
        select: { method: true, expectedAmount: true, actualAmount: true, varianceAmount: true, reasonNote: true },
      },
      carriedOrders: {
        orderBy: { orderNumber: "asc" },
        select: { orderNumber: true, statusAtHandover: true, paymentStatusAtHandover: true, remainingAtHandover: true },
      },
    },
  });
  if (!shift || !SETTLED.includes(shift.status)) return null;

  const [handover, cashDisposition] = await Promise.all([
    db.handoverSession.findFirst({
      where: { outgoingShiftId: shift.id },
      orderBy: { createdAt: "desc" },
      select: {
        status: true,
        target: true,
        acceptedAt: true,
        directHandover: true,
        directAcknowledgedAt: true,
        incomingUser: { select: { name: true } },
        directAcknowledgedBy: { select: { name: true } },
        issues: {
          orderBy: { reportedAt: "asc" },
          include: {
            reportedBy: { select: { name: true } },
            resolvedBy: { select: { name: true } },
          },
        },
      },
    }),
    dispositionForShift(db, shift.id),
  ]);

  const carriedOrders = shift.carriedOrders.map((o) => ({
    orderNumber: o.orderNumber,
    status: o.statusAtHandover,
    paymentStatus: o.paymentStatusAtHandover,
    remaining: Number(o.remainingAtHandover.toString()),
  }));

  return {
    shiftId: shift.id,
    shiftNumber: shift.shiftNumber,
    status: shift.status,
    cafe: shift.cafe,
    branch: shift.branch,
    cashierName: shift.cashier.name,
    closedByName: shift.closedBy?.name ?? null,
    openedAt: shift.openedAt.toISOString(),
    closedAt: (shift.financiallyClosedAt ?? shift.closedAt)?.toISOString() ?? null,
    cash: {
      opening: num(shift.openingCashAmount)!,
      expected: num(shift.expectedCashAmount)!,
      actual: num(shift.actualCashAmount),
      difference: num(shift.cashDifference),
      withinTolerance: shift.cashWithinTolerance,
      tolerance: num(shift.cashToleranceAmount),
      reasonNote: shift.cashReasonNote,
      supplierPayouts: num(shift.totalCashPayouts)!,
      expensePayouts: num(shift.totalExpensePayouts)!,
      expenseReturns: num(shift.totalExpenseReturns)!,
    },
    sales: {
      total: num(shift.totalSales)!,
      cash: num(shift.totalCashSales)!,
      card: num(shift.totalCardSales)!,
      wallet: num(shift.totalWalletSales)!,
      refunds: num(shift.totalRefunds)!,
      discounts: num(shift.totalDiscounts)!,
      orderCount: shift.orderCount,
    },
    tenders: shift.tenderReconciliations.map((t) => ({
      method: t.method,
      expected: num(t.expectedAmount)!,
      actual: num(t.actualAmount),
      variance: num(t.varianceAmount),
      reasonNote: t.reasonNote,
    })),
    carried: {
      count: carriedOrders.length,
      unpaidTotal: Math.round(carriedOrders.reduce((s, o) => s + o.remaining, 0) * 100) / 100,
      orders: carriedOrders,
    },
    cashDisposition,
    handover: handover
      ? {
          status: handover.status,
          target: handover.target,
          incomingName: handover.incomingUser?.name ?? null,
          acceptedAt: handover.acceptedAt?.toISOString() ?? null,
          directHandover: handover.directHandover,
          directAcknowledgedAt: handover.directAcknowledgedAt?.toISOString() ?? null,
          directAcknowledgedByName: handover.directAcknowledgedBy?.name ?? null,
          issues: handover.issues.map((i) => ({
            id: i.id,
            kind: i.kind,
            status: i.status,
            afterAcceptance: i.afterAcceptance,
            itemNameSnapshot: i.itemNameSnapshot,
            amount: i.amount === null ? null : Number(i.amount),
            description: i.description,
            reportedByName: i.reportedBy.name,
            reportedAt: i.reportedAt.toISOString(),
            resolutionNote: i.resolutionNote,
            resolvedByName: i.resolvedBy?.name ?? null,
            resolvedAt: i.resolvedAt?.toISOString() ?? null,
          })),
        }
      : null,
  };
}

const money = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * The eight body parameters of the WhatsApp template, in order. WhatsApp
 * refuses a parameter containing a newline, a tab or more than four
 * consecutive spaces, so each is flattened to one line.
 */
export function shiftReportTemplateParams(report: ShiftReport, reportUrl: string | null): string[] {
  const c = report.cafe.currency;
  const closedAt = report.closedAt
    ? new Intl.DateTimeFormat("en-GB", {
        timeZone: DEFAULT_TZ, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
      }).format(new Date(report.closedAt))
    : "—";
  const diff = report.cash.difference;
  const diffText =
    diff === null
      ? "—"
      : `${diff > 0 ? "+" : ""}${money(diff)} ${c}${
          report.cash.withinTolerance === null ? "" : report.cash.withinTolerance ? " (داخل السماح)" : " (خارج السماح)"
        }`;
  const params = [
    report.branch.name,
    `#${report.shiftNumber} — ${report.cashierName}`,
    closedAt,
    `${money(report.sales.total)} ${c} (${report.sales.orderCount} أوردر)`,
    `${money(report.cash.expected)} / ${report.cash.actual === null ? "—" : money(report.cash.actual)} ${c}`,
    diffText,
    report.carried.count === 0
      ? "لا يوجد"
      : `${report.carried.count} أوردر — ${money(report.carried.unpaidTotal)} ${c} غير محصّل`,
    reportUrl ?? "—",
  ];
  return params.map((p) => p.replace(/\s+/g, " ").trim().slice(0, 900) || "—");
}

// ── HND-UX-004 · materials evidence on the same shift report ──
//
// The owner reviews materials where they already review money: this report.
// Built from committed rows only — the close's materials decision, the
// handover's CURRENT count round and that round's receiving signatures. The
// WhatsApp template above is untouched; this is a separate projection.
//
// Three facts stay apart: what was observed (counts and differences), whose
// custody it was (the covered shifts), and liability — which this system
// never decides. A DAILY/WEEKLY count covers every shift since the previous
// handed-over count; the difference is the PERIOD's, shown with the shifts it
// covers, and is not assigned to the shift that happened to count it.
//
// Quantities are per item in that item's own unit and are never summed
// across units. Cost appears only when the line carries a trusted impact;
// otherwise it is "not available", never zero. Expected quantities and
// differences go to oversight only (`withFigures`).

export type ShiftMaterialsReport = {
  decision: null | {
    due: boolean;
    reason: string;
    cadence: string;
    periodFrom: string | null;
    periodTo: string | null;
    coverageFrom: string | null;
    decidedAt: string;
    nextDueAt: string | null;
    satisfiedAt: string | null;
  };
  coveredShifts: Array<{ id: string; shiftNumber: number; cashierName: string; financiallyClosedAt: string | null }>;
  handover: null | {
    id: string;
    status: string;
    submittedAt: string | null;
    acceptedAt: string | null;
    outgoingName: string;
    incomingName: string | null;
    outgoingNote: string | null;
    countStatus: string | null;
    evidence: "SYSTEM_MATCH" | "OUTGOING_DECLARED" | "MANAGER_CONFIRMED" | "PENDING" | null;
  };
  lines: Array<{
    lineId: string;
    name: string;
    unit: string;
    counted: number | null;
    expected: number | null;
    difference: number | null;
    costImpact: number | null;
    costAvailable: boolean;
    note: string | null;
    hasCase: boolean;
    receiving: null | {
      decision: string;
      incomingCounted: number | null;
      handedOver: number | null;
      difference: number | null;
      acknowledgedAt: string;
      acknowledgedByName: string;
    };
  }>;
  withFigures: boolean;
};

export async function buildShiftMaterialsReport(
  shiftId: string,
  cafeId: string,
  opts: { withFigures: boolean },
): Promise<ShiftMaterialsReport> {
  const decision = await db.shiftMaterialsDecision.findFirst({
    where: { shiftId, cafeId },
    select: { due: true, reason: true, cadence: true, periodFrom: true, periodTo: true, coverageFrom: true, decidedAt: true, nextDueAt: true, satisfiedAt: true, branchId: true },
  });
  const handover = await db.handoverSession.findFirst({
    where: { outgoingShiftId: shiftId, cafeId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true, status: true, submittedAt: true, acceptedAt: true, outgoingNote: true, stockCountSessionId: true,
      directHandover: true, directAcknowledgedAt: true,
      outgoingUser: { select: { name: true } }, incomingUser: { select: { name: true } }, directAcknowledgedBy: { select: { name: true } },
    },
  });
  const session = handover?.stockCountSessionId
    ? await db.stockCountSession.findUnique({
        where: { id: handover.stockCountSessionId },
        select: {
          id: true, status: true, confirmedById: true,
          lines: {
            orderBy: { inventoryItem: { name: "asc" } },
            select: {
              id: true, unit: true, countedQuantity: true, effectiveCountedQuantity: true, expectedQuantity: true,
              varianceQuantity: true, costImpact: true, costImpactAvailable: true, reasonNote: true,
              inventoryItem: { select: { name: true } },
            },
          },
        },
      })
    : null;
  let evidence: NonNullable<ShiftMaterialsReport["handover"]>["evidence"] = null;
  if (session) {
    if (!["CONFIRMED", "LOCKED"].includes(session.status)) evidence = "PENDING";
    else if (session.confirmedById) evidence = "MANAGER_CONFIRMED";
    else {
      const audit = await db.auditLog.findFirst({
        where: { entity: "StockCountSession", entityId: session.id, action: { in: ["COUNT_SYSTEM_VALIDATED", "COUNT_OUTGOING_DECLARED"] } },
        orderBy: { createdAt: "desc" },
        select: { action: true },
      });
      evidence = audit?.action === "COUNT_SYSTEM_VALIDATED" ? "SYSTEM_MATCH" : audit ? "OUTGOING_DECLARED" : null;
    }
  }
  const lineIds = session?.lines.map((l) => l.id) ?? [];
  const [acks, cases] = session && handover
    ? await Promise.all([
        db.handoverStockAcknowledgement.findMany({
          where: { handoverId: handover.id, line: { sessionId: session.id } },
          select: {
            stockCountLineId: true, decision: true, incomingCountedQuantity: true, handedOverQuantity: true,
            varianceQuantity: true, acknowledgedAt: true, acknowledgedBy: { select: { name: true } },
          },
        }),
        db.varianceCase.findMany({ where: { stockCountLineId: { in: lineIds } }, select: { stockCountLineId: true } }),
      ])
    : [[], []];
  const ackByLine = new Map(acks.map((a) => [a.stockCountLineId, a]));
  const caseLines = new Set(cases.map((c) => c.stockCountLineId));

  // The shifts this count's observation covers: every financial close at the
  // branch since the previous handed-over count, up to this close. With no
  // earlier count on record (a branch's first scheduled count), the claimed
  // period's first business day is the honest start.
  const coverageStart = decision?.coverageFrom
    ?? (decision?.periodFrom ? zonedBusinessDayStart(decision.periodFrom, DEFAULT_TZ) : null);
  const coveredShifts = decision && coverageStart
    ? await db.shift.findMany({
        where: { cafeId, branchId: decision.branchId, financiallyClosedAt: { gt: coverageStart, lte: decision.decidedAt } },
        orderBy: { financiallyClosedAt: "asc" },
        take: 60,
        select: { id: true, shiftNumber: true, financiallyClosedAt: true, cashier: { select: { name: true } } },
      })
    : [];

  const f = opts.withFigures;
  return {
    decision: decision ? {
      due: decision.due, reason: decision.reason, cadence: decision.cadence,
      periodFrom: decision.periodFrom, periodTo: decision.periodTo,
      coverageFrom: decision.coverageFrom?.toISOString() ?? null,
      decidedAt: decision.decidedAt.toISOString(),
      nextDueAt: decision.nextDueAt?.toISOString() ?? null,
      satisfiedAt: decision.satisfiedAt?.toISOString() ?? null,
    } : null,
    coveredShifts: coveredShifts.map((s) => ({ id: s.id, shiftNumber: s.shiftNumber, cashierName: s.cashier.name, financiallyClosedAt: s.financiallyClosedAt?.toISOString() ?? null })),
    handover: handover ? {
      id: handover.id, status: handover.status,
      submittedAt: handover.submittedAt?.toISOString() ?? null,
      acceptedAt: handover.acceptedAt?.toISOString() ?? null,
      outgoingName: handover.outgoingUser.name,
      incomingName: handover.incomingUser?.name ?? null,
      outgoingNote: handover.outgoingNote,
      countStatus: session?.status ?? null,
      evidence,
    } : null,
    lines: (session?.lines ?? []).map((line) => {
      const ack = ackByLine.get(line.id);
      return {
        lineId: line.id,
        name: line.inventoryItem.name,
        unit: line.unit,
        counted: num(line.effectiveCountedQuantity ?? line.countedQuantity),
        expected: f ? num(line.expectedQuantity) : null,
        difference: f && line.countedQuantity !== null ? num(line.varianceQuantity) : null,
        costImpact: f && line.costImpactAvailable ? num(line.costImpact) : null,
        costAvailable: f && line.costImpactAvailable,
        note: line.reasonNote,
        hasCase: f && caseLines.has(line.id),
        receiving: ack ? {
          decision: ack.decision,
          incomingCounted: num(ack.incomingCountedQuantity),
          handedOver: f ? num(ack.handedOverQuantity) : null,
          difference: f ? num(ack.varianceQuantity) : null,
          acknowledgedAt: ack.acknowledgedAt.toISOString(),
          acknowledgedByName: ack.acknowledgedBy.name,
        } : handover?.directAcknowledgedAt ? {
          decision: "DIRECT_ACKNOWLEDGED",
          incomingCounted: null,
          handedOver: f ? num(line.effectiveCountedQuantity ?? line.countedQuantity) : null,
          difference: null,
          acknowledgedAt: handover.directAcknowledgedAt.toISOString(),
          acknowledgedByName: handover.directAcknowledgedBy?.name ?? handover.incomingUser?.name ?? "—",
        } : null,
      };
    }),
    withFigures: f,
  };
}
