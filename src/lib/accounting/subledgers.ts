// ── Supplier and stock subledgers, as of a date (F7, G1) ─────────────
// Rebuilt from the operational tables, independently of the journal, so each
// can be reconciled against its control account: payables and supplier
// advances against supplierPosition(), inventory against
// inventoryReconciliation(). A difference is reported by name, never netted.
// Control accounts are found by stable systemKey, never by code, so an
// accountant may renumber them. `branchId` narrows both to one branch for a
// branch-scoped reader; the GL side is then the branch-dimension balance.
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { addDays, zonedDayStart, dateStrInTz } from "@/lib/date-range";
import { decimal, money, sumMoney } from "@/lib/money";
import { trialBalance } from "@/lib/accounting/ledger";

type Client = Prisma.TransactionClient | typeof db;
const BUCKETS = [{ key: "0-30", max: 30 }, { key: "31-60", max: 60 }, { key: "61-90", max: 90 }, { key: "90+", max: Infinity }] as const;
export const REFUND_DUE_BUCKET = "مستحق من المورد";
const days = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

/**
 * Open supplier items at the end of local day `asOf`:
 *   confirmed and not cancelled   payable = total - every payment so far
 *   confirmed, then cancelled     payable = -(payments after confirmation), a
 *                                 refund the supplier owes; earlier payments
 *                                 are an advance again
 *   not yet confirmed             every payment so far is an advance
 * Aged by INVOICE DATE (`ageBasis`): there are no contractual due dates yet.
 */
export async function supplierPosition(args: { cafeId: string; asOf: string; branchId?: string }, client: Client = db) {
  const end = zonedDayStart(addDays(args.asOf, 1));
  const invoices = await client.purchaseInvoice.findMany({
    where: { cafeId: args.cafeId, ...(args.branchId ? { branchId: args.branchId } : {}), createdAt: { lt: end }, OR: [{ confirmedAt: { lt: end } }, { payments: { some: { paidAt: { lt: end } } } }] },
    select: { id: true, invoiceNumber: true, branchId: true, invoiceDate: true, confirmedAt: true, cancelledAt: true, totalAmount: true, supplier: { select: { id: true, name: true } }, payments: { where: { paidAt: { lt: end } }, select: { amount: true, paidAt: true } } },
  });
  type Item = { invoiceId: string; invoiceNumber: string; branchId: string; supplierId: string | null; supplier: string | null; invoiceDate: string; open: number; ageDays: number; bucket: string };
  const items: Item[] = [];
  const advances: { invoiceId: string; invoiceNumber: string; branchId: string; supplierId: string | null; supplier: string | null; amount: number }[] = [];
  for (const inv of invoices) {
    const confirmed = inv.confirmedAt && inv.confirmedAt < end ? inv.confirmedAt : null;
    const cancelled = confirmed && inv.cancelledAt && inv.cancelledAt < end;
    const before = sumMoney(inv.payments.filter((p) => !confirmed || p.paidAt < confirmed).map((p) => p.amount));
    const after = sumMoney(inv.payments.filter((p) => confirmed && p.paidAt >= confirmed).map((p) => p.amount));
    const who = { supplierId: inv.supplier?.id ?? null, supplier: inv.supplier?.name ?? null };
    const invoiceDate = dateStrInTz(inv.invoiceDate);
    if (confirmed && !cancelled) {
      const open = money(decimal(inv.totalAmount).minus(before).minus(after));
      const ageDays = Math.max(0, days(invoiceDate, args.asOf));
      if (!open.isZero()) items.push({ invoiceId: inv.id, invoiceNumber: inv.invoiceNumber, branchId: inv.branchId, ...who, invoiceDate, open: open.toNumber(), ageDays, bucket: BUCKETS.find((b) => ageDays <= b.max)!.key });
    } else {
      if (cancelled && !after.isZero()) items.push({ invoiceId: inv.id, invoiceNumber: inv.invoiceNumber, branchId: inv.branchId, ...who, invoiceDate, open: money(after.negated()).toNumber(), ageDays: 0, bucket: REFUND_DUE_BUCKET });
      if (!before.isZero()) advances.push({ invoiceId: inv.id, invoiceNumber: inv.invoiceNumber, branchId: inv.branchId, ...who, amount: money(before).toNumber() });
    }
  }
  const byBucket = Object.fromEntries([...BUCKETS.map((b) => b.key), REFUND_DUE_BUCKET].map((k) => [k, money(sumMoney(items.filter((i) => i.bucket === k).map((i) => i.open))).toNumber()]));
  return {
    asOf: args.asOf, branchId: args.branchId ?? null, ageBasis: "invoiceDate" as const, items, advances, byBucket,
    payable: money(sumMoney(items.map((i) => i.open))).toNumber(),
    advanceTotal: money(sumMoney(advances.map((a) => a.amount))).toNumber(),
  };
}

