// ── Shadow posting (F6, G1) ──────────────────────────────────────────
// Reads what operations already recorded and posts it to the café's books,
// outside every live transaction: POS, payments and shift close are not
// touched and cannot be slowed or failed by the ledger. Each source event is
// its own idempotent entry (sourceKey below), so a projection can be re-run
// over any window and posts only what is missing. Every run is recorded, and
// every event that cannot be posted, has changed since it was posted, has
// disappeared, or belongs to a closed period is kept as an issue until a
// later run over the same window no longer sees it.
//
// Event time comes from immutable evidence, never from today's status:
//   sale        Order.servedAt (when the customer got it). A legacy SERVED
//               order without servedAt falls back to its creation time and
//               the fallback is reported (ASSUMED_DATE warning).
//               Dr receivable total, Dr discounts / Cr sales subtotal,
//               Cr service revenue, Cr sales tax; money taken before serving
//               moves from customer advances to the receivable.
//   revision    post-serve amendment, at the revision: component differences
//   collection  Dr drawer / card / wallet clearing; Cr customer advances if
//               taken before the order was served (or it never was), else
//               Cr receivable
//   refund      Cr the tender; Dr customer advances before serving, Dr
//               receivable for an amendment refund after serving (its
//               revision already moved the bill), else Dr sales returns —
//               the operational reports' "sales refund"
//   legacy      a collection reversed in place (status REFUNDED, no refund
//               row) has no refund time: its receipt posts, its return is an
//               exception until someone supplies the date
//   to safe     night cash moved to the safe: Dr safe, Cr drawer; stored
//               drawer movements follow their sign (+ safe to drawer)
//   variance    counted minus expected at shift close: shortage Dr cash
//               over/short, Cr drawer; overage the reverse
// Purchases, supplier payments and stock: see purchase-posting.ts.
//
// Bridge to the operational reports: they date a sale at order creation and
// never split advances; the books date it at serving. The accounting
// overview reports that timing difference rather than hiding it.
import type { PaymentMethod, Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { dateStrInTz, zonedDayStart, addDays } from "@/lib/date-range";
import { decimal, money, sumMoney, type Decimal } from "@/lib/money";
import { ensureAccountingEntity } from "@/lib/accounting/chart";
import { postEntry, openPeriod, preparePosting, type PostingInput, type PostingLine } from "@/lib/accounting/ledger";
import { expenseSourceKey } from "@/lib/expense-rules";
import { purchaseAndStockCandidates } from "@/lib/accounting/purchase-posting";

type Client = Prisma.TransactionClient | typeof db;
type Bill = { subtotal: string; discountAmount: string; taxAmount: string; serviceChargeAmount: string; total: string };
export type ShadowException = { sourceKey: string; sourceType: string; sourceId: string; reason: string };
export type ShadowReport = { runId: string; posted: number; replayed: number; skipped: number; exceptions: ShadowException[]; warnings: ShadowException[]; bySource: Record<string, number> };
export type Candidate = { sourceType: string; sourceId: string; sourceKey: string; at: Date; branchId: string | null; description: string; lines: PostingLine[] | string; warning?: string };

/** Source types this projector owns; used to find posted events that disappeared. */
export const SHADOW_SOURCE_TYPES = ["SALE", "SALE_REVISION", "COLLECTION", "REFUND", "LEGACY_REFUND", "CASH_TO_SAFE", "STORED_CASH_MOVEMENT", "CASH_VARIANCE", "PURCHASE_INVOICE", "PURCHASE_CANCEL", "SUPPLIER_PAYMENT", "STOCK_MOVEMENT", "OPERATING_EXPENSE", "OPERATING_EXPENSE_RETURN", "TREASURY_OPENING", "TREASURY_TRANSFER_DISPATCH", "TREASURY_TRANSFER_RECEIVE"];

const TENDER: Partial<Record<PaymentMethod, string>> = { CASH: "CASH_DRAWER", CARD: "CARD_CLEARING", WALLET: "WALLET_CLEARING" };

export const side = (key: string, amount: Decimal, normal: "debit" | "credit", branchId: string | null): PostingLine | null => {
  if (amount.isZero()) return null;
  const positive = amount.isPositive();
  const debit = normal === "debit" ? positive : !positive;
  return { account: { key }, branchId, ...(debit ? { debit: amount.abs() } : { credit: amount.abs() }) };
};

// The bill's own components; a bill whose parts do not add up to its total
// is an exception, not something to plug.
function billLines(bill: Bill, branchId: string, base?: Bill): PostingLine[] | string {
  const part = (k: keyof Bill) => decimal(bill[k]).minus(base ? decimal(base[k]) : 0);
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

/** The instant an order was served, from evidence; null if it never was. */
const servedInstant = (o: { status: string; servedAt: Date | null; createdAt: Date }) => o.servedAt ?? (o.status === "SERVED" ? o.createdAt : null);

export async function candidates(client: Client, cafeId: string, window: { gte: Date; lt: Date }, valueLegacyCountRebases = false): Promise<Candidate[]> {
  const [orders, revisions, payments, storages, movements, shifts] = await Promise.all([
    client.order.findMany({ where: { cafeId, status: "SERVED", OR: [{ servedAt: window }, { servedAt: null, createdAt: window }] }, select: {
      id: true, orderNumber: true, branchId: true, status: true, createdAt: true, servedAt: true, subtotal: true, discountAmount: true, taxAmount: true, serviceChargeAmount: true, total: true,
      revisions: { where: { before: { path: ["status"], equals: "SERVED" } }, orderBy: { number: "asc" }, take: 1, select: { before: true } },
      payments: { where: { OR: [{ type: "COLLECTION", status: { in: ["PAID", "REFUNDED"] } }, { type: "REFUND", status: "PAID" }] }, select: { type: true, amount: true, createdAt: true } },
    } }),
    client.orderRevision.findMany({ where: { cafeId, createdAt: window, before: { path: ["status"], equals: "SERVED" } }, select: { id: true, orderId: true, branchId: true, createdAt: true, before: true, after: true } }),
    client.payment.findMany({ where: { cafeId, createdAt: window, OR: [{ type: "COLLECTION", status: { in: ["PAID", "REFUNDED"] } }, { type: "REFUND", status: "PAID" }] }, select: { id: true, type: true, status: true, method: true, amount: true, createdAt: true, branchId: true, amendmentId: true, order: { select: { branchId: true, orderNumber: true, status: true, servedAt: true, createdAt: true } } } }),
    client.cashStorage.findMany({ where: { cafeId, declaredAt: window }, select: { id: true, branchId: true, declaredAt: true, toTreasury: true } }),
    client.cashStorageMovement.findMany({ where: { cafeId, createdAt: window }, select: { id: true, amount: true, createdAt: true, storage: { select: { branchId: true } } } }),
    client.shift.findMany({ where: { cafeId, status: { in: ["CLOSED", "AWAITING_HANDOVER"] }, cashDifference: { not: null }, OR: [{ financiallyClosedAt: window }, { financiallyClosedAt: null, closedAt: window }] }, select: { id: true, shiftNumber: true, branchId: true, closedAt: true, financiallyClosedAt: true, cashDifference: true } }),
  ]);
  const out: Candidate[] = [];
  for (const o of orders) {
    const at = servedInstant(o)!;
    const served = (o.revisions[0]?.before ?? { subtotal: o.subtotal.toString(), discountAmount: o.discountAmount.toString(), taxAmount: o.taxAmount.toString(), serviceChargeAmount: o.serviceChargeAmount.toString(), total: o.total.toString() }) as Bill;
    const bill = billLines(served, o.branchId);
    // Money taken before serving was a customer advance; serving applies it.
    const before = o.payments.filter((p) => p.createdAt < at);
    const advance = sumMoney(before.map((p) => (p.type === "REFUND" ? decimal(p.amount).negated() : decimal(p.amount))));
    const lines = typeof bill === "string" ? bill : [...bill, side("CUSTOMER_CREDIT", advance, "debit", o.branchId), side("CUSTOMER_RECEIVABLE", advance, "credit", o.branchId)].filter((l): l is PostingLine => l !== null);
    out.push({ sourceType: "SALE", sourceId: o.id, sourceKey: `sale:${o.id}`, at, branchId: o.branchId, description: `بيع — طلب ${o.orderNumber}`, lines,
      warning: o.servedAt ? undefined : "وقت التقديم مش متسجل — اتاخد وقت إنشاء الطلب" });
  }
  for (const r of revisions) {
    out.push({ sourceType: "SALE_REVISION", sourceId: r.id, sourceKey: `revision:${r.id}`, at: r.createdAt, branchId: r.branchId, description: "تعديل فاتورة بعد التقديم", lines: billLines(r.after as Bill, r.branchId, r.before as Bill) });
  }
  for (const p of payments) {
    const branchId = p.branchId ?? p.order.branchId, tender = TENDER[p.method], amount = decimal(p.amount);
    const servedAt = servedInstant(p.order);
    const beforeServing = !servedAt || p.createdAt < servedAt;
    const noTender = `طريقة دفع ${p.method} مالهاش حساب — لازم تتقسم لأكتر من دفعة`;
    if (p.type === "REFUND") {
      const debit = beforeServing ? "CUSTOMER_CREDIT" : p.amendmentId ? "CUSTOMER_RECEIVABLE" : "SALES_RETURNS";
      out.push({ sourceType: "REFUND", sourceId: p.id, sourceKey: `payment:${p.id}`, at: p.createdAt, branchId, description: `مرتجع — طلب ${p.order.orderNumber}`,
        lines: tender ? [{ account: { key: debit }, branchId, debit: amount }, { account: { key: tender }, branchId, credit: amount }] : noTender });
      continue;
    }
    const credit = beforeServing ? "CUSTOMER_CREDIT" : "CUSTOMER_RECEIVABLE";
    out.push({ sourceType: "COLLECTION", sourceId: p.id, sourceKey: `payment:${p.id}`, at: p.createdAt, branchId, description: `تحصيل — طلب ${p.order.orderNumber}`,
      lines: tender ? [{ account: { key: tender }, branchId, debit: amount }, { account: { key: credit }, branchId, credit: amount }] : noTender });
    if (p.status === "REFUNDED") out.push({ sourceType: "LEGACY_REFUND", sourceId: p.id, sourceKey: `payment-refund:${p.id}`, at: p.createdAt, branchId, description: `مرتجع قديم — طلب ${p.order.orderNumber}`,
      lines: "مرتجع قديم اتسجل على نفس الدفعة ومن غير تاريخ — محتاج تاريخ المرتجع الفعلي" });
  }
  for (const s of storages) {
    const amount = decimal(s.toTreasury);
    if (!amount.isZero()) out.push({ sourceType: "CASH_TO_SAFE", sourceId: s.id, sourceKey: `cash-to-safe:${s.id}`, at: s.declaredAt, branchId: s.branchId, description: "تحويل كاش الليل للخزنة",
      lines: [{ account: { key: "CASH_SAFE" }, branchId: s.branchId, debit: amount }, { account: { key: "CASH_DRAWER" }, branchId: s.branchId, credit: amount }] });
  }
  for (const m of movements) {
    const amount = decimal(m.amount);
    if (!amount.isZero()) out.push({ sourceType: "STORED_CASH_MOVEMENT", sourceId: m.id, sourceKey: `stored-cash:${m.id}`, at: m.createdAt, branchId: m.storage.branchId, description: "حركة بين الخزنة ودرج الليل",
      lines: [side("CASH_DRAWER", amount, "debit", m.storage.branchId)!, side("CASH_SAFE", amount, "credit", m.storage.branchId)!] });
  }
  for (const s of shifts) {
    const difference = decimal(s.cashDifference!);
    if (!difference.isZero()) out.push({ sourceType: "CASH_VARIANCE", sourceId: s.id, sourceKey: `cash-variance:${s.id}`, at: (s.financiallyClosedAt ?? s.closedAt)!, branchId: s.branchId, description: `فرق كاش — شيفت ${s.shiftNumber}`,
      lines: [side("CASH_DRAWER", difference, "debit", s.branchId)!, side("CASH_OVER_SHORT", difference, "credit", s.branchId)!] });
  }
  // ACC-01A captures source evidence but intentionally does not activate posting.
  // Both coverage and projection consume these candidates, so close cannot
  // certify a period that silently omits either side of an expense/return.
  const [expenses, expenseReturns] = await Promise.all([
    client.operatingExpense.findMany({ where: { cafeId, occurredAt: window }, select: { id: true, branchId: true, occurredAt: true } }),
    client.operatingExpenseReturn.findMany({ where: { cafeId, occurredAt: window }, select: { id: true, branchId: true, occurredAt: true } }),
  ]);
  for (const e of expenses) out.push({ sourceType: "OPERATING_EXPENSE", sourceId: e.id, sourceKey: expenseSourceKey("expense", e.id), at: e.occurredAt, branchId: e.branchId, description: "مصروف تشغيلي مدفوع", lines: "ترحيل المصروفات غير معتمد في ACC-01A؛ يلزم اعتماد مواءمة الترحيل قبل الإقفال" });
  for (const r of expenseReturns) out.push({ sourceType: "OPERATING_EXPENSE_RETURN", sourceId: r.id, sourceKey: expenseSourceKey("return", r.id), at: r.occurredAt, branchId: r.branchId, description: "رد نقد مصروف", lines: "ترحيل رد نقد المصروف غير معتمد في ACC-01A؛ يلزم اعتماد مواءمة الترحيل قبل الإقفال" });
  // Immutable operational evidence only. No CashStorage or supplier source is imported.
  const treasury = await client.moneyMovement.findMany({ where:{cafeId,occurredAt:window},include:{account:{select:{branchId:true}}} });
  for(const m of treasury) out.push({sourceType:m.kind==="OPENING"?"TREASURY_OPENING":m.kind==="TRANSFER_OUT"?"TREASURY_TRANSFER_DISPATCH":"TREASURY_TRANSFER_RECEIVE",sourceId:m.id,sourceKey:m.sourceKey,at:m.occurredAt,branchId:m.account.branchId,description:"حركة أموال تشغيلية مسجلة",lines:"ترحيل حسابات الأموال غير معتمد؛ مصدر تشغيلي غير قابل للترحيل: "+JSON.stringify({kind:m.kind,accountId:m.accountId,transferId:m.transferId,amount:m.signedAmount.toFixed(2),actorId:m.actorId,openingReference:m.openingReference})});
  out.push(...await purchaseAndStockCandidates(client, cafeId, window, valueLegacyCountRebases));
  return out.sort((a, b) => a.at.getTime() - b.at.getTime() || a.sourceKey.localeCompare(b.sourceKey));
}

const monthOf = (date: string) => {
  const [y, m] = date.split("-").map(Number);
  return { startsOn: `${date.slice(0, 7)}-01`, endsOn: new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10) };
};
const toInput = (cafeId: string, c: Candidate, actorId: string | null): PostingInput => ({
  cafeId, entryDate: dateStrInTz(c.at), description: c.description, sourceType: c.sourceType, sourceId: c.sourceId, sourceKey: c.sourceKey, lines: c.lines as PostingLine[], actorId,
});
const windowDates = (w: { gte: Date; lt: Date }) => ({ gte: new Date(`${dateStrInTz(w.gte)}T00:00:00Z`), lte: new Date(`${dateStrInTz(new Date(w.lt.getTime() - 1))}T00:00:00Z`) });

/** Posted shadow entries in the window whose source no longer produces an event. */
async function disappeared(client: Client, cafeId: string, window: { gte: Date; lt: Date }, keys: Set<string>) {
  const posted = await client.journalEntry.findMany({
    where: { cafeId, sourceType: { in: SHADOW_SOURCE_TYPES }, reversalOfId: null, reversedBy: null, entryDate: windowDates(window) },
    select: { sourceKey: true, sourceType: true, sourceId: true, entryDate: true, number: true },
  });
  return posted.filter((e) => !keys.has(e.sourceKey));
}

type IssueInput = { sourceKey: string; sourceType: string; sourceId: string; kind: "UNPOSTABLE" | "CHANGED" | "DISAPPEARED" | "FAILED" | "LATE_EVENT" | "ASSUMED_DATE"; reason: string; eventAt: Date; branchId: string | null };
const WARNING_KINDS = new Set(["ASSUMED_DATE"]);

/**
 * Post every source event in [from, to) that is not yet in the books, and
 * record the run and its issues. `openMissingPeriods` opens a calendar-month
 * period for a date no period covers — for shadow books only; real periods
 * are the accountant's call. Reprojection never edits a posted entry.
 */
export async function projectShadowLedger(args: {
  cafeId: string; from: Date; to: Date; actorId?: string | null; openMissingPeriods?: boolean;
  /** Internal disposable diagnostics. HTTP projection and P&L leave historical valuation on hold. */
  valueLegacyCountRebases?: true;
}): Promise<ShadowReport> {
  const entity = await db.$transaction((tx) => ensureAccountingEntity(tx, args.cafeId));
  const window = { gte: args.from, lt: args.to };
  const run = await db.accountingProjectionRun.create({ data: { cafeId: args.cafeId, entityId: entity.id, windowFrom: args.from, windowTo: args.to, actorId: args.actorId ?? null } });
  const report: ShadowReport = { runId: run.id, posted: 0, replayed: 0, skipped: 0, exceptions: [], warnings: [], bySource: {} };
  const issues: IssueInput[] = [];
  const all = await candidates(db, args.cafeId, window, args.valueLegacyCountRebases);
  for (const c of all) {
    const issue = (kind: IssueInput["kind"], reason: string) => issues.push({ sourceKey: c.sourceKey, sourceType: c.sourceType, sourceId: c.sourceId, kind, reason, eventAt: c.at, branchId: c.branchId });
    if (typeof c.lines === "string") { issue("UNPOSTABLE", c.lines); continue; }
    if (c.lines.length === 0) { report.skipped++; continue; } // a zero-value event moves nothing
    const input = toInput(args.cafeId, c, args.actorId ?? null);
    try {
      if (args.openMissingPeriods) {
        const day = new Date(`${input.entryDate}T00:00:00Z`);
        const covered = await db.accountingPeriod.count({ where: { cafeId: args.cafeId, startsOn: { lte: day }, endsOn: { gte: day } } });
        if (!covered) await db.$transaction((tx) => openPeriod(tx, { cafeId: args.cafeId, ...monthOf(input.entryDate) }));
      }
      const result = await db.$transaction((tx) => postEntry(tx, input));
      if (result.replayed) report.replayed++; else report.posted++;
      report.bySource[c.sourceType] = (report.bySource[c.sourceType] ?? 0) + 1;
      if (c.warning) issue("ASSUMED_DATE", c.warning);
    } catch (error) {
      const message = (error as Error).message, status = (error as { status?: number }).status;
      if (status === 409 && /مختلف/.test(message)) issue("CHANGED", "المصدر اتغير بعد ما اترحّل — محتاج مراجعة وقيد تصحيح");
      else if (/مقفولة|closed/i.test(message)) issue("LATE_EVENT", "الحدث تاريخه في فترة اتقفلت — محتاج قرار المحاسب");
      else issue("FAILED", message);
    }
  }
  for (const e of await disappeared(db, args.cafeId, window, new Set(all.map((c) => c.sourceKey)))) {
    issues.push({ sourceKey: e.sourceKey, sourceType: e.sourceType, sourceId: e.sourceId ?? "", kind: "DISAPPEARED", reason: `القيد رقم ${e.number} اترحّل لمصدر مابقاش حدث مالي — محتاج قيد عكسي`, eventAt: e.entryDate, branchId: null });
  }

  const now = new Date();
  for (const i of issues) {
    const severity = WARNING_KINDS.has(i.kind) ? "WARNING" : "BLOCKING";
    await db.accountingProjectionIssue.upsert({
      where: { entityId_sourceKey_kind: { entityId: entity.id, sourceKey: i.sourceKey, kind: i.kind } },
      create: { cafeId: args.cafeId, entityId: entity.id, ...i, severity, lastRunId: run.id },
      update: { reason: i.reason, severity, eventAt: i.eventAt, branchId: i.branchId, lastSeenAt: now, lastRunId: run.id, resolvedAt: null },
    });
    (severity === "WARNING" ? report.warnings : report.exceptions).push({ sourceKey: i.sourceKey, sourceType: i.sourceType, sourceId: i.sourceId, reason: i.reason });
  }
  // An issue in this window that this run no longer sees has been resolved.
  await db.accountingProjectionIssue.updateMany({
    where: { entityId: entity.id, resolvedAt: null, NOT: { lastRunId: run.id }, eventAt: { gte: windowDates(window).gte, lt: zonedDayStart(addDays(dateStrInTz(new Date(window.lt.getTime() - 1)), 1)) } },
    data: { resolvedAt: now },
  });
  await db.accountingProjectionRun.update({ where: { id: run.id }, data: { finishedAt: new Date(), posted: report.posted, replayed: report.replayed, skipped: report.skipped, issueCount: issues.length } });
  return report;
}

/**
 * What the books lack for [from, to), without posting anything: events not
 * yet posted, posted events whose source would now post something different
 * (same canonical payload construction as posting), posted events whose
 * source disappeared, events that cannot be posted, and unresolved recorded
 * issues (late events, failures). Pass the close transaction as `client`.
 */
export async function shadowCoverage(args: { cafeId: string; from: Date; to: Date }, client: Client = db) {
  const window = { gte: args.from, lt: args.to };
  const entity = await client.accountingEntity.findUnique({ where: { cafeId: args.cafeId }, select: { id: true } });
  const all = await candidates(client, args.cafeId, window);
  const ref = (c: Candidate) => ({ sourceKey: c.sourceKey, sourceType: c.sourceType, sourceId: c.sourceId });
  const unpostable = all.filter((c) => typeof c.lines === "string").map((c) => ({ ...ref(c), reason: c.lines as string }));
  const postable = all.filter((c) => typeof c.lines !== "string" && c.lines.length > 0);
  const entries = new Map((await client.journalEntry.findMany({ where: { cafeId: args.cafeId, sourceKey: { in: postable.map((c) => c.sourceKey) } }, select: { sourceKey: true, payloadHash: true } })).map((e) => [e.sourceKey, e.payloadHash]));
  const missing: ReturnType<typeof ref>[] = [], changed: ReturnType<typeof ref>[] = [], failed: (ReturnType<typeof ref> & { reason: string })[] = [];
  let posted = 0;
  for (const c of postable) {
    const hash = entries.get(c.sourceKey);
    if (hash === undefined) { missing.push(ref(c)); continue; }
    try {
      const prepared = await preparePosting(client, toInput(args.cafeId, c, null), entity?.id);
      if (prepared.payloadHash === hash) posted++; else changed.push(ref(c));
    } catch (error) { failed.push({ ...ref(c), reason: (error as Error).message }); }
  }
  const gone = (await disappeared(client, args.cafeId, window, new Set(all.map((c) => c.sourceKey)))).map((e) => ({ sourceKey: e.sourceKey, sourceType: e.sourceType, sourceId: e.sourceId ?? "" }));
  const recorded = entity ? await client.accountingProjectionIssue.findMany({
    where: { entityId: entity.id, resolvedAt: null, eventAt: { gte: args.from, lt: args.to } },
    select: { sourceKey: true, sourceType: true, sourceId: true, kind: true, severity: true, reason: true },
  }) : [];
  return {
    events: postable.length, posted, missing, changed, disappeared: gone, unpostable, failed,
    recordedIssues: recorded,
    complete: missing.length + changed.length + gone.length + unpostable.length + failed.length + recorded.filter((r) => r.severity === "BLOCKING").length === 0,
  };
}
