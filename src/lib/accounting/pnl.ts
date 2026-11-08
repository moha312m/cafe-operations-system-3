// ── Executive Cafe Profit & Loss (P&L) Engine ───────────────────────────
// Built to the Odoo F&B Accounting standard:
//   Gross Sales - Discounts & Voids = Net Revenue (100% baseline)
//   Net Revenue - COGS = Gross Profit (with Gross Margin %)
//   Gross Profit - Operating Expenses (OpEx) = Operating Profit / EBITDA
//   Operating Profit - Variances & Waste = Net Profit (Bottom Line)
//
// Supports period comparison (Month-over-Month, Year-over-Year, Custom)
// and provides drill-down account metadata for every line.

import { db } from "@/lib/db";
import { money, sumMoney } from "@/lib/money";
import { trialBalance, type TrialBalanceRow } from "@/lib/accounting/ledger";
import { addDays, dateStrInTz, zonedDayStart } from "@/lib/date-range";
import { ensureAccountingEntity } from "@/lib/accounting/chart";
import { projectShadowLedger } from "@/lib/accounting/shadow-projection";

export type PnlLine = {
  accountId: string;
  code: string;
  name: string;
  systemKey: string | null;
  amount: number;
  percentOfRevenue: number;
  compareAmount?: number;
  comparePercentOfRevenue?: number;
  changeAmount?: number;
  changePercent?: number | null;
};

export type PnlSection = {
  id: string;
  title: string;
  lines: PnlLine[];
  total: number;
  percentOfRevenue: number;
  compareTotal?: number;
  comparePercentOfRevenue?: number;
  changeAmount?: number;
  changePercent?: number | null;
};

export type ExecutivePnlResult = {
  configured: boolean;
  currency: string;
  period: {
    from: string;
    to: string;
  };
  comparisonPeriod: {
    from: string;
    to: string;
  } | null;
  branchId: string | null;
  branches: { id: string; name: string }[];
  kpis: {
    grossSales: number;
    discounts: number;
    netRevenue: number;
    cogs: number;
    cogsPercent: number;
    grossProfit: number;
    grossMarginPercent: number;
    operatingExpenses: number;
    operatingExpensesPercent: number;
    operatingProfit: number;
    operatingMarginPercent: number;
    variances: number;
    netProfit: number;
    netProfitMarginPercent: number;
  };
  compareKpis?: {
    netRevenue: number;
    grossProfit: number;
    operatingExpenses: number;
    netProfit: number;
  };
  sections: {
    revenue: PnlSection;
    cogs: PnlSection;
    expenses: PnlSection;
    variances: PnlSection;
  };
};

function pct(part: number, whole: number): number {
  if (!whole || whole === 0) return 0;
  return Number(((part / whole) * 100).toFixed(1));
}

function chgPct(curr: number, prev: number): number | null {
  if (prev === 0) return curr === 0 ? 0 : null;
  return Number((((curr - prev) / Math.abs(prev)) * 100).toFixed(1));
}

