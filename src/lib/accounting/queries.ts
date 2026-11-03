// ── Accounting read models for the owner workspace (G2) ──────────────
// Read-only views over the shadow books. Nothing here creates books, opens
// periods or posts: an unconfigured café reads as unconfigured. Every query
// takes an already-authorised scope; `branchId` (set for a branch-scoped
// reader) narrows lines to that branch and leaves café-wide lines out.
import { Prisma } from "@prisma/client";
import { ApiError } from "@/lib/api";
import { db } from "@/lib/db";
import { addDays, dateStrInTz } from "@/lib/date-range";
import { decimal, money, sumMoney } from "@/lib/money";
import { trialBalance } from "@/lib/accounting/ledger";
import { closeChecklist } from "@/lib/accounting/close-checklist";

export type Scope = { cafeId: string; branchId?: string };
const DATE = /^\d{4}-\d{2}-\d{2}$/;
export function parseDate(value: string | null, fallback: string) {
  const v = value ?? fallback;
  if (!DATE.test(v) || new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) !== v) throw new ApiError(400, "تاريخ غير صحيح");
  return v;
}
const at = (date: string) => new Date(`${date}T00:00:00Z`);
const day = (d: Date) => d.toISOString().slice(0, 10);

export const SHADOW_NOTICE = "تجريبي — غير معتمد: دفاتر تجريبية للمراجعة، مش دفاتر رسمية، ومحتاجة مراجعة المحاسب قبل أي استخدام.";

/** Books, periods, projection health and the current period's checklist. */
export async function accountingOverview(scope: Scope) {
  const entity = await db.accountingEntity.findUnique({ where: { cafeId: scope.cafeId } });
  if (!entity) return { configured: false as const, notice: SHADOW_NOTICE };
  const [periods, lastRun, issues, entries, opening, accounts] = await Promise.all([
    db.accountingPeriod.findMany({ where: { entityId: entity.id }, orderBy: { startsOn: "desc" }, take: 12 }),
    db.accountingProjectionRun.findFirst({ where: { entityId: entity.id, finishedAt: { not: null } }, orderBy: { startedAt: "desc" } }),
    db.accountingProjectionIssue.findMany({ where: { entityId: entity.id, resolvedAt: null, ...(scope.branchId ? { branchId: scope.branchId } : {}) }, orderBy: { eventAt: "desc" }, take: 50 }),
    db.journalEntry.aggregate({ where: { entityId: entity.id }, _count: true, _max: { entryDate: true } }),
    db.journalEntry.findFirst({ where: { entityId: entity.id, sourceType: "OPENING_BALANCE" }, select: { id: true, entryDate: true } }),
    db.accountingAccount.count({ where: { entityId: entity.id } }),
  ]);
  const today = dateStrInTz(new Date());
  const current = periods.find((p) => day(p.startsOn) <= today && today <= day(p.endsOn)) ?? periods.find((p) => p.status === "OPEN") ?? periods[0] ?? null;
  // The checklist reads café-wide control accounts, so a branch reader does not get it.
  const checklist = current && !scope.branchId ? await closeChecklist({ cafeId: scope.cafeId, periodId: current.id }) : null;
  const byKind = issues.reduce<Record<string, number>>((acc, i) => ({ ...acc, [i.kind]: (acc[i.kind] ?? 0) + 1 }), {});
  return {
    configured: true as const, notice: SHADOW_NOTICE, mode: "SHADOW" as const,
    entity: { name: entity.name, currency: entity.currency, accounts },
    branchScope: scope.branchId ?? null,
    periods: periods.map((p) => ({ id: p.id, startsOn: day(p.startsOn), endsOn: day(p.endsOn), status: p.status, closedAt: p.closedAt })),
    currentPeriod: current ? { id: current.id, startsOn: day(current.startsOn), endsOn: day(current.endsOn), status: current.status } : null,
    lastProjection: lastRun ? { at: lastRun.finishedAt, windowFrom: lastRun.windowFrom, windowTo: lastRun.windowTo, posted: lastRun.posted, replayed: lastRun.replayed, issues: lastRun.issueCount } : null,
    journal: { entries: entries._count, lastEntryDate: entries._max.entryDate ? day(entries._max.entryDate) : null },
    openingBalances: opening ? { posted: true, date: day(opening.entryDate) } : { posted: false, date: null },
    issues: { byKind, open: issues.map((i) => ({ kind: i.kind, severity: i.severity, sourceKey: i.sourceKey, sourceType: i.sourceType, sourceId: i.sourceId, reason: i.reason, eventAt: i.eventAt, lastSeenAt: i.lastSeenAt })) },
    checklist,
  };
}

