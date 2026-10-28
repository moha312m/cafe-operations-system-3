// ── Ledger posting service ───────────────────────────────────────────
// The only writer of journal entries. The database enforces the invariants
// (balance at commit, append-only rows, open period, same-entity accounts —
// see migration 20261028200000_accounting_ledger_core); this module checks
// them first to give a readable refusal, and adds what SQL cannot:
//
//   idempotency  one entry per (entity, sourceKey). A replay with the same
//                payload returns the existing entry; a different payload under
//                the same key is refused, never silently merged.
//   numbering    gapless per entity, taken under the entity row lock, so it
//                rolls back with the entry.
//   ordering     entity FOR UPDATE, then (in the entry trigger) period FOR
//                SHARE. Closing takes only the period FOR UPDATE, so a post
//                and a close serialise without deadlocking.
//
// Callers pass a transaction: posting commits or rolls back with the business
// write it describes.
import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { ApiError } from "@/lib/api";
import { db } from "@/lib/db";
import { decimal, money, sumMoney, type Numeric } from "@/lib/money";

type Tx = Prisma.TransactionClient;

export type PostingLine = {
  /** Account by its stable systemKey (preferred) or by id. */
  account: { key: string } | { id: string };
  branchId?: string | null;
  debit?: Numeric;
  credit?: Numeric;
  memo?: string;
};