async function computePeriodMetrics(cafeId: string, from: string, to: string, branchId?: string) {
  const tb = await trialBalance({ cafeId, from, to, branchId });
  const rows = tb.accounts;

  // 1. Revenue accounts (Normal CREDIT)
  const revenueRows = rows.filter((r) => r.type === "REVENUE");
  const salesLines = revenueRows
    .filter((r) => r.systemKey !== "SALES_DISCOUNTS" && r.systemKey !== "SALES_RETURNS")
    .map((r) => ({
      accountId: r.accountId,
      code: r.code,
      name: r.name,
      systemKey: r.systemKey,
      amount: r.normalBalance === "CREDIT" ? r.balance : -r.balance,
    }));

  const discountLines = revenueRows
    .filter((r) => r.systemKey === "SALES_DISCOUNTS" || r.systemKey === "SALES_RETURNS")
    .map((r) => ({
      accountId: r.accountId,
      code: r.code,
      name: r.name,
      systemKey: r.systemKey,
      amount: r.normalBalance === "DEBIT" ? r.balance : -r.balance,
    }));

  const grossSales = money(sumMoney(salesLines.map((l) => l.amount))).toNumber();
  const discounts = money(sumMoney(discountLines.map((l) => l.amount))).toNumber();
  const netRevenue = money(grossSales - discounts).toNumber();

  // Combine into unified revenue section
  const revLines: PnlLine[] = [
    ...salesLines.map((l) => ({
      ...l,
      percentOfRevenue: pct(l.amount, netRevenue),
    })),
    ...discountLines.map((l) => ({
      ...l,
      name: l.name.includes("خصم") ? l.name : `خصومات ومرتجعات: ${l.name}`,
      amount: -Math.abs(l.amount), // negative impact on revenue
      percentOfRevenue: pct(-Math.abs(l.amount), netRevenue),
    })),
  ];

  // 2. Cost of Goods Sold (COGS) (Normal DEBIT, systemKey COST_OF_SALES or purchase discounts)
  const cogsRows = rows.filter(
    (r) => r.type === "EXPENSE" && (r.systemKey === "COST_OF_SALES" || r.systemKey === "PURCHASE_DISCOUNTS")
  );
  const cogsLines: PnlLine[] = cogsRows.map((r) => {
    const amt = r.normalBalance === "DEBIT" ? r.balance : -r.balance;
    return {
      accountId: r.accountId,
      code: r.code,
      name: r.name,
      systemKey: r.systemKey,
      amount: money(amt).toNumber(),
      percentOfRevenue: pct(amt, netRevenue),
    };
  });
  const cogs = money(sumMoney(cogsLines.map((l) => l.amount))).toNumber();
  const grossProfit = money(netRevenue - cogs).toNumber();

  // 3. Operating Expenses (Normal DEBIT, excluding COGS and Variances)
  const nonOpKeys = new Set(["COST_OF_SALES", "PURCHASE_DISCOUNTS", "INVENTORY_LOSS", "CASH_OVER_SHORT"]);
  const expenseRows = rows.filter((r) => r.type === "EXPENSE" && (!r.systemKey || !nonOpKeys.has(r.systemKey)));
  const expenseLines: PnlLine[] = expenseRows.map((r) => {
    const amt = r.normalBalance === "DEBIT" ? r.balance : -r.balance;
    return {
      accountId: r.accountId,
      code: r.code,
      name: r.name,
      systemKey: r.systemKey,
      amount: money(amt).toNumber(),
      percentOfRevenue: pct(amt, netRevenue),
    };
  });
  const operatingExpenses = money(sumMoney(expenseLines.map((l) => l.amount))).toNumber();
  const operatingProfit = money(grossProfit - operatingExpenses).toNumber();

  // 4. Variances & Waste (Normal DEBIT)
  const varianceRows = rows.filter(
    (r) => r.type === "EXPENSE" && (r.systemKey === "INVENTORY_LOSS" || r.systemKey === "CASH_OVER_SHORT")
  );
  const varianceLines: PnlLine[] = varianceRows.map((r) => {
    const amt = r.normalBalance === "DEBIT" ? r.balance : -r.balance;
    return {
      accountId: r.accountId,
      code: r.code,
      name: r.name,
      systemKey: r.systemKey,
      amount: money(amt).toNumber(),
      percentOfRevenue: pct(amt, netRevenue),
    };
  });
  const variances = money(sumMoney(varianceLines.map((l) => l.amount))).toNumber();
  const netProfit = money(operatingProfit - variances).toNumber();

  return {
    raw: {
      grossSales,
      discounts,
      netRevenue,
      cogs,
      grossProfit,
      operatingExpenses,
      operatingProfit,
      variances,
      netProfit,
    },
    lines: {
      revenue: revLines,
      cogs: cogsLines,
      expenses: expenseLines,
      variances: varianceLines,
    },
  };
}

