// ACCOUNTING-009 (Step 4B.2): the database guards behind account administration
// and the effective-dated expense category mapping hold for any writer, not just
// the API: mapping rows are append-only and tied to an active postable expense
// account of the same books; an account's identity does not move under posted
// lines; the tree stays typed, acyclic and parented by headers.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { db, teardownTaggedCafe } from "./helpers/db";
import { countCafe } from "./helpers/count";
import { requireServer } from "./helpers/http";
import { ensureAccountingEntity } from "@/lib/accounting/chart";
import { postEntry, openPeriod, closePeriod } from "@/lib/accounting/ledger";
import { addDays, dateStrInTz } from "@/lib/date-range";

after(async () => { await db.$disconnect(); });

async function books(name: string) {
  const fx = await countCafe(name);
  const entity = await db.$transaction(tx => ensureAccountingEntity(tx, fx.cafeId));
  const byKey = async (systemKey: string) => db.accountingAccount.findFirstOrThrow({ where: { entityId: entity.id, systemKey } });
  const make = (code: string, over: Record<string, unknown> = {}) => db.accountingAccount.create({ data: { cafeId: fx.cafeId, entityId: entity.id, code, name: `حساب ${code}`, type: "EXPENSE", normalBalance: "DEBIT", ...over } as never });
  const category = (code: string) => db.expenseCategory.create({ data: { cafeId: fx.cafeId, code, nameAr: `تصنيف ${code}`, createdById: fx.owner.id } });
  const map = (categoryId: string, accountId: string | null, effectiveFrom: string) => db.expenseCategoryAccountMapping.create({ data: { cafeId: fx.cafeId, entityId: entity.id, categoryId, accountId, effectiveFrom: new Date(`${effectiveFrom}T00:00:00Z`), reason: "اختبار الربط", approvalRef: "ACC-TEST-1", createdById: fx.owner.id } });
  return { fx, entity, byKey, make, category, map };
}

test("mapping rows tie a category to an active postable expense account of the same books", { timeout: 60000 }, async () => {
  await requireServer();
  const { fx, entity, byKey, make, category, map } = await books("ACC009MAP");
  const other = await books("ACC009MAPX");
  try {
    const parent = await byKey("HEADER_EXPENSES");
    const clean = await make("5410", { parentId: parent.id });
    const cat = await category("S4B2_CLEAN");
    const ok = await map(cat.id, clean.id, "2026-11-01");
    assert.equal(ok.accountId, clean.id);

    const cat2 = await category("S4B2_OTHER");
    await assert.rejects(map(cat2.id, parent.id, "2026-11-01"), /active postable expense account/, "a header is refused");
    await assert.rejects(map(cat2.id, (await byKey("CASH_DRAWER")).id, "2026-11-01"), /active postable expense account/, "a non-expense account is refused");
    const stopped = await make("5411", { parentId: parent.id, isActive: false });
    await assert.rejects(map(cat2.id, stopped.id, "2026-11-01"), /active postable expense account/, "an inactive account is refused");
    const foreign = await other.make("5410", { parentId: (await other.byKey("HEADER_EXPENSES")).id });
    await assert.rejects(map(cat2.id, foreign.id, "2026-11-01"), /active postable expense account/, "another café's account is refused");
    const foreignCategory = await other.category("S4B2_FOREIGN");
    await assert.rejects(db.expenseCategoryAccountMapping.create({ data: { cafeId: fx.cafeId, entityId: entity.id, categoryId: foreignCategory.id, accountId: clean.id, effectiveFrom: new Date("2026-11-01T00:00:00Z"), reason: "اختبار الربط", approvalRef: "ACC-TEST-1", createdById: fx.owner.id } }), /same cafe|belong/, "another café's category is refused");

    await assert.rejects(map(cat.id, clean.id, "2026-11-01"), /Unique constraint|only move forward/, "same date twice");
    await assert.rejects(map(cat.id, null, "2026-10-15"), /only move forward/, "dates never move backwards");
    const ended = await map(cat.id, null, "2026-12-01");
    assert.equal(ended.accountId, null, "a later NULL row ends the mapping");

    await assert.rejects(db.expenseCategoryAccountMapping.update({ where: { id: ok.id }, data: { reason: "تعديل" } }), /append-only/);
    await assert.rejects(db.expenseCategoryAccountMapping.delete({ where: { id: ok.id } }), /append-only/);
    await assert.rejects(db.expenseCategoryAccountMapping.create({ data: { cafeId: fx.cafeId, entityId: entity.id, categoryId: cat2.id, accountId: clean.id, effectiveFrom: new Date("2026-11-01T00:00:00Z"), reason: "x", approvalRef: "ab", createdById: fx.owner.id } }), /check constraint|ExpenseCategoryAccountMapping_text/i, "reason and reference are required");
  } finally {
    await teardownTaggedCafe([fx.cafeId, other.fx.cafeId]);
  }
});