export type TbRow = { accountId: string; code: string; name: string; type: string; normalBalance: string; opening: number; debit: number; credit: number; movement: number; closing: number };

/**
 * Trial balance for [from, to]: opening = balance before `from`; debit and
 * credit = posted in the window; movement = debit − credit signed to the
 * account's normal side; closing = opening + movement. Totals are over every
 * account, never a page.
 */
export async function trialBalanceView(scope: Scope, from: string, to: string) {
  if (from > to) throw new ApiError(400, "تاريخ البداية بعد النهاية");
  const before = addDays(from, -1);
  const [openingRows, windowRows] = await Promise.all([
    trialBalance({ cafeId: scope.cafeId, to: before, branchId: scope.branchId }),
    trialBalance({ cafeId: scope.cafeId, from, to, branchId: scope.branchId }),
  ]);
  const accounts = await db.accountingAccount.findMany({ where: { cafeId: scope.cafeId, isPostable: true }, orderBy: { code: "asc" }, select: { id: true, code: true, name: true, type: true, normalBalance: true } });
  const opening = new Map(openingRows.accounts.map((r) => [r.accountId, r]));
  const window = new Map(windowRows.accounts.map((r) => [r.accountId, r]));
  const rows: TbRow[] = accounts.flatMap((a) => {
    const o = opening.get(a.id), w = window.get(a.id);
    if (!o && !w) return [];
    const sign = a.normalBalance === "DEBIT" ? 1 : -1;
    const debit = money(w?.debit ?? 0), credit = money(w?.credit ?? 0);
    const openingBalance = money(o?.balance ?? 0), movement = money(debit.minus(credit).times(sign));
    return [{ accountId: a.id, code: a.code, name: a.name, type: a.type, normalBalance: a.normalBalance, opening: openingBalance.toNumber(), debit: debit.toNumber(), credit: credit.toNumber(), movement: movement.toNumber(), closing: money(openingBalance.plus(movement)).toNumber() }];
  });
  const totalDebit = money(sumMoney(rows.map((r) => r.debit))), totalCredit = money(sumMoney(rows.map((r) => r.credit)));
  return { from, to, branchId: scope.branchId ?? null, rows, totals: { debit: totalDebit.toNumber(), credit: totalCredit.toNumber(), balanced: totalDebit.equals(totalCredit) } };
}

const PAGE = 100;

/** One account's lines over [from, to] with the opening balance and a running balance that does not depend on the page. */
export async function generalLedger(scope: Scope, accountId: string, from: string, to: string, page: number) {
  const account = await db.accountingAccount.findFirst({ where: { id: accountId, cafeId: scope.cafeId }, select: { id: true, code: true, name: true, normalBalance: true } });
  if (!account) throw new ApiError(404, "الحساب مش موجود");
  const sign = account.normalBalance === "DEBIT" ? 1 : -1;
  const branch = scope.branchId ? Prisma.sql`AND l."branchId" = ${scope.branchId}` : Prisma.empty;
  const [openingRow] = await db.$queryRaw<{ debit: string | null; credit: string | null }[]>`
    SELECT sum(l."debit")::text AS debit, sum(l."credit")::text AS credit FROM "JournalLine" l JOIN "JournalEntry" j ON j."id" = l."entryId"
     WHERE l."accountId" = ${account.id} AND j."entryDate" < ${from}::date ${branch}`;
  const opening = money(decimal(openingRow?.debit ?? 0).minus(decimal(openingRow?.credit ?? 0)).times(sign));
  const [totals] = await db.$queryRaw<{ debit: string | null; credit: string | null; n: number }[]>`
    SELECT sum(l."debit")::text AS debit, sum(l."credit")::text AS credit, count(*)::int AS n FROM "JournalLine" l JOIN "JournalEntry" j ON j."id" = l."entryId"
     WHERE l."accountId" = ${account.id} AND j."entryDate" BETWEEN ${from}::date AND ${to}::date ${branch}`;
  const offset = Math.max(0, page - 1) * PAGE;
  const lines = await db.$queryRaw<{ entryId: string; number: number; entryDate: Date; description: string; sourceType: string; branchId: string | null; memo: string | null; debit: string; credit: string; running: string }[]>`
    SELECT * FROM (
      SELECT j."id" AS "entryId", j."number", j."entryDate", j."description", j."sourceType", l."branchId", l."memo", l."debit"::text AS debit, l."credit"::text AS credit,
             (sum(l."debit" - l."credit") OVER (ORDER BY j."entryDate", j."number", l."id"))::text AS running
        FROM "JournalLine" l JOIN "JournalEntry" j ON j."id" = l."entryId"
       WHERE l."accountId" = ${account.id} AND j."entryDate" BETWEEN ${from}::date AND ${to}::date ${branch}
    ) t ORDER BY "entryDate", "number" OFFSET ${offset} LIMIT ${PAGE}`;
  const debit = money(totals?.debit ?? 0), credit = money(totals?.credit ?? 0);
  return {
    account: { id: account.id, code: account.code, name: account.name, normalBalance: account.normalBalance },
    from, to, branchId: scope.branchId ?? null, page, pageSize: PAGE, lineCount: totals?.n ?? 0,
    opening: opening.toNumber(),
    totals: { debit: debit.toNumber(), credit: credit.toNumber(), closing: money(opening.plus(debit.minus(credit).times(sign))).toNumber() },
    lines: lines.map((l) => ({ entryId: l.entryId, number: l.number, entryDate: day(l.entryDate), description: l.description, sourceType: l.sourceType, branchId: l.branchId, memo: l.memo, debit: money(l.debit).toNumber(), credit: money(l.credit).toNumber(), balance: money(opening.plus(decimal(l.running).times(sign))).toNumber() })),
  };
}

