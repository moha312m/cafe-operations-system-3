// ACCOUNTING-010 (Step 4B.2): the account administration and category mapping API.
// accounting.setup is enforced server-side, writes are idempotent and serialise
// with the books, the owner gets a reason for every refusal, another café's ids
// are invisible, every write leaves an audit row, and nothing is ever posted.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { db, teardownTaggedCafe } from "./helpers/db";
import { countCafe, COUNT_PASSWORD } from "./helpers/count";
import { as, login, requireServer } from "./helpers/http";
import { ensureAccountingEntity } from "@/lib/accounting/chart";
import { addDays, dateStrInTz } from "@/lib/date-range";
import { openPeriod, closePeriod } from "@/lib/accounting/ledger";

const TODAY = dateStrInTz(new Date());
const at = (days: number) => addDays(TODAY, days);

after(async () => { await db.$disconnect(); });

const post = (email: string, path: string, body: unknown, key: string | null = crypto.randomUUID()) =>
  as<{ account: { id: string; name: string; normalBalance: string } }>(email, path, { method: "POST", body: JSON.stringify(body), headers: key ? { "Idempotency-Key": key } : {} });
const patch = (email: string, path: string, body: unknown, key: string | null = crypto.randomUUID()) =>
  as<{ account: { id: string; name: string; normalBalance: string } }>(email, path, { method: "PATCH", body: JSON.stringify(body), headers: key ? { "Idempotency-Key": key } : {} });

test("setup writes need accounting.setup, books that exist, and an Idempotency-Key", { timeout: 90000 }, async () => {
  await requireServer();
  const fx = await countCafe("ACC010GATE");
  try {
    await login(fx.owner.email, COUNT_PASSWORD);
    await login(fx.cashier.email, COUNT_PASSWORD);
    await login(fx.manager.email, COUNT_PASSWORD);
    const body = { code: "5410", name: "نظافة", type: "EXPENSE", parentId: "x", isPostable: true, reason: "اختبار" };
    assert.equal((await post(fx.cashier.email, "/api/accounting/accounts", body)).status, 403, "cashier");
    assert.equal((await post(fx.manager.email, "/api/accounting/accounts", body)).status, 403, "branch manager has no setup key");
    assert.equal((await post(fx.owner.email, "/api/accounting/accounts", body, null)).status, 400, "key required");
    const none = await post(fx.owner.email, "/api/accounting/accounts", body);
    assert.equal(none.status, 409, none.text);
    assert.equal(await db.accountingEntity.count({ where: { cafeId: fx.cafeId } }), 0, "a refused write never creates books");
    assert.equal((await as(fx.owner.email, "/api/accounting/expense-category-mappings/preview?categoryId=x&effectiveFrom=2026-11-01")).status, 409);
  } finally {
    await teardownTaggedCafe(fx.cafeId);
  }
});

