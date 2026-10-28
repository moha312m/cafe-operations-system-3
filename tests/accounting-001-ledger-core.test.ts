// ACCOUNTING-001: the ledger core keeps its invariants under every path —
// the posting service and raw SQL alike, alone and under concurrency.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { db, teardownTaggedCafe } from "./helpers/db";
import { countCafe, type CountCafe } from "./helpers/count";
import { requireServer } from "./helpers/http";
import { ensureAccountingEntity, DEFAULT_CHART } from "@/lib/accounting/chart";
import { postEntry, reverseEntry, openPeriod, closePeriod, trialBalance, type PostingInput } from "@/lib/accounting/ledger";

after(async () => { await db.$disconnect(); });

const OCTOBER = { startsOn: "2026-10-01", endsOn: "2026-10-31" };

async function books(name: string) {
  const fx = await countCafe(name);
  const entity = await db.$transaction(tx => ensureAccountingEntity(tx, fx.cafeId));
  const period = await db.$transaction(tx => openPeriod(tx, { cafeId: fx.cafeId, ...OCTOBER }));
  return { fx, entity, period };
}

const sale = (fx: CountCafe, sourceKey: string, amount = 100, over: Partial<PostingInput> = {}): PostingInput => ({
  cafeId: fx.cafeId, entryDate: "2026-10-15", description: "بيع تجريبي", sourceType: "TEST", sourceKey,
  lines: [{ account: { key: "CASH_DRAWER" }, branchId: fx.branchId, debit: amount }, { account: { key: "SALES" }, branchId: fx.branchId, credit: amount }],
  ...over,
});
const post = (input: PostingInput) => db.$transaction(tx => postEntry(tx, input));
const status = (promise: Promise<unknown>) => promise.then(() => 200, (e: { status?: number }) => e.status ?? 500);

test("each café gets one set of books with the default chart", { timeout: 30000 }, async () => {
  await requireServer();
  const { fx, entity } = await books("ACC001CHART");
  try {
    assert.equal((await db.$transaction(tx => ensureAccountingEntity(tx, fx.cafeId))).id, entity.id, "idempotent");
    assert.equal(await db.accountingAccount.count({ where: { entityId: entity.id } }), DEFAULT_CHART.length);
    assert.equal(await db.accountingAccount.count({ where: { entityId: entity.id, isPostable: false } }), 5);
    await assert.rejects(db.accountingEntity.create({ data: { cafeId: fx.cafeId, name: "x", currency: "EGP" } }), /Unique constraint/);
  } finally {
    await teardownTaggedCafe(fx.cafeId);
  }
});

test("an entry balances or nothing is written — through the service or raw SQL", { timeout: 30000 }, async () => {
  await requireServer();
  const { fx, entity, period } = await books("ACC001BALANCE");
  try {
    assert.equal(await status(post(sale(fx, "unbalanced", 100, { lines: [{ account: { key: "CASH_DRAWER" }, debit: 100 }, { account: { key: "SALES" }, credit: 90 }] }))), 400);
    assert.equal(await status(post(sale(fx, "one-line", 100, { lines: [{ account: { key: "CASH_DRAWER" }, debit: 100 }] }))), 400);
    assert.equal(await status(post(sale(fx, "fraction", 100.005))), 400, "sub-cent amounts are refused");
    const cash = await db.accountingAccount.findFirstOrThrow({ where: { entityId: entity.id, systemKey: "CASH_DRAWER" } });
    const raw = (lines: number) => db.$transaction(async tx => {
      const entry = await tx.journalEntry.create({ data: { cafeId: fx.cafeId, entityId: entity.id, periodId: period.id, number: 900 + lines, entryDate: new Date("2026-10-15T00:00:00Z"), description: "raw", sourceType: "RAW", sourceKey: `raw-${lines}`, payloadHash: "x" } });
      if (lines) await tx.journalLine.create({ data: { cafeId: fx.cafeId, entryId: entry.id, accountId: cash.id, debit: 10 } });
    });
    await assert.rejects(raw(1), /does not balance/, "a one-sided raw entry fails at commit");
    await assert.rejects(raw(0), /does not balance/, "an entry with no lines fails at commit");
    await assert.rejects(db.$transaction(async tx => {
      const entry = await tx.journalEntry.create({ data: { cafeId: fx.cafeId, entityId: entity.id, periodId: period.id, number: 950, entryDate: new Date("2026-10-15T00:00:00Z"), description: "raw", sourceType: "RAW", sourceKey: "raw-both", payloadHash: "x" } });
      await tx.journalLine.create({ data: { cafeId: fx.cafeId, entryId: entry.id, accountId: cash.id, debit: 10, credit: 10 } });
    }), /JournalLine_one_side_check|check constraint/i);
    assert.equal(await db.journalEntry.count({ where: { cafeId: fx.cafeId } }), 0);
  } finally {
    await teardownTaggedCafe(fx.cafeId);
  }
});

