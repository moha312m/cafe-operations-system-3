// ACCOUNTING-013 (Step 4B.2 closeout): a mapping change that touches operating
// expenses already carrying a journal entry must be acknowledged, the preview
// must count them exactly, the posted entries must survive untouched, a retry must
// leave one mapping and one audit row, and a failing audit must roll everything back.
// Expenses are real (drawer payouts through the API); the journal entries are
// synthetic, posted under the source key the projector would use.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { db, teardownTaggedCafe } from "./helpers/db";
import { countCafe, COUNT_PASSWORD } from "./helpers/count";
import { as, login, requireServer } from "./helpers/http";
import { ensureAccountingEntity } from "@/lib/accounting/chart";
import { openPeriod, postEntry } from "@/lib/accounting/ledger";
import { expenseSourceKey } from "@/lib/expense-rules";
import { addDays, dateStrInTz } from "@/lib/date-range";

after(async () => { await db.$disconnect(); });

type Preview = { impact: { count: number; total: number; postedCount: number; postedTotal: number }; account: { eligible: boolean } | null };
type Json = { error?: string; mapping?: { id: string }; impact?: Preview["impact"]; id?: string };

test("posted expenses need an acknowledgement; entries survive; retry and audit failure behave", { timeout: 240000 }, async () => {
  await requireServer();
  const fx = await countCafe("ACC013ACK");
  try {
    await db.cafe.update({ where: { id: fx.cafeId }, data: { currency: "EGP" } }); // drawer expenses are EGP-only
    await login(fx.owner.email, COUNT_PASSWORD);
    const grant = await as(fx.owner.email, `/api/users/${fx.manager.id}/permissions`, { method: "PUT", body: JSON.stringify({ overrides: [{ key: "expenses.view", allowed: true }, { key: "expenses.manage", allowed: true }] }) });
    assert.equal(grant.status, 200, grant.text);
    await login(fx.manager.email, COUNT_PASSWORD);
    const entity = await db.$transaction(tx => ensureAccountingEntity(tx, fx.cafeId));
    const header = await db.accountingAccount.findFirstOrThrow({ where: { entityId: entity.id, systemKey: "HEADER_EXPENSES" } });
    const accA = await db.accountingAccount.create({ data: { cafeId: fx.cafeId, entityId: entity.id, code: "5441", name: "مرافق", type: "EXPENSE", normalBalance: "DEBIT", parentId: header.id } });
    const accB = await db.accountingAccount.create({ data: { cafeId: fx.cafeId, entityId: entity.id, code: "5442", name: "مرافق بديل", type: "EXPENSE", normalBalance: "DEBIT", parentId: header.id } });
    const cat = await db.expenseCategory.create({ data: { cafeId: fx.cafeId, code: "S4B2_ACK", nameAr: "مرافق", createdById: fx.owner.id } });
    const other = await db.expenseCategory.create({ data: { cafeId: fx.cafeId, code: "S4B2_ACK_OTHER", nameAr: "أخرى", createdById: fx.owner.id } });

    // Real drawer payouts: three in the category (two will be "posted"), one in another category.
    const shift = await as<{ shift?: { id: string } }>(fx.manager.email, "/api/shifts", { method: "POST", body: JSON.stringify({ branchId: fx.branchId, openingCashAmount: 1000 }) });
    assert.ok([200, 201].includes(shift.status), `shift: ${shift.text}`);
    const pay = (categoryId: string, amount: number) => as<Json>(fx.manager.email, "/api/expenses", { method: "POST", headers: { "Idempotency-Key": randomUUID() }, body: JSON.stringify({ branchId: fx.branchId, categoryId, amount, description: "مصروف تجريبي للاعتماد" }) });
    const e1 = await pay(cat.id, 10.5), e2 = await pay(cat.id, 20), e3 = await pay(cat.id, 7.25), e4 = await pay(other.id, 99);
    for (const e of [e1, e2, e3, e4]) assert.equal(e.status, 201, e.text);

    // Synthetic journal entries for two of them, dated on the expense day, under the projector's source key.
    const day = dateStrInTz(new Date());
    await db.$transaction(tx => openPeriod(tx, { cafeId: fx.cafeId, startsOn: addDays(day, -2), endsOn: addDays(day, 40) }));
    const post = (id: string, amount: number, account: string) => db.$transaction(tx => postEntry(tx, { cafeId: fx.cafeId, entryDate: day, description: "مصروف تشغيلي مدفوع", sourceType: "OPERATING_EXPENSE", sourceId: id, sourceKey: expenseSourceKey("expense", id), lines: [{ account: { id: account }, branchId: fx.branchId, debit: amount }, { account: { key: "CASH_DRAWER" }, branchId: fx.branchId, credit: amount }] }));
    await post(e1.body.id!, 10.5, accA.id);
    await post(e2.body.id!, 20, accA.id);
    const entriesBefore = await db.journalEntry.findMany({ where: { cafeId: fx.cafeId }, orderBy: { number: "asc" }, include: { lines: { orderBy: { id: "asc" } } } });
    assert.equal(entriesBefore.length, 2);

    // Preview counts: 3 expenses in the category (38 + ...), 2 posted.
    const preview = await as<Preview>(fx.owner.email, `/api/accounting/expense-category-mappings/preview?categoryId=${cat.id}&effectiveFrom=${addDays(day, -1)}&accountId=${accB.id}`);
    assert.equal(preview.status, 200, preview.text);
    assert.deepEqual(preview.body.impact, { count: 3, total: 37.75, postedCount: 2, postedTotal: 30.5 });
    assert.equal(preview.body.account?.eligible, true);
    const later = await as<Preview>(fx.owner.email, `/api/accounting/expense-category-mappings/preview?categoryId=${cat.id}&effectiveFrom=${addDays(day, 1)}`);
    assert.deepEqual(later.body.impact, { count: 0, total: 0, postedCount: 0, postedTotal: 0 }, "a future date touches nothing yet");
    const otherPreview = await as<Preview>(fx.owner.email, `/api/accounting/expense-category-mappings/preview?categoryId=${other.id}&effectiveFrom=${addDays(day, -1)}`);
    assert.deepEqual(otherPreview.body.impact, { count: 1, total: 99, postedCount: 0, postedTotal: 0 }, "another category is counted separately");

    const body = (extra: Record<string, unknown> = {}) => ({ categoryId: cat.id, accountId: accA.id, effectiveFrom: addDays(day, -1), expectedLatestEffectiveFrom: null, reason: "اعتماد", approvalRef: "ACC-ACK-1", ...extra });
    const send = (b: unknown, key = randomUUID()) => as<Json>(fx.owner.email, "/api/accounting/expense-category-mappings", { method: "POST", headers: { "Idempotency-Key": key }, body: JSON.stringify(b) });

    // A first mapping that changes the account for posted expenses needs the acknowledgement.
    const refused = await send(body());
    assert.equal(refused.status, 409, refused.text);
    assert.match(refused.body.error ?? "", /2 مصروف مترحّل/);
    assert.equal(await db.expenseCategoryAccountMapping.count({ where: { cafeId: fx.cafeId } }), 0, "refusal wrote nothing");

    // Audit failure rolls the acknowledged change back.
    const hook = `acc013_${randomUUID().slice(0, 8)}`;
    await db.$executeRawUnsafe(`CREATE FUNCTION ${hook}() RETURNS trigger AS $$ BEGIN IF NEW."cafeId" = '${fx.cafeId}' AND NEW.action = 'EXPENSE_CATEGORY_MAPPING_CHANGED' THEN RAISE EXCEPTION 'injected audit failure'; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql`);
    try {
      await db.$executeRawUnsafe(`CREATE TRIGGER ${hook} BEFORE INSERT ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION ${hook}()`);
      try {
        const failed = await send(body({ acknowledgePostedNotReclassified: true }));
        assert.equal(failed.status, 500, failed.text);
        assert.equal(await db.expenseCategoryAccountMapping.count({ where: { cafeId: fx.cafeId } }), 0, "no mapping without its audit row");
      } finally { await db.$executeRawUnsafe(`DROP TRIGGER ${hook} ON "AuditLog"`); }
    } finally { await db.$executeRawUnsafe(`DROP FUNCTION ${hook}()`); }

    // Acknowledged, with an idempotent retry: one mapping, one audit row, same answer.
    const key = randomUUID();
    const ok = await send(body({ acknowledgePostedNotReclassified: true }), key);
    assert.equal(ok.status, 201, ok.text);
    assert.deepEqual(ok.body.impact, { count: 3, total: 37.75, postedCount: 2, postedTotal: 30.5 });
    const retry = await send(body({ acknowledgePostedNotReclassified: true }), key);
    assert.equal(retry.status, 201);
    assert.equal(retry.headers.get("Idempotency-Replayed"), "true");
    assert.equal(retry.body.mapping?.id, ok.body.mapping?.id);
    assert.equal(await db.expenseCategoryAccountMapping.count({ where: { cafeId: fx.cafeId } }), 1);
    const audits = await db.auditLog.findMany({ where: { cafeId: fx.cafeId, action: "EXPENSE_CATEGORY_MAPPING_CHANGED" } });
    assert.equal(audits.length, 1);
    assert.equal((audits[0].details as { acknowledgedPostedNotReclassified?: boolean }).acknowledgedPostedNotReclassified, true);

    // Changing to the same account needs no acknowledgement; moving to B (future) does not touch posted lines.
    const move = await send(body({ accountId: accB.id, effectiveFrom: addDays(day, 5), expectedLatestEffectiveFrom: addDays(day, -1) }));
    assert.equal(move.status, 201, move.text);
    assert.equal(move.body.impact?.postedCount, 0, "nothing posted exists on or after the future date");

    // The journal is exactly as it was: same entries, same lines, same accounts.
    const entriesAfter = await db.journalEntry.findMany({ where: { cafeId: fx.cafeId }, orderBy: { number: "asc" }, include: { lines: { orderBy: { id: "asc" } } } });
    assert.deepEqual(entriesAfter.map(e => [e.id, e.number, e.sourceKey, e.lines.map(l => [l.accountId, String(l.debit), String(l.credit)])]), entriesBefore.map(e => [e.id, e.number, e.sourceKey, e.lines.map(l => [l.accountId, String(l.debit), String(l.credit)])]));
  } finally {
    await teardownTaggedCafe(fx.cafeId);
  }
});