test("accounts: create, replay, refuse with reasons, rename, protect system accounts, isolate cafés, audit", { timeout: 120000 }, async () => {
  await requireServer();
  const fx = await countCafe("ACC010ACC");
  const other = await countCafe("ACC010ACCX");
  try {
    await login(fx.owner.email, COUNT_PASSWORD);
    await login(other.owner.email, COUNT_PASSWORD);
    const entity = await db.$transaction(tx => ensureAccountingEntity(tx, fx.cafeId));
    const otherEntity = await db.$transaction(tx => ensureAccountingEntity(tx, other.cafeId));
    const key = (systemKey: string) => db.accountingAccount.findFirstOrThrow({ where: { entityId: entity.id, systemKey } });
    const header = await key("HEADER_EXPENSES"), cash = await key("CASH_DRAWER"), cogs = await key("COST_OF_SALES");
    const foreign = await db.accountingAccount.findFirstOrThrow({ where: { entityId: otherEntity.id, systemKey: "OTHER_OPERATING_EXPENSE" } });
    const entriesBefore = await db.journalEntry.count({ where: { cafeId: fx.cafeId } });

    const base = { code: "5410", name: "نظافة ومستلزمات نظافة", type: "EXPENSE", parentId: header.id, isPostable: true, reason: "ربط تصنيف النظافة" };
    const replayKey = crypto.randomUUID();
    const created = await post(fx.owner.email, "/api/accounting/accounts", base, replayKey);
    assert.equal(created.status, 201, created.text);
    assert.equal(created.body.account.normalBalance, "DEBIT");
    const replay = await post(fx.owner.email, "/api/accounting/accounts", base, replayKey);
    assert.equal(replay.status, 201);
    assert.equal(replay.body.account.id, created.body.account.id, "same key, same result");
    assert.equal(replay.headers.get("Idempotency-Replayed"), "true");
    assert.equal((await post(fx.owner.email, "/api/accounting/accounts", { ...base, code: "5411" }, replayKey)).status, 409, "same key, different payload");
    assert.equal(await db.accountingAccount.count({ where: { entityId: entity.id, code: "5410" } }), 1, "the retry created nothing new");

    const refuse = async (over: Record<string, unknown>, status: number, why: string) => assert.equal((await post(fx.owner.email, "/api/accounting/accounts", { ...base, ...over })).status, status, why);
    await refuse({}, 409, "duplicate code");
    await refuse({ code: "541" }, 400, "code format");
    await refuse({ code: "5412", parentId: cogs.id }, 400, "postable parent");
    await refuse({ code: "5413", type: "ASSET" }, 400, "parent of another type");
    await refuse({ code: "5414", parentId: foreign.id }, 404, "another café's parent");
    await refuse({ code: "5415", reason: "" }, 400, "reason required");
    await refuse({ code: "5416", extra: 1 }, 400, "unknown field");
    const contra = await post(fx.owner.email, "/api/accounting/accounts", { ...base, code: "5417", contra: true });
    assert.equal(contra.body.account.normalBalance, "CREDIT", "an explicit contra flips the side");

    const id = created.body.account.id as string;
    const renamed = await patch(fx.owner.email, `/api/accounting/accounts/${id}`, { name: "نظافة", reason: "اسم مختصر" });
    assert.equal(renamed.status, 200, renamed.text);
    assert.equal(renamed.body.account.name, "نظافة");
    assert.equal((await patch(fx.owner.email, `/api/accounting/accounts/${id}`, { name: "نظافة", reason: "بدون تغيير" })).status, 400, "no real change");
    assert.equal((await patch(fx.owner.email, `/api/accounting/accounts/${cash.id}`, { name: "نقدية الدرج", reason: "اسم" })).status, 200, "system account may be renamed");
    assert.equal((await patch(fx.owner.email, `/api/accounting/accounts/${cash.id}`, { code: "1119", reason: "ترقيم المحاسب" })).status, 200, "system accounts post by key, so they may be renumbered");
    assert.equal((await patch(fx.owner.email, `/api/accounting/accounts/${cash.id}`, { code: "5410", reason: "تعارض" })).status, 409, "but not onto a taken code");
    assert.equal((await patch(fx.owner.email, `/api/accounting/accounts/${cash.id}`, { parentId: header.id, reason: "نقل" })).status, 409, "system account cannot move");
    assert.equal((await patch(fx.owner.email, `/api/accounting/accounts/${cash.id}`, { isActive: false, reason: "غلط" })).status, 409, "system account cannot be stopped");
    assert.equal((await patch(fx.owner.email, `/api/accounting/accounts/${foreign.id}`, { name: "اختراق", reason: "غلط" })).status, 404, "another café's account is invisible");
    assert.equal((await patch(other.owner.email, `/api/accounting/accounts/${id}`, { name: "اختراق", reason: "غلط" })).status, 404, "and so is ours to them");
    assert.equal((await patch(fx.owner.email, `/api/accounting/accounts/${id}`, { parentId: cogs.id, reason: "غلط" })).status, 400, "postable parent on move");
    assert.equal((await patch(fx.owner.email, `/api/accounting/accounts/${id}`, { isActive: false, reason: "إيقاف" })).status, 200);
    assert.equal((await patch(fx.owner.email, `/api/accounting/accounts/${id}`, { isActive: true, reason: "تفعيل" })).status, 200);

    assert.equal(await db.auditLog.count({ where: { cafeId: fx.cafeId, action: "ACCOUNTING_ACCOUNT_CREATED" } }), 2);
    assert.equal(await db.auditLog.count({ where: { cafeId: fx.cafeId, action: "ACCOUNTING_ACCOUNT_UPDATED" } }), 5);
    assert.equal(await db.journalEntry.count({ where: { cafeId: fx.cafeId } }), entriesBefore, "administration never posts");
  } finally {
    await teardownTaggedCafe([fx.cafeId, other.cafeId]);
  }
});