test("posted rows are append-only and lines cannot be added afterwards", { timeout: 30000 }, async () => {
  await requireServer();
  const { fx } = await books("ACC001IMMUTABLE");
  try {
    const { entry } = await post(sale(fx, "s1"));
    assert.ok(Math.abs(entry.postedAt.getTime() - Date.now()) < 60_000, "postedAt is the real instant, stored as UTC");
    const line = await db.journalLine.findFirstOrThrow({ where: { entryId: entry.id } });
    await assert.rejects(db.journalLine.update({ where: { id: line.id }, data: { memo: "edited" } }), /immutable/);
    await assert.rejects(db.journalLine.delete({ where: { id: line.id } }), /immutable/);
    await assert.rejects(db.journalEntry.update({ where: { id: entry.id }, data: { description: "edited" } }), /immutable/);
    await assert.rejects(db.journalEntry.delete({ where: { id: entry.id } }), /immutable/);
    await assert.rejects(db.$transaction(async tx => {
      await tx.journalLine.createMany({ data: [
        { cafeId: fx.cafeId, entryId: entry.id, accountId: line.accountId, debit: 5 },
        { cafeId: fx.cafeId, entryId: entry.id, accountId: line.accountId, credit: 5 },
      ] });
    }), /never added later/);
  } finally {
    await teardownTaggedCafe(fx.cafeId);
  }
});

test("concurrent replays of one source event post exactly one entry", { timeout: 30000 }, async () => {
  await requireServer();
  const { fx } = await books("ACC001IDEMPOTENT");
  try {
    const results = await Promise.all(Array.from({ length: 8 }, () => post(sale(fx, "order-42"))));
    assert.equal(new Set(results.map(r => r.entry.id)).size, 1);
    assert.equal(results.filter(r => !r.replayed).length, 1);
    assert.equal(await db.journalEntry.count({ where: { cafeId: fx.cafeId } }), 1);
    assert.equal(await status(post(sale(fx, "order-42", 120))), 409, "same key, different payload");
  } finally {
    await teardownTaggedCafe(fx.cafeId);
  }
});

test("entry numbers stay gapless under concurrency and rollback", { timeout: 30000 }, async () => {
  await requireServer();
  const { fx } = await books("ACC001NUMBERS");
  try {
    await Promise.all(Array.from({ length: 10 }, (_, i) => post(sale(fx, `n${i}`))));
    await assert.rejects(db.$transaction(async tx => { await postEntry(tx, sale(fx, "rolled-back")); throw new Error("business write failed"); }), /business write failed/);
    await post(sale(fx, "after"));
    const numbers = (await db.journalEntry.findMany({ where: { cafeId: fx.cafeId }, select: { number: true }, orderBy: { number: "asc" } })).map(e => e.number);
    assert.deepEqual(numbers, Array.from({ length: 11 }, (_, i) => i + 1));
    assert.equal(await db.journalEntry.count({ where: { cafeId: fx.cafeId, sourceKey: "rolled-back" } }), 0, "the entry rolled back with its business write");
  } finally {
    await teardownTaggedCafe(fx.cafeId);
  }
});

test("closing a period serialises with posting into it", { timeout: 30000 }, async () => {
  await requireServer();
  const { fx, period } = await books("ACC001CLOSE");
  try {
    await post(sale(fx, "before-close"));
    let release!: () => void, closing!: () => void;
    const gate = new Promise<void>(r => { release = r; }), closed = new Promise<void>(r => { closing = r; });
    const close = db.$transaction(async tx => { await closePeriod(tx, { cafeId: fx.cafeId, periodId: period.id, actorId: fx.owner.id }); closing(); await gate; }, { timeout: 15000 });
    await closed; // the close holds the period FOR UPDATE, uncommitted
    const racing = post(sale(fx, "during-close"));
    await new Promise(r => setTimeout(r, 300));
    release(); await close;
    assert.equal(await status(racing), 500, "the post saw the committed close and was refused by the period guard");
    await assert.rejects(racing, /closed/);
    assert.equal(await status(post(sale(fx, "after-close"))), 409);
    assert.deepEqual((await db.journalEntry.findMany({ where: { cafeId: fx.cafeId }, select: { sourceKey: true } })).map(e => e.sourceKey), ["before-close"]);
    await assert.rejects(db.accountingPeriod.update({ where: { id: period.id }, data: { status: "OPEN" } }), /stays closed/);
    await assert.rejects(db.accountingPeriod.delete({ where: { id: period.id } }), /never deleted/);
    await assert.rejects(db.$transaction(tx => openPeriod(tx, { cafeId: fx.cafeId, startsOn: "2026-10-20", endsOn: "2026-11-05" })), /overlap/);
    assert.equal(await status(post(sale(fx, "no-period", 100, { entryDate: "2026-12-01" }))), 400);
  } finally {
    await teardownTaggedCafe(fx.cafeId);
  }
});