export type PostingInput = {
  cafeId: string;
  /** Local business date, YYYY-MM-DD. */
  entryDate: string;
  description: string;
  sourceType: string;
  sourceId?: string | null;
  sourceKey: string;
  lines: PostingLine[];
  actorId?: string | null;
  reversalOfId?: string | null;
};

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const asDate = (value: string) => {
  const date = new Date(`${value}T00:00:00Z`);
  if (!DATE.test(value) || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new ApiError(400, "تاريخ القيد غير صحيح");
  return date;
};

function exactAmount(value: Numeric | undefined) {
  if (value === undefined) return decimal(0);
  const amount = decimal(value);
  if (amount.isNegative()) throw new ApiError(400, "مبلغ سطر القيد مايكونش بالسالب");
  if (!money(amount).equals(amount)) throw new ApiError(400, "مبلغ سطر القيد أكتر من قرشين عشريين");
  return amount;
}

async function lockEntity(tx: Tx, cafeId: string) {
  const [entity] = await tx.$queryRaw<{ id: string; nextEntryNumber: number }[]>`SELECT "id", "nextEntryNumber" FROM "AccountingEntity" WHERE "cafeId" = ${cafeId} FOR UPDATE`;
  if (!entity) throw new ApiError(404, "مفيش دفاتر محاسبية للكافيه ده");
  return entity;
}

export async function postEntry(tx: Tx, input: PostingInput) {
  const entryDate = asDate(input.entryDate);
  if (!input.sourceKey || !input.sourceType) throw new ApiError(400, "القيد محتاج مصدر ومفتاح");
  if (input.lines.length < 2) throw new ApiError(400, "القيد محتاج سطرين على الأقل");
  const amounts = input.lines.map((line) => {
    const debit = exactAmount(line.debit), credit = exactAmount(line.credit);
    if (debit.isZero() === credit.isZero()) throw new ApiError(400, "كل سطر يا مدين يا دائن، ومش صفر");
    return { debit, credit };
  });
  const totalDebit = sumMoney(amounts.map((a) => a.debit)), totalCredit = sumMoney(amounts.map((a) => a.credit));
  if (!totalDebit.equals(totalCredit)) throw new ApiError(400, `القيد مش متوازن: مدين ${totalDebit.toFixed(2)} ودائن ${totalCredit.toFixed(2)}`);

  const entity = await lockEntity(tx, input.cafeId);

  const keys = [...new Set(input.lines.flatMap((l) => ("key" in l.account ? [l.account.key] : [])))];
  const ids = [...new Set(input.lines.flatMap((l) => ("id" in l.account ? [l.account.id] : [])))];
  const accounts = await tx.accountingAccount.findMany({
    where: { entityId: entity.id, OR: [{ systemKey: { in: keys } }, { id: { in: ids } }] },
    select: { id: true, systemKey: true, isPostable: true, isActive: true },
  });
  const resolved = input.lines.map((line, i) => {
    const account = accounts.find((a) => ("key" in line.account ? a.systemKey === line.account.key : a.id === line.account.id));
    if (!account) throw new ApiError(400, `حساب السطر ${i + 1} مش موجود في دفاتر الكافيه`);
    if (!account.isPostable || !account.isActive) throw new ApiError(400, `حساب السطر ${i + 1} مايقبلش قيود`);
    return { accountId: account.id, branchId: line.branchId ?? null, debit: amounts[i].debit, credit: amounts[i].credit, memo: line.memo ?? null };
  });

  const payloadHash = createHash("sha256").update(JSON.stringify({
    entryDate: input.entryDate, sourceType: input.sourceType, sourceId: input.sourceId ?? null, reversalOfId: input.reversalOfId ?? null,
    lines: resolved.map((l) => [l.accountId, l.branchId, l.debit.toFixed(2), l.credit.toFixed(2), l.memo]),
  })).digest("hex");

  // Serialised by the entity lock, so this read cannot race another poster.
  const existing = await tx.journalEntry.findUnique({ where: { entityId_sourceKey: { entityId: entity.id, sourceKey: input.sourceKey } } });
  if (existing) {
    if (existing.payloadHash !== payloadHash) throw new ApiError(409, "المفتاح ده اتسجل بقيد مختلف");
    return { entry: existing, replayed: true };
  }

  const period = await tx.accountingPeriod.findFirst({ where: { entityId: entity.id, startsOn: { lte: entryDate }, endsOn: { gte: entryDate } } });
  if (!period) throw new ApiError(400, "مفيش فترة محاسبية للتاريخ ده");
  if (period.status !== "OPEN") throw new ApiError(409, "الفترة المحاسبية مقفولة");

  await tx.accountingEntity.update({ where: { id: entity.id }, data: { nextEntryNumber: { increment: 1 } } });
  const entry = await tx.journalEntry.create({ data: {
    cafeId: input.cafeId, entityId: entity.id, periodId: period.id, number: entity.nextEntryNumber,
    entryDate, description: input.description, sourceType: input.sourceType, sourceId: input.sourceId ?? null,
    sourceKey: input.sourceKey, payloadHash, reversalOfId: input.reversalOfId ?? null, createdById: input.actorId ?? null,
  } });
  await tx.journalLine.createMany({ data: resolved.map((l) => ({ ...l, cafeId: input.cafeId, entryId: entry.id })) });
  return { entry, replayed: false };
}

/** A mirror entry dated `entryDate`; the original stays untouched. One reversal per entry. */
export async function reverseEntry(tx: Tx, args: { cafeId: string; entryId: string; entryDate: string; actorId?: string | null; description?: string }) {
  const original = await tx.journalEntry.findFirst({ where: { id: args.entryId, cafeId: args.cafeId }, include: { lines: true } });
  if (!original) throw new ApiError(404, "القيد مش موجود");
  if (original.reversalOfId) throw new ApiError(400, "القيد ده نفسه عكس لقيد تاني");
  return postEntry(tx, {
    cafeId: args.cafeId, entryDate: args.entryDate,
    description: args.description ?? `عكس القيد رقم ${original.number}`,
    sourceType: "REVERSAL", sourceId: original.id, sourceKey: `reversal:${original.id}`, reversalOfId: original.id,
    actorId: args.actorId,
    lines: original.lines.map((l) => ({ account: { id: l.accountId }, branchId: l.branchId, debit: l.credit.isZero() ? undefined : l.credit, credit: l.debit.isZero() ? undefined : l.debit, memo: l.memo ?? undefined })),
  });
}

export async function openPeriod(tx: Tx, args: { cafeId: string; startsOn: string; endsOn: string }) {
  const entity = await tx.accountingEntity.findUnique({ where: { cafeId: args.cafeId } });
  if (!entity) throw new ApiError(404, "مفيش دفاتر محاسبية للكافيه ده");
  return tx.accountingPeriod.create({ data: { cafeId: args.cafeId, entityId: entity.id, startsOn: asDate(args.startsOn), endsOn: asDate(args.endsOn) } });
}

/** Waits for in-flight posts into the period (they hold it FOR SHARE), then closes it. */
export async function closePeriod(tx: Tx, args: { cafeId: string; periodId: string; actorId: string }) {
  const [period] = await tx.$queryRaw<{ id: string; status: string }[]>`SELECT "id", "status"::text AS "status" FROM "AccountingPeriod" WHERE "id" = ${args.periodId} AND "cafeId" = ${args.cafeId} FOR UPDATE`;
  if (!period) throw new ApiError(404, "الفترة مش موجودة");
  if (period.status !== "OPEN") throw new ApiError(409, "الفترة مقفولة بالفعل");
  return tx.accountingPeriod.update({ where: { id: period.id }, data: { status: "CLOSED", closedAt: new Date(), closedById: args.actorId } });
}

export type TrialBalanceRow = { accountId: string; code: string; name: string; type: string; normalBalance: string; debit: number; credit: number; balance: number };

/** Debits and credits per account over entry dates [from, to] (both inclusive, optional). */
export async function trialBalance(args: { cafeId: string; from?: string; to?: string }, client: Tx | typeof db = db) {
  const from = args.from ? asDate(args.from) : new Date("1900-01-01T00:00:00Z");
  const to = args.to ? asDate(args.to) : new Date("9999-12-31T00:00:00Z");
  const rows = await client.$queryRaw<{ accountId: string; code: string; name: string; type: string; normalBalance: string; debit: string; credit: string }[]>`
    SELECT a."id" AS "accountId", a."code", a."name", a."type"::text AS "type", a."normalBalance"::text AS "normalBalance",
           sum(l."debit")::text AS "debit", sum(l."credit")::text AS "credit"
      FROM "JournalLine" l
      JOIN "JournalEntry" j ON j."id" = l."entryId"
      JOIN "AccountingAccount" a ON a."id" = l."accountId"
     WHERE j."cafeId" = ${args.cafeId} AND j."entryDate" BETWEEN ${from} AND ${to}
     GROUP BY a."id" ORDER BY a."code"`;
  const accounts: TrialBalanceRow[] = rows.map((r) => {
    const debit = money(r.debit), credit = money(r.credit);
    const balance = r.normalBalance === "DEBIT" ? debit.minus(credit) : credit.minus(debit);
    return { ...r, debit: debit.toNumber(), credit: credit.toNumber(), balance: money(balance).toNumber() };
  });
  const totalDebit = money(sumMoney(rows.map((r) => r.debit))), totalCredit = money(sumMoney(rows.map((r) => r.credit)));
  return { accounts, totalDebit: totalDebit.toNumber(), totalCredit: totalCredit.toNumber(), balanced: totalDebit.equals(totalCredit) };
}