test("mapping: effective dates, stale edits, closed periods, history, deactivation and the chart read", { timeout: 120000 }, async () => {
  await requireServer();
  const fx = await countCafe("ACC010MAP");
  const other = await countCafe("ACC010MAPX");
  try {
    await login(fx.owner.email, COUNT_PASSWORD);
    const entity = await db.$transaction(tx => ensureAccountingEntity(tx, fx.cafeId));
    const otherEntity = await db.$transaction(tx => ensureAccountingEntity(tx, other.cafeId));
    const header = await db.accountingAccount.findFirstOrThrow({ where: { entityId: entity.id, systemKey: "HEADER_EXPENSES" } });
    const util = await db.accountingAccount.create({ data: { cafeId: fx.cafeId, entityId: entity.id, code: "5440", name: "مرافق", type: "EXPENSE", normalBalance: "DEBIT", parentId: header.id } });
    const rent = await db.accountingAccount.create({ data: { cafeId: fx.cafeId, entityId: entity.id, code: "5450", name: "إيجار", type: "EXPENSE", normalBalance: "DEBIT", parentId: header.id } });
    const cash = await db.accountingAccount.findFirstOrThrow({ where: { entityId: entity.id, systemKey: "CASH_DRAWER" } });
    const category = await db.expenseCategory.create({ data: { cafeId: fx.cafeId, code: "S4B2_UTIL", nameAr: "مرافق", createdById: fx.owner.id } });
    const foreignCategory = await db.expenseCategory.create({ data: { cafeId: other.cafeId, code: "S4B2_X", nameAr: "مرافق", createdById: other.owner.id } });
    void otherEntity;

    const map = (over: Record<string, unknown>, key: string | null = crypto.randomUUID()) =>
      post(fx.owner.email, "/api/accounting/expense-category-mappings", { categoryId: category.id, accountId: util.id, effectiveFrom: at(-30), expectedLatestEffectiveFrom: null, reason: "ربط المرافق", approvalRef: "ACC-REF-1", ...over }, key);

    const preview = await as<{ impact: { count: number; postedCount: number }; latestEffectiveFrom: string | null }>(fx.owner.email, `/api/accounting/expense-category-mappings/preview?categoryId=${category.id}&effectiveFrom=${at(-30)}`);
    assert.equal(preview.status, 200, preview.text);
    assert.deepEqual([preview.body.impact.count, preview.body.impact.postedCount, preview.body.latestEffectiveFrom], [0, 0, null]);
    assert.equal((await as(fx.owner.email, `/api/accounting/expense-category-mappings/preview?categoryId=${foreignCategory.id}&effectiveFrom=${at(-30)}`)).status, 404, "another café's category");

    assert.equal((await map({ approvalRef: "" })).status, 400, "approval reference required");
    assert.equal((await map({ accountId: cash.id })).status, 400, "not an expense account");
    assert.equal((await map({ accountId: header.id })).status, 400, "a header");
    assert.equal((await map({ categoryId: foreignCategory.id })).status, 404, "another café's category");
    assert.equal((await map({ effectiveFrom: "2019-01-01" })).status, 400, "absurd date");
    assert.equal(await db.expenseCategoryAccountMapping.count({ where: { cafeId: fx.cafeId } }), 0, "refusals write nothing");

    const key = crypto.randomUUID();
    const first = await map({}, key);
    assert.equal(first.status, 201, first.text);
    assert.equal((await map({}, key)).headers.get("Idempotency-Replayed"), "true");
    assert.equal(await db.expenseCategoryAccountMapping.count({ where: { cafeId: fx.cafeId } }), 1, "a retried request writes one row");

    assert.equal((await map({ accountId: rent.id, effectiveFrom: at(-20), expectedLatestEffectiveFrom: null })).status, 409, "stale expectation (someone else changed it)");
    assert.equal((await map({ accountId: rent.id, effectiveFrom: at(-30), expectedLatestEffectiveFrom: at(-30) })).status, 400, "not after the last mapping");
    assert.equal((await map({ accountId: rent.id, effectiveFrom: at(-40), expectedLatestEffectiveFrom: at(-30) })).status, 400, "dates only move forward");

    assert.equal((await patch(fx.owner.email, `/api/accounting/accounts/${util.id}`, { isActive: false, reason: "إيقاف" })).status, 409, "cannot deactivate the mapped account");
    const future = await map({ accountId: rent.id, effectiveFrom: at(30), expectedLatestEffectiveFrom: at(-30) });
    assert.equal(future.status, 201, future.text);
    assert.equal((await patch(fx.owner.email, `/api/accounting/accounts/${util.id}`, { isActive: false, reason: "إيقاف" })).status, 409, "util is still in force today; rent only starts in 30 days");
    assert.equal((await patch(fx.owner.email, `/api/accounting/accounts/${rent.id}`, { isActive: false, reason: "إيقاف" })).status, 409, "rent is the latest mapping");

    const ended = await map({ accountId: null, effectiveFrom: at(60), expectedLatestEffectiveFrom: at(30) });
    assert.equal(ended.status, 201, ended.text);

    // A second category whose older mapping is genuinely in the past may free its account.
    const second = await db.expenseCategory.create({ data: { cafeId: fx.cafeId, code: "S4B2_RENT", nameAr: "إيجار", createdById: fx.owner.id } });
    const spare = await db.accountingAccount.create({ data: { cafeId: fx.cafeId, entityId: entity.id, code: "5460", name: "بديل", type: "EXPENSE", normalBalance: "DEBIT", parentId: header.id } });
    const m2 = (over: Record<string, unknown>) => post(fx.owner.email, "/api/accounting/expense-category-mappings", { categoryId: second.id, accountId: spare.id, effectiveFrom: at(-20), expectedLatestEffectiveFrom: null, reason: "ربط", approvalRef: "ACC-REF-2", ...over });
    assert.equal((await m2({})).status, 201);
    assert.equal((await m2({ accountId: util.id, effectiveFrom: at(-5), expectedLatestEffectiveFrom: at(-20) })).status, 201);
    assert.equal((await patch(fx.owner.email, `/api/accounting/accounts/${spare.id}`, { isActive: false, reason: "إيقاف بعد استبداله" })).status, 200, "replaced in the past, no longer in force");

    // Closed periods: a mapping cannot be dated inside one.
    await db.$transaction(tx => openPeriod(tx, { cafeId: fx.cafeId, startsOn: at(-120), endsOn: at(-91) }));
    const period = await db.accountingPeriod.findFirstOrThrow({ where: { entityId: entity.id } });
    await db.$transaction(tx => closePeriod(tx, { cafeId: fx.cafeId, periodId: period.id, actorId: fx.owner.id }));
    const third = await db.expenseCategory.create({ data: { cafeId: fx.cafeId, code: "S4B2_THIRD", nameAr: "ثالث", createdById: fx.owner.id } });
    const m3 = (effectiveFrom: string) => post(fx.owner.email, "/api/accounting/expense-category-mappings", { categoryId: third.id, accountId: rent.id, effectiveFrom, expectedLatestEffectiveFrom: null, reason: "ربط", approvalRef: "ACC-REF-3" });
    assert.equal((await m3(at(-100))).status, 400, "inside a closed period");
    assert.equal((await m3(at(-90))).status, 201, "the day after it closes is fine");

    // The chart read exposes saved mappings, history and the setup flag.
    type Saved = { current: { accountCode: string } | null; ended: boolean; latestEffectiveFrom: string | null; history: unknown[] };
    const chart = await as<{ canSetup: boolean; mapping: { rows: { categoryCode: string; saved: Saved }[]; expenseAccounts: { code: string }[] } }>(fx.owner.email, "/api/accounting/chart-of-accounts");
    assert.equal(chart.status, 200, chart.text);
    assert.equal(chart.body.canSetup, true);
    const row = (code: string) => chart.body.mapping.rows.find(r => r.categoryCode === code)!;
    assert.equal(row("S4B2_UTIL").saved.current?.accountCode, "5440", "in force today: the first mapping");
    assert.equal(row("S4B2_UTIL").saved.history.length, 3, "history keeps every row");
    assert.equal(row("S4B2_UTIL").saved.latestEffectiveFrom, at(60));
    assert.equal(row("S4B2_RENT").saved.current?.accountCode, "5440");
    assert.ok(chart.body.mapping.expenseAccounts.some(a => a.code === "5450") && !chart.body.mapping.expenseAccounts.some(a => a.code === "5460"), "only active postable expense accounts are offered");

    assert.equal(await db.auditLog.count({ where: { cafeId: fx.cafeId, action: "EXPENSE_CATEGORY_MAPPING_CHANGED" } }), 6);
    assert.equal(await db.journalEntry.count({ where: { cafeId: fx.cafeId } }), 0, "mapping never posts");
  } finally {
    await teardownTaggedCafe([fx.cafeId, other.cafeId]);
  }
});