test("system accounts keep key, type, side and flag; accounts with posted lines keep type, side and postable flag", { timeout: 60000 }, async () => {
  await requireServer();
  const { fx, byKey, make } = await books("ACC009ACC");
  try {
    const cash = await byKey("CASH_DRAWER");
    await db.accountingAccount.update({ where: { id: cash.id }, data: { name: "نقدية الدرج (معدّل)" } });
    await db.accountingAccount.update({ where: { id: cash.id }, data: { code: "1999" } });
    await db.accountingAccount.update({ where: { id: cash.id }, data: { code: "1110" } });
    for (const data of [{ type: "LIABILITY" }, { normalBalance: "CREDIT" }, { isPostable: false }, { systemKey: "OTHER" }, { isActive: false }]) {
      await assert.rejects(db.accountingAccount.update({ where: { id: cash.id }, data: data as never }), /System accounts/, JSON.stringify(data));
    }

    const parent = await byKey("HEADER_EXPENSES");
    const free = await make("5420", { parentId: parent.id });
    await db.accountingAccount.update({ where: { id: free.id }, data: { code: "5421", name: "صيانة" } });
    await db.accountingAccount.update({ where: { id: free.id }, data: { isActive: false } });
    await db.accountingAccount.update({ where: { id: free.id }, data: { isActive: true } });
    await db.accountingAccount.update({ where: { id: free.id }, data: { type: "LIABILITY", normalBalance: "CREDIT", parentId: null } });
    await db.accountingAccount.update({ where: { id: free.id }, data: { type: "EXPENSE", normalBalance: "DEBIT", parentId: parent.id } });

    await db.$transaction(tx => openPeriod(tx, { cafeId: fx.cafeId, startsOn: "2026-11-01", endsOn: "2026-11-30" }));
    await db.$transaction(tx => postEntry(tx, { cafeId: fx.cafeId, entryDate: "2026-11-10", description: "مصروف تجريبي", sourceType: "TEST", sourceKey: "acc009-line", lines: [{ account: { id: free.id }, debit: 10 }, { account: { key: "CASH_DRAWER" }, credit: 10 }] }));
    for (const data of [{ type: "LIABILITY" }, { normalBalance: "CREDIT" }, { isPostable: false }]) {
      await assert.rejects(db.accountingAccount.update({ where: { id: free.id }, data: data as never }), /posted lines/, JSON.stringify(data));
    }
    await db.accountingAccount.update({ where: { id: free.id }, data: { name: "صيانة وإصلاحات", code: "5422" } });
  } finally {
    await teardownTaggedCafe(fx.cafeId);
  }
});

