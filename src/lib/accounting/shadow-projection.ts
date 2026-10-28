// ── Shadow posting (F6) ──────────────────────────────────────────────
// Reads what operations already recorded and posts it to the café's books,
// outside every live transaction: POS, payments and shift close are not
// touched and cannot be slowed or failed by the ledger. Each source event is
// its own idempotent entry (sourceKey below), so a projection can be re-run
// over any window and posts only what is missing. An event that cannot be
// posted is returned as an exception, never skipped silently.
//
// Posting rules (customer receivable as the control account):
//   sale        Order SERVED, dated at creation (D5), valued as served:
//               Dr receivable total, Dr discounts / Cr sales subtotal,
//               Cr service revenue, Cr sales tax
//   revision    post-serve amendment, dated at the revision: the component
//               differences, after minus before, on the same accounts
//   collection  Dr drawer / card clearing / wallet clearing, Cr receivable
//   refund      Cr the tender the money left from, and Dr either
//               receivable — an amendment refund (its revision already moved
//               the bill) or money back on an order never served — or sales
//               returns — money back on a served order with no amendment,
//               which the reports count as a sales refund
//   to safe     night cash moved to the safe: Dr safe, Cr drawer; stored
//               drawer movements follow their sign (+ safe to drawer)
//   variance    counted minus expected at shift close: shortage Dr cash
//               over/short, Cr drawer; overage the reverse
// A legacy collection reversed in place (status REFUNDED, no refund row)
// posts both the receipt and the return, as the reports already count it.
// Purchases, supplier payments and stock: see purchase-posting.ts.
import type { PaymentMethod } from "@prisma/client";
import { db } from "@/lib/db";
import { dateStrInTz } from "@/lib/date-range";
import { decimal, money, type Decimal } from "@/lib/money";
import { ensureAccountingEntity } from "@/lib/accounting/chart";
import { postEntry, openPeriod, type PostingInput, type PostingLine } from "@/lib/accounting/ledger";
import { purchaseAndStockCandidates } from "@/lib/accounting/purchase-posting";

type Bill = { subtotal: string; discountAmount: string; taxAmount: string; serviceChargeAmount: string; total: string };
export type ShadowException = { sourceKey: string; sourceType: string; sourceId: string; reason: string };
export type ShadowReport = { posted: number; replayed: number; skipped: number; exceptions: ShadowException[]; bySource: Record<string, number> };

const TENDER: Partial<Record<PaymentMethod, string>> = { CASH: "CASH_DRAWER", CARD: "CARD_CLEARING", WALLET: "WALLET_CLEARING" };

const side = (key: string, amount: Decimal, normal: "debit" | "credit", branchId: string | null): PostingLine | null => {
  if (amount.isZero()) return null;
  const positive = amount.isPositive();
  const debit = normal === "debit" ? positive : !positive;
  return { account: { key }, branchId, ...(debit ? { debit: amount.abs() } : { credit: amount.abs() }) };
};

// The bill's own components; a bill whose parts do not add up to its total
// is an exception, not something to plug.
function billLines(bill: Bill, branchId: string, sign: 1 | -1, base?: Bill): PostingLine[] | string {
  const part = (k: keyof Bill) => decimal(bill[k]).minus(base ? decimal(base[k]) : 0).times(sign);
  const subtotal = part("subtotal"), discount = part("discountAmount"), service = part("serviceChargeAmount"), tax = part("taxAmount"), total = part("total");
  if (!money(subtotal.minus(discount).plus(service).plus(tax)).equals(money(total))) return `مكونات الفاتورة مش بتساوي الإجمالي (${total.toFixed(2)})`;
  return [
    side("CUSTOMER_RECEIVABLE", total, "debit", branchId),
    side("SALES_DISCOUNTS", discount, "debit", branchId),
    side("SALES", subtotal, "credit", branchId),
    side("SERVICE_REVENUE", service, "credit", branchId),
    side("SALES_TAX_PAYABLE", tax, "credit", branchId),
  ].filter((l): l is PostingLine => l !== null);
}

export type Candidate = { sourceType: string; sourceId: string; sourceKey: string; at: Date; description: string; lines: PostingLine[] | string };

