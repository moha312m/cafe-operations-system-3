import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { DEFAULT_TZ, zonedBusinessDayStart } from "@/lib/date-range";
import { dispositionForShift, type PresentedDisposition } from "@/lib/cash-disposition";
import { decimal, money as round2, sumMoney } from "@/lib/money";
import {
  normalizePaymentEvidence,
  productRows,
  recognitionShift,
  type MoneyLeg,
  type ReportLine,
  type SaleEvent,
} from "@/lib/sales-report-math";

// The shift close report: what the drawer held against what it should have,
// what was sold, and what was handed on to the next shift. Built only from
// committed rows, after the money is settled (CLOSED or AWAITING_HANDOVER),
// so the printed page and the WhatsApp message say the same thing.

export type ShiftPaymentBreakdownRow = {
  method: "CASH" | "CARD" | "WALLET";
  sell: number;
  sellCount: number;
  refund: number;
  expense: number;
};

export type ShiftProductSoldRow = {
  sku: string | null;
  productName: string;
  variantName: string | null;
  categoryName: string | null;
  quantity: number;
  total: number;
};

export type ShiftCategorySoldRow = {
  categoryName: string;
  quantity: number;
  total: number;
};

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
  paymentBreakdown: ShiftPaymentBreakdownRow[];
  totals: {
    totalSales: number;
    totalRefund: number;
    totalPayment: number;
    creditSales: number;
    totalExpense: number;
    equation: {
      opening: number;
      sale: number;
      refund: number;
      expense: number;
      total: number;
    };
  };
  productsSold: ShiftProductSoldRow[];
  productsByCategory: ShiftCategorySoldRow[];
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
const fixed2 = (v: Prisma.Decimal | string | number) => round2(v).toFixed(2);
const SETTLED = ["CLOSED", "AWAITING_HANDOVER"];

type SnapshotLine = {
  id?: string;
  productId?: string | null;
  variantId?: string | null;
  stockProductIdSnapshot?: string | null;
  stockVariantIdSnapshot?: string | null;
  productName: string;
  variantName?: string | null;
  quantity: number;
  lineTotal: string;
  invoiceDiscountShare?: string;
  itemDiscountAmount?: string;
  voidedAt?: string | null;
};
type Snapshot = {
  status?: string;
  total: string;
  taxAmount: string;
  serviceChargeAmount: string;
  items: SnapshotLine[];
};
const asSnapshot = (s: unknown) => s as Snapshot;

