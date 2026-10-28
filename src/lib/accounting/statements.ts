// ── Financial statements and opening balances (F8) ───────────────────
// Every statement is computed from the journal alone, so it cannot disagree
// with the trial balance: the balance sheet proves itself (assets =
// liabilities + equity + earnings not yet closed), and the cash flow proves
// itself (opening cash + flows = closing cash). Amounts are signed by each
// account's normal side; a contra account (discounts, returns, purchase
// discounts) shows as a negative line of its section.
import type { Prisma } from "@prisma/client";
import { ApiError } from "@/lib/api";
import { db } from "@/lib/db";
import { addDays } from "@/lib/date-range";
import { money, sumMoney } from "@/lib/money";
import { postEntry, trialBalance, type PostingLine, type TrialBalanceRow } from "@/lib/accounting/ledger";

type Line = { code: string; name: string; amount: number };
const line = (r: TrialBalanceRow, sign: 1 | -1 = 1): Line => ({ code: r.code, name: r.name, amount: money(r.balance * sign).toNumber() });
const total = (lines: Line[]) => money(sumMoney(lines.map((l) => l.amount))).toNumber();
// A contra account's balance is on the opposite side of its section.
const signed = (r: TrialBalanceRow, sectionNormal: string) => line(r, r.normalBalance === sectionNormal ? 1 : -1);

/** Revenue less costs over [from, to]. Gross profit takes cost of sales only. */
export async function incomeStatement(args: { cafeId: string; from: string; to: string; branchId?: string }) {
  const rows = (await trialBalance(args)).accounts;
  const revenue = rows.filter((r) => r.type === "REVENUE").map((r) => signed(r, "CREDIT"));
  const costOfSales = rows.filter((r) => r.type === "EXPENSE" && r.systemKey === "COST_OF_SALES").map((r) => signed(r, "DEBIT"));
  const expenses = rows.filter((r) => r.type === "EXPENSE" && r.systemKey !== "COST_OF_SALES").map((r) => signed(r, "DEBIT"));
  const netRevenue = total(revenue), cost = total(costOfSales), otherExpenses = total(expenses);
  const grossProfit = money(netRevenue - cost).toNumber();
  return { from: args.from, to: args.to, branchId: args.branchId ?? null, revenue, netRevenue, costOfSales, grossProfit, expenses, otherExpenses, netIncome: money(grossProfit - otherExpenses).toNumber() };
}

/** Position at the end of `asOf`. Earnings to date stay a separate line until year-end closing exists. */
export async function balanceSheet(args: { cafeId: string; asOf: string }) {
  const rows = (await trialBalance({ cafeId: args.cafeId, to: args.asOf })).accounts;
  const assets = rows.filter((r) => r.type === "ASSET").map((r) => signed(r, "DEBIT"));
  const liabilities = rows.filter((r) => r.type === "LIABILITY").map((r) => signed(r, "CREDIT"));
  const equity = rows.filter((r) => r.type === "EQUITY").map((r) => signed(r, "CREDIT"));
  const income = rows.filter((r) => r.type === "REVENUE").map((r) => signed(r, "CREDIT"));
  const costs = rows.filter((r) => r.type === "EXPENSE").map((r) => signed(r, "DEBIT"));
  const earnings = money(total(income) - total(costs)).toNumber();
  const totalAssets = total(assets), totalLiabilities = total(liabilities), totalEquity = total(equity);
  return {
    asOf: args.asOf, assets, liabilities, equity, earningsToDate: earnings,
    totalAssets, totalLiabilities, totalEquity,
    balanced: money(totalAssets).equals(money(totalLiabilities + totalEquity + earnings)),
  };
}

// Cash and cash equivalents: money the café holds. Card and wallet clearing
// are amounts owed by processors, so they stay out until settled to the bank.
const CASH_KEYS = ["CASH_DRAWER", "CASH_SAFE", "BANK"];
const FLOW: Record<string, string> = {
  COLLECTION: "مقبوضات من العملاء",
  REFUND: "مرتجعات للعملاء", LEGACY_REFUND: "مرتجعات للعملاء",
  SUPPLIER_PAYMENT: "مدفوعات للموردين",
  CASH_VARIANCE: "فروقات الكاش",
};