/**
 * Inventory control account against the stock ledger at the end of `asOf`.
 * `uncostedRows` are movements the books could not value. `currentValuation`
 * is TODAY's average-cost valuation, labelled with the instant it was taken:
 * it is never an as-of figure, and `revaluation` compares it only with the
 * ledger value up to `asOf`.
 */
export async function inventoryReconciliation(args: { cafeId: string; asOf: string; branchId?: string }, client: Client = db) {
  const end = zonedDayStart(addDays(args.asOf, 1));
  const scope = { cafeId: args.cafeId, ...(args.branchId ? { branchId: args.branchId } : {}) };
  const rows = await client.inventoryTransaction.findMany({ where: { ...scope, createdAt: { lt: end } }, select: { quantity: true, totalCost: true } });
  const costed = rows.filter((r) => r.totalCost !== null && !decimal(r.quantity).isZero());
  const ledgerValue = money(sumMoney(costed.map((r) => money(r.totalCost!).abs().times(decimal(r.quantity).isPositive() ? 1 : -1))));
  const gl = (await trialBalance({ cafeId: args.cafeId, to: args.asOf, branchId: args.branchId }, client)).accounts.find((a) => a.systemKey === "INVENTORY")?.balance ?? 0;
  const items = await client.inventoryItem.findMany({ where: scope, select: { currentStock: true, costPerUnit: true } });
  const valuation = money(sumMoney(items.map((i) => decimal(i.currentStock).times(i.costPerUnit))));
  return {
    asOf: args.asOf,
    branchId: args.branchId ?? null,
    glInventory: gl,
    ledgerValue: ledgerValue.toNumber(),
    unposted: money(ledgerValue.minus(gl)).toNumber(),
    uncostedRows: rows.filter((r) => r.totalCost === null && !decimal(r.quantity).isZero()).length,
    currentValuation: valuation.toNumber(),
    currentValuationAt: new Date().toISOString(),
    revaluation: money(valuation.minus(ledgerValue)).toNumber(),
  };
}

/**
 * Read-only readiness summary across F&B operational bridges:
 *   - R365-style GL mapping completeness on ExpenseCategory
 *   - Unposted operating expenses & treasury transfers (awaiting approved posting policy)
 *   - Card/Wallet tender settlements (Toast-style close-to-deposit tracking)
 *   - Active zero-stock cutover count & core cash/clearing control balances
 */