// A branch reader sees an entry only when every line is theirs: a café-wide
// or other-branch line would otherwise leak through the entry.
const entryScope = (scope: Scope): Prisma.JournalEntryWhereInput => ({ cafeId: scope.cafeId, ...(scope.branchId ? { lines: { every: { branchId: scope.branchId } } } : {}) });

export async function journalList(scope: Scope, args: { from: string; to: string; sourceType?: string | null; page: number }) {
  const where: Prisma.JournalEntryWhereInput = { ...entryScope(scope), entryDate: { gte: at(args.from), lte: at(args.to) }, ...(args.sourceType ? { sourceType: args.sourceType } : {}) };
  const [count, entries, sourceTypes] = await Promise.all([
    db.journalEntry.count({ where }),
    db.journalEntry.findMany({ where, orderBy: [{ entryDate: "desc" }, { number: "desc" }], skip: Math.max(0, args.page - 1) * PAGE, take: PAGE,
      select: { id: true, number: true, entryDate: true, postedAt: true, description: true, sourceType: true, sourceId: true, reversalOfId: true, reversedBy: { select: { id: true, number: true } }, lines: { select: { debit: true } } } }),
    db.journalEntry.groupBy({ by: ["sourceType"], where: entryScope(scope), _count: true }),
  ]);
  return {
    from: args.from, to: args.to, page: args.page, pageSize: PAGE, count,
    sourceTypes: sourceTypes.map((s) => ({ sourceType: s.sourceType, count: s._count })),
    entries: entries.map((e) => ({ id: e.id, number: e.number, entryDate: day(e.entryDate), postedAt: e.postedAt, description: e.description, sourceType: e.sourceType, sourceId: e.sourceId, reversalOfId: e.reversalOfId, reversedBy: e.reversedBy, amount: money(sumMoney(e.lines.map((l) => l.debit))).toNumber() })),
  };
}

/** Where a source event can be looked at in the operational screens. */
function sourceLink(sourceType: string, sourceId: string | null) {
  if (!sourceId) return null;
  if (["SALE", "COLLECTION", "REFUND", "LEGACY_REFUND", "SALE_REVISION"].includes(sourceType)) return { label: "المبيعات", href: "/sales" };
  if (["PURCHASE_INVOICE", "PURCHASE_CANCEL", "SUPPLIER_PAYMENT"].includes(sourceType)) return { label: "المشتريات", href: "/purchases" };
  if (sourceType === "STOCK_MOVEMENT") return { label: "المخزون", href: "/inventory" };
  if (["CASH_TO_SAFE", "STORED_CASH_MOVEMENT", "CASH_VARIANCE"].includes(sourceType)) return { label: "الشيفتات", href: "/shifts" };
  return null;
}