/** null when the shift is not this café's, or its money is not settled yet (unless allowOpen is set). */
export async function buildShiftReport(
  shiftId: string,
  cafeId: string,
  opts?: { allowOpen?: boolean },
): Promise<ShiftReport | null> {
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
  if (!shift || (!opts?.allowOpen && !SETTLED.includes(shift.status))) return null;

  const [handover, cashDisposition, rawPayments, orders, revisions] = await Promise.all([
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
    db.payment.findMany({
      where: {
        cafeId,
        shiftId: shift.id,
        OR: [{ status: "PAID" }, { type: "COLLECTION", status: "REFUNDED" }],
      },
      include: {
        order: { select: { branchId: true, tableSessionId: true } },
        receivedBy: { select: { name: true } },
      },
    }),
    db.order.findMany({
      where: {
        cafeId,
        branchId: shift.branchId,
        status: "SERVED",
        OR: [{ saleShiftId: shift.id }, { servedShiftId: shift.id }],
      },
      include: {
        items: { where: { voidedAt: null } },
        revisions: { orderBy: { number: "asc" } },
        payments: { where: { type: "REFUND", status: "PAID", amendmentId: { not: null } } },
      },
    }),
    db.orderRevision.findMany({
      where: {
        branchId: shift.branchId,
        postingShiftId: shift.id,
        order: { cafeId, branchId: shift.branchId },
      },
      include: {
        order: { select: { createdById: true, servedById: true, saleShiftId: true, servedShiftId: true, tableSessionId: true } },
      },
    }),
  ]);

  const carriedOrders = shift.carriedOrders.map((o) => ({
    orderNumber: o.orderNumber,
    status: o.statusAtHandover,
    paymentStatus: o.paymentStatusAtHandover,
    remaining: Number(o.remainingAtHandover.toString()),
  }));
  const unpaidTotal = Math.round(carriedOrders.reduce((s, o) => s + o.remaining, 0) * 100) / 100;

  // Payment breakdown per method (CASH, CARD, WALLET)
  const legs: MoneyLeg[] = rawPayments.flatMap((p) =>
    normalizePaymentEvidence({
      status: p.status,
      id: p.id,
      orderId: p.orderId,
      at: p.paidAt.toISOString(),
      branchId: p.order.branchId,
      actorId: p.receivedById,
      actor: p.receivedBy.name,
      shiftId: p.shiftId,
      method: p.method,
      type: p.type,
      amount: fixed2(p.amount),
      sessionId: p.tableSessionId ?? p.order.tableSessionId,
    }),
  );

  const cashExpense = Number(
    round2(
      decimal(shift.totalExpensePayouts)
        .plus(shift.totalCashPayouts)
        .minus(shift.totalExpenseReturns),
    ).toFixed(2),
  );

  const methods = ["CASH", "CARD", "WALLET"] as const;
  const paymentBreakdown: ShiftPaymentBreakdownRow[] = methods.map((method) => {
    if (legs.length > 0) {
      const sellLegs = legs.filter((l) => l.method === method && l.type === "COLLECTION");
      const refundLegs = legs.filter((l) => l.method === method && l.type === "REFUND");
      return {
        method,
        sell: Number(round2(sumMoney(sellLegs.map((l) => l.amount))).toFixed(2)),
        sellCount: sellLegs.length,
        refund: Number(round2(sumMoney(refundLegs.map((l) => l.amount))).toFixed(2)),
        expense: method === "CASH" ? cashExpense : 0,
      };
    }
    const fallbackSell =
      method === "CASH"
        ? num(shift.totalCashSales)!
        : method === "CARD"
          ? num(shift.totalCardSales)!
          : num(shift.totalWalletSales)!;
    const fallbackRefund = method === "CASH" ? num(shift.totalRefunds)! : 0;
    return {
      method,
      sell: Number(round2(decimal(fallbackSell).plus(fallbackRefund)).toFixed(2)),
      sellCount: fallbackSell > 0 && method === "CASH" ? shift.orderCount : 0,
      refund: fallbackRefund,
      expense: method === "CASH" ? cashExpense : 0,
    };
  });

  const totalSales = Number(round2(sumMoney(paymentBreakdown.map((b) => fixed2(b.sell)))).toFixed(2));
  const totalRefund = Number(round2(sumMoney(paymentBreakdown.map((b) => fixed2(b.refund)))).toFixed(2));
  const totalPayment = Number(round2(decimal(totalSales).minus(totalRefund)).toFixed(2));
  const opening = num(shift.openingCashAmount)!;
  const cashBreakdown = paymentBreakdown.find((b) => b.method === "CASH")!;
  const equationTotal = Number(
    round2(
      decimal(opening)
        .plus(cashBreakdown.sell)
        .minus(cashBreakdown.refund)
        .minus(cashExpense),
    ).toFixed(2),
  );

  // Products sold & Categories sold (using canonical sales-report-math aggregation)
  const productIds = new Set<string>();
  for (const o of orders) {
    for (const l of o.items) if (l.productId) productIds.add(l.productId);
    for (const r of o.revisions) {
      for (const l of [...(asSnapshot(r.before).items ?? []), ...(asSnapshot(r.after).items ?? [])]) {
        if (l.productId) productIds.add(l.productId);
      }
    }
  }
  for (const r of revisions) {
    for (const l of [...(asSnapshot(r.before).items ?? []), ...(asSnapshot(r.after).items ?? [])]) {
      if (l.productId) productIds.add(l.productId);
    }
  }
  const catalog = productIds.size
    ? await db.product.findMany({
        where: { cafeId, id: { in: [...productIds] } },
        select: { id: true, sku: true, categoryId: true, category: { select: { name: true } } },
      })
    : [];
  const productsMap = new Map(catalog.map((p) => [p.id, p]));

  function buildLines(s: Snapshot, prefix: string, direction = 1): ReportLine[] {
    return (s.items ?? [])
      .filter((l) => !l.voidedAt)
      .map((l, index) => {
        const productId = l.productId ?? l.stockProductIdSnapshot ?? null;
        const p = productId ? productsMap.get(productId) : undefined;
        const net = decimal(l.lineTotal).minus(l.invoiceDiscountShare ?? 0);
        const discount = decimal(l.itemDiscountAmount ?? 0).plus(l.invoiceDiscountShare ?? 0);
        return {
          id: l.id ?? `${prefix}:${index}`,
          productId,
          variantId: l.variantId ?? l.stockVariantIdSnapshot ?? null,
          name: l.productName,
          variant: l.variantName ?? null,
          sku: p?.sku ?? null,
          skuSource: p ? "current" : "unmapped",
          categoryId: p?.categoryId ?? null,
          category: p?.category.name ?? null,
          quantity: l.quantity * direction,
          gross: fixed2(decimal(l.lineTotal).plus(l.itemDiscountAmount ?? 0).times(direction)),
          discount: fixed2(discount.times(direction)),
          net: fixed2(net.times(direction)),
        };
      });
  }

  const events: SaleEvent[] = orders.map((o) => {
    const first = o.revisions.find((r) => asSnapshot(r.before).status === "SERVED");
    const s = first ? asSnapshot(first.before) : asSnapshot(o);
    const preIds = new Set(o.revisions.filter((r) => asSnapshot(r.before).status !== "SERVED").map((r) => r.amendmentId));
    const preRefunds = fixed2(
      sumMoney(o.payments.filter((p) => p.amendmentId && preIds.has(p.amendmentId)).map((p) => fixed2(p.amount))),
    );
    return {
      id: `sale:${o.id}`,
      orderId: o.id,
      at: o.createdAt.toISOString(),
      branchId: o.branchId,
      creatorId: o.createdById,
      serverId: o.servedById,
      saleShiftId: o.saleShiftId,
      servedShiftId: o.servedShiftId,
      postingShiftId: null,
      sessionId: o.tableSessionId,
      revenue: fixed2(decimal(s.total).plus(preRefunds)),
      tax: fixed2(s.taxAmount),
      service: fixed2(s.serviceChargeAmount),
      lines: buildLines(s, o.id),
    };
  });

  for (const r of revisions) {
    const before = asSnapshot(r.before);
    const after = asSnapshot(r.after);
    events.push({
      id: `revision:${r.id}`,
      orderId: r.orderId,
      at: r.createdAt.toISOString(),
      branchId: r.branchId,
      creatorId: r.order.createdById,
      serverId: r.order.servedById,
      saleShiftId: r.order.saleShiftId,
      servedShiftId: r.order.servedShiftId,
      postingShiftId: r.postingShiftId,
      sessionId: r.order.tableSessionId,
      revenue: fixed2(r.recognizedDelta),
      tax: before.status === "SERVED" ? fixed2(decimal(after.taxAmount).minus(before.taxAmount)) : "0.00",
      service: before.status === "SERVED" ? fixed2(decimal(after.serviceChargeAmount).minus(before.serviceChargeAmount)) : "0.00",
      lines: before.status === "SERVED" ? [...buildLines(before, r.id, -1), ...buildLines(after, r.id)] : [],
    });
  }

  const shiftEvents = events.filter((e) => recognitionShift(e) === shift.id);
  const prodRows = productRows(shiftEvents, "product");
  const catRows = productRows(shiftEvents, "category");

  const productsSold: ShiftProductSoldRow[] = prodRows
    .map((r) => ({
      sku: r.cells.sku ?? null,
      productName: r.cells.name ?? "",
      variantName: r.cells.variant ?? null,
      categoryName: r.cells.category ?? null,
      quantity: Number(r.cells.quantity ?? 0),
      total: Number(r.cells.net ?? 0),
    }))
    .filter((r) => r.quantity !== 0 || r.total !== 0)
    .sort((a, b) => b.total - a.total || a.productName.localeCompare(b.productName, "ar"));

  const productsByCategory: ShiftCategorySoldRow[] = catRows
    .map((r) => ({
      categoryName: r.cells.name ?? "تصنيف غير مرتبط",
      quantity: Number(r.cells.quantity ?? 0),
      total: Number(r.cells.net ?? 0),
    }))
    .filter((r) => r.quantity !== 0 || r.total !== 0)
    .sort((a, b) => b.total - a.total || a.categoryName.localeCompare(b.categoryName, "ar"));

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
      opening,
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
    paymentBreakdown,
    totals: {
      totalSales,
      totalRefund,
      totalPayment,
      creditSales: unpaidTotal,
      totalExpense: cashExpense,
      equation: {
        opening,
        sale: cashBreakdown.sell,
        refund: cashBreakdown.refund,
        expense: cashExpense,
        total: equationTotal,
      },
    },
    productsSold,
    productsByCategory,
    tenders: shift.tenderReconciliations.map((t) => ({
      method: t.method,
      expected: num(t.expectedAmount)!,
      actual: num(t.actualAmount),
      variance: num(t.varianceAmount),
      reasonNote: t.reasonNote,
    })),
    carried: {
      count: carriedOrders.length,
      unpaidTotal,
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