async function candidates(cafeId: string, window: { gte: Date; lt: Date }): Promise<Candidate[]> {
  const [orders, revisions, payments, storages, movements, shifts] = await Promise.all([
    db.order.findMany({ where: { cafeId, status: "SERVED", createdAt: window }, select: {
      id: true, orderNumber: true, branchId: true, createdAt: true, subtotal: true, discountAmount: true, taxAmount: true, serviceChargeAmount: true, total: true,
      revisions: { where: { before: { path: ["status"], equals: "SERVED" } }, orderBy: { number: "asc" }, take: 1, select: { before: true } },
    } }),
    db.orderRevision.findMany({ where: { cafeId, createdAt: window, before: { path: ["status"], equals: "SERVED" } }, select: { id: true, orderId: true, branchId: true, createdAt: true, before: true, after: true } }),
    db.payment.findMany({ where: { cafeId, createdAt: window, OR: [{ type: "COLLECTION", status: { in: ["PAID", "REFUNDED"] } }, { type: "REFUND", status: "PAID" }] }, select: { id: true, type: true, status: true, method: true, amount: true, createdAt: true, branchId: true, amendmentId: true, order: { select: { branchId: true, orderNumber: true, status: true } } } }),
    db.cashStorage.findMany({ where: { cafeId, declaredAt: window }, select: { id: true, branchId: true, declaredAt: true, toTreasury: true } }),
    db.cashStorageMovement.findMany({ where: { cafeId, createdAt: window }, select: { id: true, amount: true, createdAt: true, storage: { select: { branchId: true } } } }),
    db.shift.findMany({ where: { cafeId, status: { in: ["CLOSED", "AWAITING_HANDOVER"] }, cashDifference: { not: null }, OR: [{ financiallyClosedAt: window }, { financiallyClosedAt: null, closedAt: window }] }, select: { id: true, shiftNumber: true, branchId: true, closedAt: true, financiallyClosedAt: true, cashDifference: true } }),
  ]);
  const out: Candidate[] = [];
  for (const o of orders) {
    const served = (o.revisions[0]?.before ?? { subtotal: o.subtotal.toString(), discountAmount: o.discountAmount.toString(), taxAmount: o.taxAmount.toString(), serviceChargeAmount: o.serviceChargeAmount.toString(), total: o.total.toString() }) as Bill;
    out.push({ sourceType: "SALE", sourceId: o.id, sourceKey: `sale:${o.id}`, at: o.createdAt, description: `بيع — طلب ${o.orderNumber}`, lines: billLines(served, o.branchId, 1) });
  }
  for (const r of revisions) {
    out.push({ sourceType: "SALE_REVISION", sourceId: r.id, sourceKey: `revision:${r.id}`, at: r.createdAt, description: "تعديل فاتورة بعد التقديم", lines: billLines(r.after as Bill, r.branchId, 1, r.before as Bill) });
  }
  for (const p of payments) {
    const branchId = p.branchId ?? p.order.branchId, tender = TENDER[p.method], amount = decimal(p.amount);
    const returned = !p.amendmentId && p.order.status === "SERVED" ? "SALES_RETURNS" : "CUSTOMER_RECEIVABLE";
    const lines = (refund: boolean): PostingLine[] | string => !tender ? `طريقة دفع ${p.method} مالهاش حساب — لازم تتقسم لأكتر من دفعة` : refund
      ? [{ account: { key: returned }, branchId, debit: amount }, { account: { key: tender }, branchId, credit: amount }]
      : [{ account: { key: tender }, branchId, debit: amount }, { account: { key: "CUSTOMER_RECEIVABLE" }, branchId, credit: amount }];
    if (p.type === "REFUND") out.push({ sourceType: "REFUND", sourceId: p.id, sourceKey: `payment:${p.id}`, at: p.createdAt, description: `مرتجع — طلب ${p.order.orderNumber}`, lines: lines(true) });
    else {
      out.push({ sourceType: "COLLECTION", sourceId: p.id, sourceKey: `payment:${p.id}`, at: p.createdAt, description: `تحصيل — طلب ${p.order.orderNumber}`, lines: lines(false) });
      if (p.status === "REFUNDED") out.push({ sourceType: "LEGACY_REFUND", sourceId: p.id, sourceKey: `payment-refund:${p.id}`, at: p.createdAt, description: `مرتجع قديم — طلب ${p.order.orderNumber}`, lines: lines(true) });
    }
  }
  for (const s of storages) {
    const amount = decimal(s.toTreasury);
    if (!amount.isZero()) out.push({ sourceType: "CASH_TO_SAFE", sourceId: s.id, sourceKey: `cash-to-safe:${s.id}`, at: s.declaredAt, description: "تحويل كاش الليل للخزنة",
      lines: [{ account: { key: "CASH_SAFE" }, branchId: s.branchId, debit: amount }, { account: { key: "CASH_DRAWER" }, branchId: s.branchId, credit: amount }] });
  }
  for (const m of movements) {
    const amount = decimal(m.amount);
    if (!amount.isZero()) out.push({ sourceType: "STORED_CASH_MOVEMENT", sourceId: m.id, sourceKey: `stored-cash:${m.id}`, at: m.createdAt, description: "حركة بين الخزنة ودرج الليل",
      lines: [side("CASH_DRAWER", amount, "debit", m.storage.branchId)!, side("CASH_SAFE", amount, "credit", m.storage.branchId)!] });
  }
  for (const s of shifts) {
    const difference = decimal(s.cashDifference!);
    if (!difference.isZero()) out.push({ sourceType: "CASH_VARIANCE", sourceId: s.id, sourceKey: `cash-variance:${s.id}`, at: (s.financiallyClosedAt ?? s.closedAt)!, description: `فرق كاش — شيفت ${s.shiftNumber}`,
      lines: [side("CASH_DRAWER", difference, "debit", s.branchId)!, side("CASH_OVER_SHORT", difference, "credit", s.branchId)!] });
  }
  // Purchases, supplier payments and stock (F7): src/lib/accounting/purchase-posting.ts.
  out.push(...await purchaseAndStockCandidates(cafeId, window));
  return out.sort((a, b) => a.at.getTime() - b.at.getTime() || a.sourceKey.localeCompare(b.sourceKey));
}