test("one café's books never take another café's accounts or branches", { timeout: 30000 }, async () => {
  await requireServer();
  const a = await books("ACC001TENANTA"), b = await books("ACC001TENANTB");
  try {
    const foreign = await db.accountingAccount.findFirstOrThrow({ where: { entityId: b.entity.id, systemKey: "SALES" } });
    assert.equal(await status(post(sale(a.fx, "x", 10, { lines: [{ account: { key: "CASH_DRAWER" }, debit: 10 }, { account: { id: foreign.id }, credit: 10 }] }))), 400);
    assert.equal(await status(post(sale(a.fx, "y", 10, { lines: [{ account: { key: "CASH_DRAWER" }, branchId: b.fx.branchId, debit: 10 }, { account: { key: "SALES" }, credit: 10 }] }))), 500, "a foreign branch is refused by the line guard");
    const own = await db.accountingAccount.findFirstOrThrow({ where: { entityId: a.entity.id, systemKey: "CASH_DRAWER" } });
    await assert.rejects(db.$transaction(async tx => {
      const entry = await tx.journalEntry.create({ data: { cafeId: a.fx.cafeId, entityId: a.entity.id, periodId: a.period.id, number: 99, entryDate: new Date("2026-10-15T00:00:00Z"), description: "raw", sourceType: "RAW", sourceKey: "raw-tenant", payloadHash: "x" } });
      await tx.journalLine.createMany({ data: [{ cafeId: a.fx.cafeId, entryId: entry.id, accountId: own.id, debit: 10 }, { cafeId: a.fx.cafeId, entryId: entry.id, accountId: foreign.id, credit: 10 }] });
    }), /not a postable account of this entity/);
    await assert.rejects(db.journalEntry.create({ data: { cafeId: a.fx.cafeId, entityId: a.entity.id, periodId: b.period.id, number: 98, entryDate: new Date("2026-10-15T00:00:00Z"), description: "raw", sourceType: "RAW", sourceKey: "raw-period", payloadHash: "x" } }), /another entity/);
    assert.equal(await db.journalEntry.count({ where: { cafeId: { in: [a.fx.cafeId, b.fx.cafeId] } } }), 0);
  } finally {
    await teardownTaggedCafe(a.fx.cafeId);
    await teardownTaggedCafe(b.fx.cafeId);
  }
});

test("a reversal mirrors its entry once, and the trial balance nets to zero", { timeout: 30000 }, async () => {
  await requireServer();
  const { fx } = await books("ACC001REVERSE");
  try {
    const { entry } = await post(sale(fx, "s1", 250));
    await post({ ...sale(fx, "s2", 40), lines: [{ account: { key: "COST_OF_SALES" }, debit: 40 }, { account: { key: "INVENTORY" }, credit: 40 }] });
    const reversal = await db.$transaction(tx => reverseEntry(tx, { cafeId: fx.cafeId, entryId: entry.id, entryDate: "2026-10-20" }));
    const again = await db.$transaction(tx => reverseEntry(tx, { cafeId: fx.cafeId, entryId: entry.id, entryDate: "2026-10-20" }));
    assert.equal(again.entry.id, reversal.entry.id);
    assert.equal(again.replayed, true, "reversing twice replays the one reversal");
    assert.equal(await status(db.$transaction(tx => reverseEntry(tx, { cafeId: fx.cafeId, entryId: reversal.entry.id, entryDate: "2026-10-20" }))), 400);

    const tb = await trialBalance({ cafeId: fx.cafeId });
    assert.equal(tb.balanced, true);
    assert.equal(tb.totalDebit, 540);
    const by = Object.fromEntries(tb.accounts.map(r => [r.code, r]));
    assert.equal(by["1110"].balance, 0, "drawer cash nets out");
    assert.equal(by["4100"].balance, 0, "sales net out");
    assert.equal(by["5100"].balance, 40);
    assert.equal(by["1200"].balance, -40, "inventory credited below its normal side");
    const beforeReversal = await trialBalance({ cafeId: fx.cafeId, to: "2026-10-19" });
    assert.equal(Object.fromEntries(beforeReversal.accounts.map(r => [r.code, r]))["4100"].balance, 250, "as of a date, before the reversal");
  } finally {
    await teardownTaggedCafe(fx.cafeId);
  }
});
