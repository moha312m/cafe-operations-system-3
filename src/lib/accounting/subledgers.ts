// ── Supplier and stock subledgers, as of a date (F7) ─────────────────
// Rebuilt from the operational tables, independently of the journal, so each
// can be reconciled against its control account: payables and supplier
// advances against supplierPosition(), inventory against
// inventoryReconciliation(). A difference is reported by name, never netted.
import { db } from "@/lib/db";
import { addDays, zonedDayStart, dateStrInTz } from "@/lib/date-range";
import { decimal, money, sumMoney } from "@/lib/money";
import { trialBalance } from "@/lib/accounting/ledger";

const BUCKETS = [{ key: "0-30", max: 30 }, { key: "31-60", max: 60 }, { key: "61-90", max: 90 }, { key: "90+", max: Infinity }] as const;
const days = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

/**
 * Open supplier items at the end of local day `asOf`:
 *   confirmed and not cancelled   payable = total - every payment so far
 *   confirmed, then cancelled     payable = -(payments after confirmation), a
 *                                 refund the supplier owes; earlier payments
 *                                 are an advance again
 *   not yet confirmed             every payment so far is an advance
 * Aged by invoice date.
 */
export async function supplierPosition(args: { cafeId: string; asOf: string }) {
  const end = zonedDayStart(addDays(args.asOf, 1));
  const invoices = await db.purchaseInvoice.findMany({
    where: { cafeId: args.cafeId, createdAt: { lt: end }, OR: [{ confirmedAt: { lt: end } }, { payments: { some: { paidAt: { lt: end } } } }] },
    select: { id: true, invoiceNumber: true, invoiceDate: true, confirmedAt: true, cancelledAt: true, totalAmount: true, supplier: { select: { id: true, name: true } }, payments: { where: { paidAt: { lt: end } }, select: { amount: true, paidAt: true } } },
  });
  const items: { invoiceId: string; invoiceNumber: string; supplier: string | null; invoiceDate: string; open: number; ageDays: number; bucket: string }[] = [];
  const advances: { invoiceId: string; invoiceNumber: string; supplier: string | null; amount: number }[] = [];
  for (const inv of invoices) {
    const confirmed = inv.confirmedAt && inv.confirmedAt < end ? inv.confirmedAt : null;
    const cancelled = confirmed && inv.cancelledAt && inv.cancelledAt < end;
    const before = sumMoney(inv.payments.filter((p) => !confirmed || p.paidAt < confirmed).map((p) => p.amount));
    const after = sumMoney(inv.payments.filter((p) => confirmed && p.paidAt >= confirmed).map((p) => p.amount));
    const supplier = inv.supplier?.name ?? null;
    if (confirmed && !cancelled) {
      const open = money(decimal(inv.totalAmount).minus(before).minus(after));
      const invoiceDate = dateStrInTz(inv.invoiceDate), ageDays = Math.max(0, days(invoiceDate, args.asOf));
      if (!open.isZero()) items.push({ invoiceId: inv.id, invoiceNumber: inv.invoiceNumber, supplier, invoiceDate, open: open.toNumber(), ageDays, bucket: BUCKETS.find((b) => ageDays <= b.max)!.key });
    } else {
      if (cancelled && !after.isZero()) items.push({ invoiceId: inv.id, invoiceNumber: inv.invoiceNumber, supplier, invoiceDate: dateStrInTz(inv.invoiceDate), open: money(after.negated()).toNumber(), ageDays: 0, bucket: "مستحق من المورد" });
      if (!before.isZero()) advances.push({ invoiceId: inv.id, invoiceNumber: inv.invoiceNumber, supplier, amount: money(before).toNumber() });
    }
  }
  const byBucket = Object.fromEntries([...BUCKETS.map((b) => b.key), "مستحق من المورد"].map((k) => [k, money(sumMoney(items.filter((i) => i.bucket === k).map((i) => i.open))).toNumber()]));
  return {
    asOf: args.asOf, items, advances, byBucket,
    payable: money(sumMoney(items.map((i) => i.open))).toNumber(),
    advanceTotal: money(sumMoney(advances.map((a) => a.amount))).toNumber(),
  };
}

/**
 * Inventory control account against the stock ledger at the end of `asOf`.
 * `uncostedRows` are movements the books could not value (exceptions in the
 * projection); `revaluation` compares today's average-cost valuation with
 * the ledger value — rounding of unit costs and average re-pricing, named.
 */
export async function inventoryReconciliation(args: { cafeId: string; asOf: string }) {
  const end = zonedDayStart(addDays(args.asOf, 1));
  const rows = await db.inventoryTransaction.findMany({ where: { cafeId: args.cafeId, createdAt: { lt: end } }, select: { quantity: true, totalCost: true } });
  const costed = rows.filter((r) => r.totalCost !== null && !decimal(r.quantity).isZero());
  const ledgerValue = money(sumMoney(costed.map((r) => money(r.totalCost!).abs().times(decimal(r.quantity).isPositive() ? 1 : -1))));
  const gl = (await trialBalance({ cafeId: args.cafeId, to: args.asOf })).accounts.find((a) => a.code === "1200")?.balance ?? 0;
  const items = await db.inventoryItem.findMany({ where: { cafeId: args.cafeId }, select: { currentStock: true, costPerUnit: true } });
  const valuation = money(sumMoney(items.map((i) => decimal(i.currentStock).times(i.costPerUnit))));
  return {
    asOf: args.asOf,
    glInventory: gl,
    ledgerValue: ledgerValue.toNumber(),
    unposted: money(ledgerValue.minus(gl)).toNumber(),
    uncostedRows: rows.filter((r) => r.totalCost === null && !decimal(r.quantity).isZero()).length,
    currentValuation: valuation.toNumber(),
    revaluation: money(valuation.minus(ledgerValue)).toNumber(),
  };
}