test("the tree stays typed, acyclic and parented by headers; closed periods pin accounts with lines", { timeout: 60000 }, async () => {
  await requireServer();
  const { fx, entity, byKey, make } = await books("ACC009TREE");
  const other = await books("ACC009TREEX");
  try {
    const expenses = await byKey("HEADER_EXPENSES");
    await assert.rejects(make("5601", { parentId: (await byKey("COST_OF_SALES")).id }), /header/, "a postable parent is refused");
    await assert.rejects(make("5602", { parentId: (await byKey("HEADER_ASSETS")).id }), /same account type/);
    await assert.rejects(make("5603", { parentId: (await other.byKey("HEADER_EXPENSES")).id }), /same books/);

    const group = await make("5400", { parentId: expenses.id, isPostable: false });
    const sub = await make("5450", { parentId: group.id, isPostable: false });
    await assert.rejects(db.accountingAccount.update({ where: { id: group.id }, data: { parentId: sub.id } }), /under itself|cycle/i, "no cycle");
    await assert.rejects(db.accountingAccount.update({ where: { id: group.id }, data: { isPostable: true } }), /header/, "a header with children stays a header");
    await assert.rejects(db.accountingAccount.update({ where: { id: group.id }, data: { type: "ASSET", normalBalance: "DEBIT" } }), /children|same account type/i);

    const rent = await make("5451", { parentId: sub.id });
    await db.$transaction(tx => openPeriod(tx, { cafeId: fx.cafeId, startsOn: "2026-10-01", endsOn: "2026-10-31" }));
    await db.$transaction(tx => postEntry(tx, { cafeId: fx.cafeId, entryDate: "2026-10-12", description: "إيجار", sourceType: "TEST", sourceKey: "acc009-rent", lines: [{ account: { id: rent.id }, debit: 50 }, { account: { key: "CASH_DRAWER" }, credit: 50 }] }));
    const open = await make("5455", { parentId: sub.id });
    await db.accountingAccount.update({ where: { id: open.id }, data: { parentId: expenses.id } });
    const period = await db.accountingPeriod.findFirstOrThrow({ where: { entityId: entity.id, startsOn: new Date("2026-10-01T00:00:00Z") } });
    await db.$transaction(tx => closePeriod(tx, { cafeId: fx.cafeId, periodId: period.id, actorId: fx.owner.id }));
    await assert.rejects(db.accountingAccount.update({ where: { id: rent.id }, data: { parentId: expenses.id } }), /closed period/, "re-parenting an account with closed-period lines is blocked");
    await assert.rejects(db.accountingAccount.update({ where: { id: sub.id }, data: { parentId: null } }), /closed period/, "so is moving its ancestor");
    await db.accountingAccount.update({ where: { id: rent.id }, data: { name: "إيجار الفرع" } });
  } finally {
    await teardownTaggedCafe([fx.cafeId, other.fx.cafeId]);
  }
});

test("an account cannot be deactivated while it is the mapping in force", { timeout: 60000 }, async () => {
  await requireServer();
  const { fx, byKey, make, category, map } = await books("ACC009DEACT");
  try {
    const today = dateStrInTz(new Date());
    const acc = await make("5440", { parentId: (await byKey("HEADER_EXPENSES")).id });
    const cat = await category("S4B2_UTIL");
    await map(cat.id, acc.id, addDays(today, -30));
    await assert.rejects(db.accountingAccount.update({ where: { id: acc.id }, data: { isActive: false } }), /Remap the expense categories/, "the latest mapping");
    await map(cat.id, null, addDays(today, 30));
    await assert.rejects(db.accountingAccount.update({ where: { id: acc.id }, data: { isActive: false } }), /Remap the expense categories/, "still in force today; the end is in the future");
    const cat2 = await category("S4B2_RENT");
    const acc2 = await make("5450", { parentId: (await byKey("HEADER_EXPENSES")).id });
    await map(cat2.id, acc.id, addDays(today, -30));
    await map(cat2.id, acc2.id, addDays(today, -10));
    await map(cat.id, acc2.id, addDays(today, 60));
    await assert.rejects(db.accountingAccount.update({ where: { id: acc.id }, data: { isActive: false } }), /Remap the expense categories/, "cat is still on it today");
    const cat3 = await category("S4B2_THIRD");
    const acc3 = await make("5460", { parentId: (await byKey("HEADER_EXPENSES")).id });
    await map(cat3.id, acc3.id, addDays(today, -30));
    await map(cat3.id, null, addDays(today, -10));
    await db.accountingAccount.update({ where: { id: acc3.id }, data: { isActive: false } });
  } finally {
    await teardownTaggedCafe(fx.cafeId);
  }
});
