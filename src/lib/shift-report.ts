import { db } from "@/lib/db";
import { DEFAULT_TZ } from "@/lib/date-range";

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
  handover: null | { status: string; target: string | null; incomingName: string | null; acceptedAt: string | null };
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

  const handover = await db.handoverSession.findFirst({
    where: { outgoingShiftId: shift.id },
    orderBy: { createdAt: "desc" },
    select: { status: true, target: true, acceptedAt: true, incomingUser: { select: { name: true } } },
  });

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
    handover: handover
      ? {
          status: handover.status,
          target: handover.target,
          incomingName: handover.incomingUser?.name ?? null,
          acceptedAt: handover.acceptedAt?.toISOString() ?? null,
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
