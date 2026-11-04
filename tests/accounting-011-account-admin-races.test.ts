// ACCOUNTING-011 (Step 4B.2): setup writes stay correct under contention and
// failure — one winner for a contested code or category, no partial write when
// the audit row cannot be written, and a retried response replays instead of
// writing twice.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { db, teardownTaggedCafe } from "./helpers/db";
import { countCafe, COUNT_PASSWORD } from "./helpers/count";
import { as, login, requireServer } from "./helpers/http";
import { addDays, dateStrInTz } from "@/lib/date-range";
import { ensureAccountingEntity } from "@/lib/accounting/chart";

after(async () => { await db.$disconnect(); });

const send = (email: string, path: string, method: "POST" | "PATCH", body: unknown, key = randomUUID()) =>
  as<{ error?: string; account?: { id: string } }>(email, path, { method, body: JSON.stringify(body), headers: { "Idempotency-Key": key } });

test("contested codes and mappings have one winner; a failing audit rolls the write back", { timeout: 180000 }, async () => {
  await requireServer();
  const fx = await countCafe("ACC011RACE");
  try {
    await login(fx.owner.email, COUNT_PASSWORD);
    const entity = await db.$transaction(tx => ensureAccountingEntity(tx, fx.cafeId));
    const header = await db.accountingAccount.findFirstOrThrow({ where: { entityId: entity.id, systemKey: "HEADER_EXPENSES" } });
    const body = (code: string, name: string) => ({ code, name, type: "EXPENSE", parentId: header.id, isPostable: true, reason: "سباق" });

    // Five administrators add the same code at once.
    const created = await Promise.all([1, 2, 3, 4, 5].map(i => send(fx.owner.email, "/api/accounting/accounts", "POST", body("5420", `صيانة ${i}`))));
    const statuses = created.map(r => r.status).sort();
    assert.deepEqual(statuses.filter(s => s === 201), [201], `exactly one creator wins: ${statuses}`);
    assert.ok(statuses.every(s => s === 201 || s === 409 || s === 503), `losers are refused, not errors: ${statuses}`);
    assert.equal(await db.accountingAccount.count({ where: { entityId: entity.id, code: "5420" } }), 1);

    // Two administrators map the same category from the same starting point.
    const util = await db.accountingAccount.create({ data: { cafeId: fx.cafeId, entityId: entity.id, code: "5440", name: "مرافق", type: "EXPENSE", normalBalance: "DEBIT", parentId: header.id } });
    const rent = await db.accountingAccount.create({ data: { cafeId: fx.cafeId, entityId: entity.id, code: "5450", name: "إيجار", type: "EXPENSE", normalBalance: "DEBIT", parentId: header.id } });
    const category = await db.expenseCategory.create({ data: { cafeId: fx.cafeId, code: "S4B2_RACE", nameAr: "مرافق", createdById: fx.owner.id } });
    const date = addDays(dateStrInTz(new Date()), -10);
    const map = (accountId: string) => send(fx.owner.email, "/api/accounting/expense-category-mappings", "POST", { categoryId: category.id, accountId, effectiveFrom: date, expectedLatestEffectiveFrom: null, reason: "سباق", approvalRef: "ACC-RACE" });
    const raced = await Promise.all([map(util.id), map(rent.id)]);
    assert.equal(raced.filter(r => r.status === 201).length, 1, `one mapping wins: ${raced.map(r => r.status)}`);
    assert.ok(raced.some(r => [409, 503].includes(r.status)), "the other sees the change and is refused");
    assert.equal(await db.expenseCategoryAccountMapping.count({ where: { categoryId: category.id } }), 1);

    // The same request retried concurrently (a double-click) writes once.
    const key = randomUUID();
    const twin = await Promise.all([1, 2].map(() => send(fx.owner.email, "/api/accounting/accounts", "POST", body("5460", "تكرار"), key)));
    assert.ok(twin.some(r => r.status === 201));
    assert.equal(await db.accountingAccount.count({ where: { entityId: entity.id, code: "5460" } }), 1, "one account for one key");

    // Audit failure: the account is not left behind.
    const hook = `acc011_${randomUUID().slice(0, 8)}`;
    await db.$executeRawUnsafe(`CREATE FUNCTION ${hook}() RETURNS trigger AS $$ BEGIN IF NEW."cafeId" = '${fx.cafeId}' AND NEW.action = 'ACCOUNTING_ACCOUNT_CREATED' THEN RAISE EXCEPTION 'injected audit failure'; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql`);
    try {
      await db.$executeRawUnsafe(`CREATE TRIGGER ${hook} BEFORE INSERT ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION ${hook}()`);
      try {
        const failed = await send(fx.owner.email, "/api/accounting/accounts", "POST", body("5470", "لن يُحفظ"));
        assert.equal(failed.status, 500, failed.text);
        assert.equal(await db.accountingAccount.count({ where: { entityId: entity.id, code: "5470" } }), 0, "no account without its audit row");
      } finally {
        await db.$executeRawUnsafe(`DROP TRIGGER ${hook} ON "AuditLog"`);
      }
    } finally {
      await db.$executeRawUnsafe(`DROP FUNCTION ${hook}()`);
    }
    const again = await send(fx.owner.email, "/api/accounting/accounts", "POST", body("5470", "بعد الإصلاح"));
    assert.equal(again.status, 201, again.text);
  } finally {
    await teardownTaggedCafe(fx.cafeId);
  }
});