export async function getExecutivePnl(args: {
  cafeId: string;
  from: string;
  to: string;
  branchId?: string;
  compareFrom?: string;
  compareTo?: string;
  autoSync?: boolean;
}): Promise<ExecutivePnlResult> {
  // Check if books entity exists
  let entity = await db.accountingEntity.findUnique({ where: { cafeId: args.cafeId } });
  if (!entity && args.autoSync) {
    // Auto-initialize standard cafe books
    entity = await db.$transaction((tx) => ensureAccountingEntity(tx, args.cafeId));
  }

  const cafe = await db.cafe.findUnique({
    where: { id: args.cafeId },
    select: { currency: true, branches: { select: { id: true, name: true }, where: { isActive: true } } },
  });
  const currency = cafe?.currency ?? "EGP";
  const branches = cafe?.branches ?? [];

  if (!entity) {
    return {
      configured: false,
      currency,
      period: { from: args.from, to: args.to },
      comparisonPeriod: null,
      branchId: args.branchId ?? null,
      branches,
      kpis: {
        grossSales: 0,
        discounts: 0,
        netRevenue: 0,
        cogs: 0,
        cogsPercent: 0,
        grossProfit: 0,
        grossMarginPercent: 0,
        operatingExpenses: 0,
        operatingExpensesPercent: 0,
        operatingProfit: 0,
        operatingMarginPercent: 0,
        variances: 0,
        netProfit: 0,
        netProfitMarginPercent: 0,
      },
      sections: {
        revenue: { id: "revenue", title: "الإيرادات والمبيعات", lines: [], total: 0, percentOfRevenue: 0 },
        cogs: { id: "cogs", title: "تكلفة البضاعة المباعة (COGS)", lines: [], total: 0, percentOfRevenue: 0 },
        expenses: { id: "expenses", title: "المصروفات التشغيلية (OpEx)", lines: [], total: 0, percentOfRevenue: 0 },
        variances: { id: "variances", title: "الفروقات والتسويات", lines: [], total: 0, percentOfRevenue: 0 },
      },
    };
  }

  // If autoSync requested, project operational transactions up to date
  if (args.autoSync) {
    try {
      const fromDate = zonedDayStart(args.from);
      const toDate = zonedDayStart(addDays(args.to, 1));
      await projectShadowLedger({ cafeId: args.cafeId, from: fromDate, to: toDate, openMissingPeriods: true });
    } catch {
      // Non-blocking projection fallback
    }
  }

  // 1. Current Period Metrics
  const current = await computePeriodMetrics(args.cafeId, args.from, args.to, args.branchId);

  // 2. Comparison Period Metrics (if requested)
  let compare: Awaited<ReturnType<typeof computePeriodMetrics>> | null = null;
  if (args.compareFrom && args.compareTo) {
    compare = await computePeriodMetrics(args.cafeId, args.compareFrom, args.compareTo, args.branchId);
  }

  // Merge comparison figures into lines
  const mergeLines = (currList: PnlLine[], compList: PnlLine[] = [], compRev: number = 0): PnlLine[] => {
    const compMap = new Map<string, PnlLine>(compList.map((l) => [l.code || l.name, l]));
    const merged = currList.map((curr) => {
      const match = compMap.get(curr.code || curr.name);
      const compAmt = match ? match.amount : 0;
      const compPct = compRev ? pct(compAmt, compRev) : 0;
      return {
        ...curr,
        compareAmount: compAmt,
        comparePercentOfRevenue: compPct,
        changeAmount: money(curr.amount - compAmt).toNumber(),
        changePercent: chgPct(curr.amount, compAmt),
      };
    });

    // Add lines present in compare but not in current
    if (compare) {
      for (const comp of compList) {
        if (!currList.some((c) => (c.code || c.name) === (comp.code || comp.name))) {
          merged.push({
            accountId: comp.accountId,
            code: comp.code,
            name: comp.name,
            systemKey: comp.systemKey,
            amount: 0,
            percentOfRevenue: 0,
            compareAmount: comp.amount,
            comparePercentOfRevenue: compRev ? pct(comp.amount, compRev) : 0,
            changeAmount: money(0 - comp.amount).toNumber(),
            changePercent: comp.amount ? -100 : 0,
          });
        }
      }
    }
    return merged;
  };

  const compRev = compare?.raw.netRevenue ?? 0;
  const revMerged = mergeLines(current.lines.revenue, compare?.lines.revenue, compRev);
  const cogsMerged = mergeLines(current.lines.cogs, compare?.lines.cogs, compRev);
  const expMerged = mergeLines(current.lines.expenses, compare?.lines.expenses, compRev);
  const varMerged = mergeLines(current.lines.variances, compare?.lines.variances, compRev);

  const curRaw = current.raw;
  const compRaw = compare?.raw;

  return {
    configured: true,
    currency,
    period: { from: args.from, to: args.to },
    comparisonPeriod: args.compareFrom && args.compareTo ? { from: args.compareFrom, to: args.compareTo } : null,
    branchId: args.branchId ?? null,
    branches,
    kpis: {
      grossSales: curRaw.grossSales,
      discounts: curRaw.discounts,
      netRevenue: curRaw.netRevenue,
      cogs: curRaw.cogs,
      cogsPercent: pct(curRaw.cogs, curRaw.netRevenue),
      grossProfit: curRaw.grossProfit,
      grossMarginPercent: pct(curRaw.grossProfit, curRaw.netRevenue),
      operatingExpenses: curRaw.operatingExpenses,
      operatingExpensesPercent: pct(curRaw.operatingExpenses, curRaw.netRevenue),
      operatingProfit: curRaw.operatingProfit,
      operatingMarginPercent: pct(curRaw.operatingProfit, curRaw.netRevenue),
      variances: curRaw.variances,
      netProfit: curRaw.netProfit,
      netProfitMarginPercent: pct(curRaw.netProfit, curRaw.netRevenue),
    },
    compareKpis: compRaw
      ? {
          netRevenue: compRaw.netRevenue,
          grossProfit: compRaw.grossProfit,
          operatingExpenses: compRaw.operatingExpenses,
          netProfit: compRaw.netProfit,
        }
      : undefined,
    sections: {
      revenue: {
        id: "revenue",
        title: "الإيرادات والمبيعات (Revenue)",
        lines: revMerged,
        total: curRaw.netRevenue,
        percentOfRevenue: 100,
        compareTotal: compRaw?.netRevenue,
        comparePercentOfRevenue: compRaw ? 100 : undefined,
        changeAmount: compRaw ? money(curRaw.netRevenue - compRaw.netRevenue).toNumber() : undefined,
        changePercent: compRaw ? chgPct(curRaw.netRevenue, compRaw.netRevenue) : undefined,
      },
      cogs: {
        id: "cogs",
        title: "تكلفة البضاعة المباعة (COGS)",
        lines: cogsMerged,
        total: curRaw.cogs,
        percentOfRevenue: pct(curRaw.cogs, curRaw.netRevenue),
        compareTotal: compRaw?.cogs,
        comparePercentOfRevenue: compRaw ? pct(compRaw.cogs, compRaw.netRevenue) : undefined,
        changeAmount: compRaw ? money(curRaw.cogs - compRaw.cogs).toNumber() : undefined,
        changePercent: compRaw ? chgPct(curRaw.cogs, compRaw.cogs) : undefined,
      },
      expenses: {
        id: "expenses",
        title: "المصروفات التشغيلية (Operating Expenses)",
        lines: expMerged,
        total: curRaw.operatingExpenses,
        percentOfRevenue: pct(curRaw.operatingExpenses, curRaw.netRevenue),
        compareTotal: compRaw?.operatingExpenses,
        comparePercentOfRevenue: compRaw ? pct(compRaw.operatingExpenses, compRaw.netRevenue) : undefined,
        changeAmount: compRaw ? money(curRaw.operatingExpenses - compRaw.operatingExpenses).toNumber() : undefined,
        changePercent: compRaw ? chgPct(curRaw.operatingExpenses, compRaw.operatingExpenses) : undefined,
      },
      variances: {
        id: "variances",
        title: "الفروقات والتسويات (Variances)",
        lines: varMerged,
        total: curRaw.variances,
        percentOfRevenue: pct(curRaw.variances, curRaw.netRevenue),
        compareTotal: compRaw?.variances,
        comparePercentOfRevenue: compRaw ? pct(compRaw.variances, compRaw.netRevenue) : undefined,
        changeAmount: compRaw ? money(curRaw.variances - compRaw.variances).toNumber() : undefined,
        changePercent: compRaw ? chgPct(curRaw.variances, compRaw.variances) : undefined,
      },
    },
  };
}