/** Direct-method cash flow over [from, to]: each entry's net effect on cash, by what produced it. */
export async function cashFlow(args: { cafeId: string; from: string; to: string }) {
  const at = (date: string) => new Date(`${date}T00:00:00Z`);
  const cashAccounts = await db.accountingAccount.findMany({ where: { cafeId: args.cafeId, systemKey: { in: CASH_KEYS } }, select: { id: true } });
  const ids = cashAccounts.map((a) => a.id);
  const balanceUntil = async (date: string) => {
    const r = await db.journalLine.aggregate({ where: { cafeId: args.cafeId, accountId: { in: ids }, entry: { entryDate: { lt: at(date) } } }, _sum: { debit: true, credit: true } });
    return money(r._sum.debit ?? 0).minus(money(r._sum.credit ?? 0));
  };
  const entries = await db.journalEntry.findMany({
    where: { cafeId: args.cafeId, entryDate: { gte: at(args.from), lte: at(args.to) }, lines: { some: { accountId: { in: ids } } } },
    select: { sourceType: true, lines: { where: { accountId: { in: ids } }, select: { debit: true, credit: true } } },
  });
  let openingFromEntries = money(0);
  const flows = new Map<string, Prisma.Decimal>();
  for (const e of entries) {
    const net = sumMoney(e.lines.map((l) => money(l.debit).minus(l.credit)));
    if (e.sourceType === "OPENING_BALANCE") { openingFromEntries = openingFromEntries.plus(net); continue; }
    if (net.isZero()) continue; // a move between cash accounts (drawer to safe) is not a flow
    const label = FLOW[e.sourceType] ?? "أخرى";
    flows.set(label, (flows.get(label) ?? money(0)).plus(net));
  }
  const opening = (await balanceUntil(args.from)).plus(openingFromEntries);
  const closing = await balanceUntil(addDays(args.to, 1));
  const lines = [...flows].map(([label, amount]) => ({ label, amount: money(amount).toNumber() }));
  const netChange = money(sumMoney(lines.map((l) => l.amount)));
  return { from: args.from, to: args.to, opening: money(opening).toNumber(), flows: lines, netChange: netChange.toNumber(), closing: money(closing).toNumber(), balanced: money(opening.plus(netChange)).equals(money(closing)) };
}

/**
 * The accountant's signed opening balances as one entry on the cutover date.
 * Any difference is offset to the opening-balance equity account and
 * returned, so it is visible rather than silent. Only one opening entry per
 * café, and only before anything else was posted.
 */
export async function postOpeningBalances(tx: Prisma.TransactionClient, args: { cafeId: string; asOf: string; lines: PostingLine[]; actorId?: string | null }) {
  const earlier = await tx.journalEntry.count({ where: { cafeId: args.cafeId, entryDate: { lt: new Date(`${args.asOf}T00:00:00Z`) }, sourceType: { not: "OPENING_BALANCE" } } });
  if (earlier) throw new ApiError(409, "فيه قيود قبل تاريخ الأرصدة الافتتاحية");
  const debits = sumMoney(args.lines.map((l) => l.debit ?? 0)), credits = sumMoney(args.lines.map((l) => l.credit ?? 0));
  const offset = money(debits.minus(credits));
  const lines: PostingLine[] = offset.isZero() ? args.lines : [...args.lines, { account: { key: "OPENING_BALANCE" }, ...(offset.isPositive() ? { credit: offset } : { debit: offset.abs() }), memo: "فرق الأرصدة الافتتاحية" }];
  const result = await postEntry(tx, { cafeId: args.cafeId, entryDate: args.asOf, description: "الأرصدة الافتتاحية", sourceType: "OPENING_BALANCE", sourceKey: "opening-balance", lines, actorId: args.actorId });
  return { ...result, offset: offset.toNumber() };
}