/** The operational record behind an entry, read at request time. */
async function sourceEvidence(cafeId: string, sourceType: string, sourceId: string | null) {
  if (!sourceId) return null;
  if (sourceType === "SALE") {
    const o = await db.order.findFirst({ where: { id: sourceId, cafeId }, select: { orderNumber: true, status: true, createdAt: true, servedAt: true, total: true } });
    return o && { kind: "طلب", reference: `#${o.orderNumber}`, status: o.status, createdAt: o.createdAt, servedAt: o.servedAt, amount: money(o.total).toNumber() };
  }
  if (["COLLECTION", "REFUND", "LEGACY_REFUND"].includes(sourceType)) {
    const p = await db.payment.findFirst({ where: { id: sourceId, cafeId }, select: { type: true, status: true, method: true, amount: true, createdAt: true, order: { select: { orderNumber: true } } } });
    return p && { kind: p.type === "REFUND" ? "مرتجع" : "تحصيل", reference: `طلب #${p.order.orderNumber}`, status: p.status, method: p.method, createdAt: p.createdAt, amount: money(p.amount).toNumber() };
  }
  if (sourceType === "SALE_REVISION") {
    const r = await db.orderRevision.findFirst({ where: { id: sourceId, cafeId }, select: { number: true, reason: true, createdAt: true, oldTotal: true, newTotal: true, order: { select: { orderNumber: true } } } });
    return r && { kind: "تعديل فاتورة", reference: `طلب #${r.order.orderNumber} — تعديل ${r.number}`, reason: r.reason, createdAt: r.createdAt, oldTotal: money(r.oldTotal).toNumber(), newTotal: money(r.newTotal).toNumber() };
  }
  if (["PURCHASE_INVOICE", "PURCHASE_CANCEL"].includes(sourceType)) {
    const i = await db.purchaseInvoice.findFirst({ where: { id: sourceId, cafeId }, select: { invoiceNumber: true, status: true, confirmedAt: true, cancelledAt: true, totalAmount: true, supplier: { select: { name: true } } } });
    return i && { kind: "فاتورة شراء", reference: i.invoiceNumber, status: i.status, supplier: i.supplier?.name ?? null, confirmedAt: i.confirmedAt, cancelledAt: i.cancelledAt, amount: money(i.totalAmount).toNumber() };
  }
  if (sourceType === "SUPPLIER_PAYMENT") {
    const p = await db.purchasePayment.findFirst({ where: { id: sourceId, cafeId }, select: { amount: true, method: true, fundingSource: true, paidAt: true, invoice: { select: { invoiceNumber: true } } } });
    return p && { kind: "دفعة مورد", reference: p.invoice.invoiceNumber, method: p.method, fundingSource: p.fundingSource, createdAt: p.paidAt, amount: money(p.amount).toNumber() };
  }
  if (sourceType === "STOCK_MOVEMENT") {
    const m = await db.inventoryTransaction.findFirst({ where: { id: sourceId, cafeId }, select: { type: true, quantity: true, totalCost: true, note: true, createdAt: true, inventoryItem: { select: { name: true, unit: true } } } });
    return m && { kind: "حركة مخزون", reference: m.inventoryItem.name, type: m.type, quantity: Number(m.quantity), unit: m.inventoryItem.unit, note: m.note, createdAt: m.createdAt, amount: m.totalCost === null ? null : money(m.totalCost).toNumber() };
  }
  return null;
}

export async function journalEntryDetail(scope: Scope, id: string) {
  const entry = await db.journalEntry.findFirst({
    where: { id, ...entryScope(scope) },
    include: {
      period: { select: { startsOn: true, endsOn: true, status: true } },
      createdBy: { select: { name: true } },
      reversalOf: { select: { id: true, number: true } },
      reversedBy: { select: { id: true, number: true } },
      lines: { include: { account: { select: { id: true, code: true, name: true } }, branch: { select: { name: true } } }, orderBy: { id: "asc" } },
    },
  });
  if (!entry) throw new ApiError(404, "القيد مش موجود");
  const issues = await db.accountingProjectionIssue.findMany({ where: { cafeId: scope.cafeId, sourceKey: entry.sourceKey, resolvedAt: null }, select: { kind: true, severity: true, reason: true } });
  return {
    id: entry.id, number: entry.number, entryDate: day(entry.entryDate), postedAt: entry.postedAt, description: entry.description,
    sourceType: entry.sourceType, sourceId: entry.sourceId, sourceKey: entry.sourceKey,
    period: { startsOn: day(entry.period.startsOn), endsOn: day(entry.period.endsOn), status: entry.period.status },
    actor: entry.createdBy?.name ?? null,
    reversalOf: entry.reversalOf, reversedBy: entry.reversedBy,
    lines: entry.lines.map((l) => ({ accountId: l.account.id, code: l.account.code, account: l.account.name, branch: l.branch?.name ?? null, memo: l.memo, debit: money(l.debit).toNumber(), credit: money(l.credit).toNumber() })),
    totals: { debit: money(sumMoney(entry.lines.map((l) => l.debit))).toNumber(), credit: money(sumMoney(entry.lines.map((l) => l.credit))).toNumber() },
    source: { link: sourceLink(entry.sourceType, entry.sourceId), evidence: await sourceEvidence(scope.cafeId, entry.sourceType, entry.sourceId) },
    issues,
  };
}

/** Postable accounts for filters. */
export async function accountList(scope: Scope) {
  return db.accountingAccount.findMany({ where: { cafeId: scope.cafeId, isPostable: true }, orderBy: { code: "asc" }, select: { id: true, code: true, name: true, type: true, normalBalance: true, systemKey: true, isActive: true } });
}