export async function accountingBridgeReadiness(
  args: { cafeId: string; asOf: string; branchId?: string },
  client: Client = db,
) {
  const end = zonedDayStart(addDays(args.asOf, 1));
  const asOfDate = new Date(`${args.asOf}T00:00:00Z`);
  const opScope = { cafeId: args.cafeId, ...(args.branchId ? { branchId: args.branchId } : {}) };

  const [
    entity,
    activeCategories,
    mappings,
    expenses,
    expenseReturns,
    treasuryMoves,
    postedSourceEntries,
    tenderRows,
    activeItems,
    tb,
  ] = await Promise.all([
    client.accountingEntity.findUnique({ where: { cafeId: args.cafeId }, select: { id: true } }),
    client.expenseCategory.findMany({ where: { cafeId: args.cafeId, archivedAt: null }, select: { id: true } }),
    client.expenseCategoryAccountMapping.findMany({
      where: { cafeId: args.cafeId, effectiveFrom: { lte: asOfDate } },
      orderBy: [{ effectiveFrom: "desc" }, { createdAt: "desc" }],
      select: { categoryId: true, accountId: true },
    }),
    client.operatingExpense.findMany({ where: { ...opScope, occurredAt: { lt: end } }, select: { id: true } }),
    client.operatingExpenseReturn.findMany({ where: { ...opScope, occurredAt: { lt: end } }, select: { id: true } }),
    client.moneyMovement.findMany({
      where: {
        cafeId: args.cafeId,
        occurredAt: { lt: end },
        ...(args.branchId ? { account: { branchId: args.branchId } } : {}),
      },
      select: { id: true },
    }),
    client.journalEntry.findMany({
      where: {
        cafeId: args.cafeId,
        reversalOfId: null,
        entryDate: { lte: asOfDate },
        sourceType: {
          in: [
            "OPERATING_EXPENSE",
            "OPERATING_EXPENSE_RETURN",
            "TREASURY_OPENING",
            "TREASURY_TRANSFER_DISPATCH",
            "TREASURY_TRANSFER_RECEIVE",
          ],
        },
      },
      select: { sourceType: true, sourceId: true },
    }),
    client.tenderReconciliation.findMany({
      where: { ...opScope, createdAt: { lt: end } },
      select: { status: true, varianceAmount: true },
    }),
    client.inventoryItem.findMany({
      where: { ...opScope, archivedAt: null, isActive: true },
      select: { currentStock: true },
    }),
    trialBalance({ cafeId: args.cafeId, to: args.asOf, branchId: args.branchId }, client),
  ]);

  const latestByCat = new Map<string, string | null>();
  for (const m of mappings) {
    if (!latestByCat.has(m.categoryId)) latestByCat.set(m.categoryId, m.accountId);
  }
  const activeCatIds = new Set(activeCategories.map((c) => c.id));
  let mappedToday = 0;
  for (const catId of activeCatIds) {
    if (latestByCat.get(catId)) mappedToday += 1;
  }

  const postedExpenseIds = new Set(
    postedSourceEntries.filter((e) => e.sourceType === "OPERATING_EXPENSE" && e.sourceId).map((e) => e.sourceId!),
  );
  const postedReturnIds = new Set(
    postedSourceEntries.filter((e) => e.sourceType === "OPERATING_EXPENSE_RETURN" && e.sourceId).map((e) => e.sourceId!),
  );
  const postedTreasuryIds = new Set(
    postedSourceEntries
      .filter((e) => ["TREASURY_OPENING", "TREASURY_TRANSFER_DISPATCH", "TREASURY_TRANSFER_RECEIVE"].includes(e.sourceType) && e.sourceId)
      .map((e) => e.sourceId!),
  );

  let zeroStockItems = 0;
  let positiveStockItems = 0;
  for (const item of activeItems) {
    const quantity = decimal(item.currentStock);
    if (quantity.isZero()) zeroStockItems += 1;
    if (quantity.gt(0)) positiveStockItems += 1;
  }

  const draftCount = tenderRows.filter((t) => t.status === "DRAFT").length;
  const submittedCount = tenderRows.filter((t) => t.status === "SUBMITTED").length;
  const totalVariance = money(sumMoney(tenderRows.map((t) => t.varianceAmount ?? 0))).toNumber();

  const bal = (key: string) => tb.accounts.find((a) => a.systemKey === key)?.balance ?? 0;

  return {
    configured: !!entity,
    asOf: args.asOf,
    branchId: args.branchId ?? null,
    expenseCategories: {
      totalActive: activeCategories.length,
      mappedToday,
      unmappedActive: Math.max(0, activeCategories.length - mappedToday),
    },
    unpostedOperations: {
      operatingExpenses: expenses.filter((e) => !postedExpenseIds.has(e.id)).length,
      operatingExpenseReturns: expenseReturns.filter((r) => !postedReturnIds.has(r.id)).length,
      treasuryMovements: treasuryMoves.filter((m) => !postedTreasuryIds.has(m.id)).length,
    },
    tenderReconciliations: {
      total: tenderRows.length,
      draftCount,
      submittedCount,
      totalVariance,
    },
    inventoryCutover: {
      totalActiveItems: activeItems.length,
      zeroStockItems,
      positiveStockItems,
    },
    controlBalances: {
      cashDrawer: bal("CASH_DRAWER"),
      cashSafe: bal("CASH_SAFE"),
      bank: bal("BANK"),
      cardClearing: bal("CARD_CLEARING"),
      cashOverShort: bal("CASH_OVER_SHORT"),
      accountsPayable: bal("ACCOUNTS_PAYABLE"),
      supplierAdvances: bal("SUPPLIER_ADVANCES"),
      inventory: bal("INVENTORY"),
    },
  };
}
