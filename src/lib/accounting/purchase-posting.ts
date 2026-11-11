// ── Purchases, supplier payments and stock in the shadow books (F7) ──
// Source events for projectShadowLedger(). Receiving and invoicing are kept
// apart through a clearing account, so a mismatch between what arrived and
// what was invoiced stays visible instead of being netted away:
//
//   stock row   every InventoryTransaction with a cost, at its own value:
//                 PURCHASE        Dr inventory / Cr goods received not invoiced
//                                 (Cr opening balance for the item's opening stock)
//                 USAGE, RETURN   against cost of sales
//                 WASTE, ADJUSTMENT, COUNT_REBASE   against inventory loss
//                 TRANSFER_OUT/IN through inventory in transit
//               A row without a cost is an exception: its value is unknown,
//               and guessing it from today's average would rewrite history.
//               A count rebase written before rebases carried a cost is
//               valued from the cost its count line captured when judged —
//               evidence from that day, not today's average.
//   confirm     Dr goods received not invoiced (subtotal), Dr purchase tax,
//               Cr purchase discounts, Cr payables (total); payments made
//               before confirmation move from supplier advances to payables
//   cancel      a confirmed invoice cancelled later mirrors its confirmation;
//               the stock it received stays, so the clearing account shows it
//   payment     Dr payables (or supplier advances while the invoice is not yet
//               confirmed), Cr drawer / safe / bank by its funding source. A
//               legacy payment with no recorded source is an exception — a
//               card or transfer method is not proof the money left the bank.
import type { InventoryTransactionType, Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { decimal, money, sumMoney, type Decimal } from "@/lib/money";
import type { PostingLine } from "@/lib/accounting/ledger";
import type { Candidate } from "@/lib/accounting/shadow-projection";

// The note src/app/api/inventory/route.ts writes for an item's opening stock.
const OPENING_STOCK_NOTE = "رصيد افتتاحي";

const STOCK_COUNTER: Record<InventoryTransactionType, string> = {
  PURCHASE: "GOODS_RECEIVED_NOT_INVOICED",
  USAGE: "COST_OF_SALES",
  RETURN: "COST_OF_SALES",
  WASTE: "INVENTORY_LOSS",
  ADJUSTMENT: "INVENTORY_LOSS",
  COUNT_REBASE: "INVENTORY_LOSS",
  TRANSFER_IN: "INVENTORY_IN_TRANSIT",
  TRANSFER_OUT: "INVENTORY_IN_TRANSIT",
};

const FUNDING = { DRAWER: "CASH_DRAWER", SAFE: "CASH_SAFE", BANK: "BANK" } as const;

function pair(debitKey: string, creditKey: string, signed: Decimal, branchId: string | null): PostingLine[] {
  if (signed.isZero()) return [];
  const amount = signed.abs();
  const [dr, cr] = signed.isPositive() ? [debitKey, creditKey] : [creditKey, debitKey];
  return [{ account: { key: dr }, branchId, debit: amount }, { account: { key: cr }, branchId, credit: amount }];
}

type Invoice = { id: string; invoiceNumber: string; branchId: string; confirmedAt: Date | null; subtotalAmount: Decimal; discountAmount: Decimal; taxAmount: Decimal; totalAmount: Decimal; payments: { amount: Decimal; paidAt: Date }[] };

function invoiceLines(inv: Invoice): PostingLine[] | string {
  const subtotal = money(inv.subtotalAmount), discount = money(inv.discountAmount), tax = money(inv.taxAmount), total = money(inv.totalAmount);
  if (!money(subtotal.minus(discount).plus(tax)).equals(total)) return `مكونات فاتورة الشراء مش بتساوي الإجمالي (${total.toFixed(2)})`;
  const advances = money(sumMoney(inv.payments.filter((p) => p.paidAt < inv.confirmedAt!).map((p) => p.amount)));
  const b = inv.branchId;
  return [
    { account: { key: "GOODS_RECEIVED_NOT_INVOICED" }, branchId: b, debit: subtotal },
    { account: { key: "PURCHASE_TAX" }, branchId: b, debit: tax },
    { account: { key: "PURCHASE_DISCOUNTS" }, branchId: b, credit: discount },
    { account: { key: "ACCOUNTS_PAYABLE" }, branchId: b, credit: total },
    { account: { key: "ACCOUNTS_PAYABLE" }, branchId: b, debit: advances },
    { account: { key: "SUPPLIER_ADVANCES" }, branchId: b, credit: advances },
  ].filter((l) => !decimal(l.debit ?? l.credit ?? 0).isZero());
}

const mirror = (lines: PostingLine[]): PostingLine[] => lines.map(({ debit, credit, ...rest }) => ({ ...rest, ...(debit !== undefined ? { credit: debit } : { debit: credit }) }));

/** Captured unit cost per cost-less COUNT_REBASE row, from its count line. */
async function countRebaseCosts(client: Prisma.TransactionClient | typeof db, rows: { id: string; note: string | null }[]): Promise<Map<string, Decimal>> {
  const costs = new Map<string, Decimal>();
  if (rows.length === 0) return costs;
  const rebases = await client.stockCountRebase.findMany({ where: { ledgerTransactionId: { in: rows.map((r) => r.id) } }, select: { ledgerTransactionId: true, line: { select: { unitCostSnapshot: true } } } });
  for (const r of rebases) if (r.line.unitCostSnapshot !== null && decimal(r.line.unitCostSnapshot).isPositive()) costs.set(r.ledgerTransactionId, decimal(r.line.unitCostSnapshot));
  // A handover receiving count names its acknowledgement in the note.
  const byAck = new Map(rows.flatMap((r) => { const id = r.note?.match(/^HANDOVER_RECEIVING_COUNT .*acknowledgement=(\S+)/)?.[1]; return id ? [[id, r.id] as const] : []; }));
  if (byAck.size) {
    const acks = await client.handoverStockAcknowledgement.findMany({ where: { id: { in: [...byAck.keys()] } }, select: { id: true, line: { select: { unitCostSnapshot: true } } } });
    for (const a of acks) if (a.line.unitCostSnapshot !== null && decimal(a.line.unitCostSnapshot).isPositive()) costs.set(byAck.get(a.id)!, decimal(a.line.unitCostSnapshot));
  }
  return costs;
}

export async function purchaseAndStockCandidates(client: Prisma.TransactionClient | typeof db, cafeId: string, window: { gte: Date; lt: Date }): Promise<Candidate[]> {
  const invoiceSelect = { id: true, invoiceNumber: true, branchId: true, confirmedAt: true, subtotalAmount: true, discountAmount: true, taxAmount: true, totalAmount: true, payments: { select: { amount: true, paidAt: true } } } as const;
  const [confirmed, cancelled, payments, moves] = await Promise.all([
    client.purchaseInvoice.findMany({ where: { cafeId, confirmedAt: window }, select: invoiceSelect }),
    client.purchaseInvoice.findMany({ where: { cafeId, status: "CANCELLED", confirmedAt: { not: null }, cancelledAt: window }, select: { ...invoiceSelect, cancelledAt: true } }),
    client.purchasePayment.findMany({ where: { cafeId, paidAt: window }, select: { id: true, amount: true, method: true, fundingSource: true, branchId: true, paidAt: true, invoice: { select: { invoiceNumber: true, confirmedAt: true } } } }),
    client.inventoryTransaction.findMany({ where: { cafeId, createdAt: window }, select: { id: true, type: true, quantity: true, totalCost: true, note: true, branchId: true, createdAt: true, inventoryItem: { select: { name: true } } } }),
  ]);
  const out: Candidate[] = [];
  for (const inv of confirmed) {
    out.push({ sourceType: "PURCHASE_INVOICE", sourceId: inv.id, sourceKey: `purchase-invoice:${inv.id}`, at: inv.confirmedAt!, branchId: inv.branchId, description: `فاتورة شراء ${inv.invoiceNumber}`, lines: invoiceLines(inv) });
  }
  for (const inv of cancelled) {
    const lines = invoiceLines(inv);
    out.push({ sourceType: "PURCHASE_CANCEL", sourceId: inv.id, sourceKey: `purchase-cancel:${inv.id}`, at: inv.cancelledAt!, branchId: inv.branchId, description: `إلغاء فاتورة شراء ${inv.invoiceNumber} بعد تأكيدها`, lines: typeof lines === "string" ? lines : mirror(lines) });
  }
  for (const p of payments) {
    const credit = p.fundingSource ? FUNDING[p.fundingSource] : null;
    const debit = p.invoice.confirmedAt && p.paidAt >= p.invoice.confirmedAt ? "ACCOUNTS_PAYABLE" : "SUPPLIER_ADVANCES";
    out.push({ sourceType: "SUPPLIER_PAYMENT", sourceId: p.id, sourceKey: `supplier-payment:${p.id}`, at: p.paidAt, description: `دفعة لمورد — فاتورة ${p.invoice.invoiceNumber}`,
      branchId: p.branchId, lines: credit ? pair(debit, credit, decimal(p.amount), p.branchId) : "دفعة قديمة مصدرها مش متسجل (درج ولا خزنة ولا بنك)" });
  }
  const countCost = await countRebaseCosts(client, moves.filter((m) => m.type === "COUNT_REBASE" && m.totalCost === null));
  for (const m of moves) {
    const quantity = decimal(m.quantity);
    if (quantity.isZero()) continue;
    const description = m.type === "COUNT_REBASE" ? `فرق جرد — ${m.inventoryItem.name}` : `${m.type} — ${m.inventoryItem.name}`;
    const snapshot = countCost.get(m.id);
    if (m.totalCost === null && snapshot) {
      out.push({ sourceType: "STOCK_MOVEMENT", sourceId: m.id, sourceKey: `stock:${m.id}`, at: m.createdAt, branchId: m.branchId, description, lines: pair("INVENTORY", "INVENTORY_LOSS", money(quantity.abs().times(snapshot)).times(quantity.isPositive() ? 1 : -1), m.branchId) });
      continue;
    }
    if (m.totalCost === null) { out.push({ sourceType: "STOCK_MOVEMENT", sourceId: m.id, sourceKey: `stock:${m.id}`, at: m.createdAt, branchId: m.branchId, description, lines: m.type === "COUNT_REBASE" ? "فرق جرد من غير تكلفة — الصنف ماكانش له تكلفة وقت الجرد" : "حركة مخزون من غير تكلفة" }); continue; }
    const signed = money(m.totalCost).abs().times(quantity.isPositive() ? 1 : -1);
    const counter = m.type === "PURCHASE" && m.note === OPENING_STOCK_NOTE ? "OPENING_BALANCE" : STOCK_COUNTER[m.type];
    out.push({ sourceType: "STOCK_MOVEMENT", sourceId: m.id, sourceKey: `stock:${m.id}`, at: m.createdAt, branchId: m.branchId, description, lines: pair("INVENTORY", counter, signed, m.branchId) });
  }
  return out;
}