const monthOf = (date: string) => {
  const [y, m] = date.split("-").map(Number);
  return { startsOn: `${date.slice(0, 7)}-01`, endsOn: new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10) };
};

/**
 * Post every source event in [from, to) that is not yet in the books.
 * `openMissingPeriods` opens a calendar-month period for a date no period
 * covers — for shadow books only; real periods are the accountant's call.
 */
export async function projectShadowLedger(args: { cafeId: string; from: Date; to: Date; actorId?: string | null; openMissingPeriods?: boolean }): Promise<ShadowReport> {
  await db.$transaction((tx) => ensureAccountingEntity(tx, args.cafeId));
  const report: ShadowReport = { posted: 0, replayed: 0, skipped: 0, exceptions: [], bySource: {} };
  for (const c of await candidates(args.cafeId, { gte: args.from, lt: args.to })) {
    const fail = (reason: string) => report.exceptions.push({ sourceKey: c.sourceKey, sourceType: c.sourceType, sourceId: c.sourceId, reason });
    if (typeof c.lines === "string") { fail(c.lines); continue; }
    if (c.lines.length === 0) { report.skipped++; continue; } // a zero-value event moves nothing
    const entryDate = dateStrInTz(c.at);
    const input: PostingInput = { cafeId: args.cafeId, entryDate, description: c.description, sourceType: c.sourceType, sourceId: c.sourceId, sourceKey: c.sourceKey, lines: c.lines, actorId: args.actorId ?? null };
    try {
      if (args.openMissingPeriods) {
        const covered = await db.accountingPeriod.count({ where: { cafeId: args.cafeId, startsOn: { lte: new Date(`${entryDate}T00:00:00Z`) }, endsOn: { gte: new Date(`${entryDate}T00:00:00Z`) } } });
        if (!covered) await db.$transaction((tx) => openPeriod(tx, { cafeId: args.cafeId, ...monthOf(entryDate) }));
      }
      const result = await db.$transaction((tx) => postEntry(tx, input));
      if (result.replayed) report.replayed++; else report.posted++;
      report.bySource[c.sourceType] = (report.bySource[c.sourceType] ?? 0) + 1;
    } catch (error) {
      const status = (error as { status?: number }).status;
      fail(status === 409 && /مختلف/.test((error as Error).message) ? "المصدر اتغير بعد ما اترحّل — محتاج مراجعة" : (error as Error).message);
    }
  }
  return report;
}

/**
 * What a projection over [from, to) would still have to do, without posting:
 * events not yet in the books, and events that cannot be posted at all. The
 * period-close checklist uses it. An event already posted whose source
 * changed since is not detected here; a projection run reports it.
 */
export async function shadowCoverage(args: { cafeId: string; from: Date; to: Date }) {
  const all = await candidates(args.cafeId, { gte: args.from, lt: args.to });
  const exceptions = all.flatMap((c) => (typeof c.lines === "string" ? [{ sourceKey: c.sourceKey, sourceType: c.sourceType, sourceId: c.sourceId, reason: c.lines }] : []));
  const postable = all.filter((c) => typeof c.lines !== "string" && c.lines.length > 0);
  const posted = new Set((await db.journalEntry.findMany({ where: { cafeId: args.cafeId, sourceKey: { in: postable.map((c) => c.sourceKey) } }, select: { sourceKey: true } })).map((e) => e.sourceKey));
  const missing = postable.filter((c) => !posted.has(c.sourceKey)).map((c) => ({ sourceKey: c.sourceKey, sourceType: c.sourceType, sourceId: c.sourceId }));
  return { events: postable.length, posted: posted.size, missing, exceptions };
}

