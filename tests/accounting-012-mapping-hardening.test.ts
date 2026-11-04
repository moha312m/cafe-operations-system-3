// ACCOUNTING-012 (Step 4B.2 closeout): hardening of the expense category mapping.
// Reproduces and closes: deactivating an account that a future mapping interval
// still needs; mapping to accounts that are not ordinary operating expenses;
// closed-period protection for ANY writer; accounts changing type, side or
// postability under an existing mapping; and a deactivate-versus-map race.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { db, teardownTaggedCafe } from "./helpers/db";
import { countCafe } from "./helpers/count";
import { requireServer } from "./helpers/http";
import { ensureAccountingEntity } from "@/lib/accounting/chart";
import { openPeriod, closePeriod } from "@/lib/accounting/ledger";
import { addDays, dateStrInTz } from "@/lib/date-range";
import { NON_OPERATING_EXPENSE_KEYS, protectedMappingAccountIds } from "@/lib/accounting/chart-view";

after(async () => { await db.$disconnect(); });

const TODAY = dateStrInTz(new Date());
const at = (days: number) => addDays(TODAY, days);

async function books(name: string) {
  const fx = await countCafe(name);
  const entity = await db.$transaction(tx => ensureAccountingEntity(tx, fx.cafeId));
  const header = await db.accountingAccount.findFirstOrThrow({ where: { entityId: entity.id, systemKey: "HEADER_EXPENSES" } });
  const make = (code: string, over: Record<string, unknown> = {}) => db.accountingAccount.create({ data: { cafeId: fx.cafeId, entityId: entity.id, code, name: `حساب ${code}`, type: "EXPENSE", normalBalance: "DEBIT", parentId: header.id, ...over } as never });
  const category = (code: string) => db.expenseCategory.create({ data: { cafeId: fx.cafeId, code, nameAr: `تصنيف ${code}`, createdById: fx.owner.id } });
  const map = (categoryId: string, accountId: string | null, days: number) => db.expenseCategoryAccountMapping.create({ data: { cafeId: fx.cafeId, entityId: entity.id, categoryId, accountId, effectiveFrom: new Date(`${at(days)}T00:00:00Z`), reason: "اختبار الربط", approvalRef: "ACC-012", createdById: fx.owner.id } });
  const deactivate = (id: string) => db.accountingAccount.update({ where: { id }, data: { isActive: false } });
  return { fx, entity, header, make, category, map, deactivate };
}
const BLOCKED = /Remap the expense categories/;

test("an account is protected for every interval that still needs it, and freed once its intervals have ended", { timeout: 90000 }, async () => {
  await requireServer();
  const { fx, make, category, map, deactivate } = await books("ACC012GAP");
  try {
    const [a, b, c, d] = [await make("5441"), await make("5442"), await make("5443"), await make("5444")];
    const cat = await category("S4B2_GAP");
    await map(cat.id, a.id, -30);   // A today
    await map(cat.id, b.id, 30);    // B from a future date
    await map(cat.id, c.id, 60);    // C from a later future date
    await assert.rejects(deactivate(a.id), BLOCKED, "A is in force today");
    await assert.rejects(deactivate(b.id), BLOCKED, "B is needed from day +30 until day +60 (the reported gap)");
    await assert.rejects(deactivate(c.id), BLOCKED, "C is the latest");
    await deactivate(d.id); // never mapped

    // A future UNLINK row: the account stays needed until the unlink date, and the unlink row itself protects nothing.
    const cat2 = await category("S4B2_UNLINK");
    const e = await make("5445");
    await map(cat2.id, e.id, -10);
    await map(cat2.id, null, 20);
    await assert.rejects(deactivate(e.id), BLOCKED, "in force until a future unlink");

    // Two categories: an account freed by one is still needed by the other.
    const cat3 = await category("S4B2_TWO");
    const cat4 = await category("S4B2_TWO_B");
    const f = await make("5446"), g = await make("5447");
    await map(cat3.id, f.id, -30);
    await map(cat3.id, g.id, -10);   // F's interval ended in the past
    await map(cat4.id, f.id, -5);    // but another category uses F today
    await assert.rejects(deactivate(f.id), BLOCKED, "another category still uses it");
    const h = await make("5448");
    await map(cat3.id, h.id, 5);
    await assert.rejects(deactivate(g.id), BLOCKED, "G is in force today for category 3");
    await map(cat4.id, g.id, 10);
    await assert.rejects(deactivate(f.id), BLOCKED, "F still in force today for category 4 (G only starts on day 10)");

    // Ended intervals are freed.
    const cat5 = await category("S4B2_ENDED");
    const i = await make("5449"), j = await make("5451");
    await map(cat5.id, i.id, -30);
    await map(cat5.id, j.id, -10);
    await deactivate(i.id);

    // The application-side view agrees with the trigger.
    const rows = [
      { categoryId: cat.id, accountId: a.id, effectiveFrom: at(-30) }, { categoryId: cat.id, accountId: b.id, effectiveFrom: at(30) }, { categoryId: cat.id, accountId: c.id, effectiveFrom: at(60) },
      { categoryId: cat5.id, accountId: i.id, effectiveFrom: at(-30) }, { categoryId: cat5.id, accountId: j.id, effectiveFrom: at(-10) },
      { categoryId: cat2.id, accountId: e.id, effectiveFrom: at(-10) }, { categoryId: cat2.id, accountId: null, effectiveFrom: at(20) },
    ];
    const guarded = protectedMappingAccountIds(rows, TODAY);
    assert.deepEqual([...guarded].sort(), [a.id, b.id, c.id, e.id, j.id].sort());
  } finally {
    await teardownTaggedCafe(fx.cafeId);
  }
});

test("mappings accept only ordinary operating expense accounts — by system identity, not by code or name", { timeout: 90000 }, async () => {
  await requireServer();
  const { fx, entity, make, category, map } = await books("ACC012ELIG");
  try {
    const cat = await category("S4B2_ELIG");
    for (const key of NON_OPERATING_EXPENSE_KEYS) {
      const account = await db.accountingAccount.findFirstOrThrow({ where: { entityId: entity.id, systemKey: key } });
      await assert.rejects(map(cat.id, account.id, -5), /operating expense account/, key);
    }
    // The database's own list must be the application's list.
    const sql = await db.$queryRaw<{ key: string; excluded: boolean }[]>`SELECT k AS key, "expense_mapping_excluded_key"(k) AS excluded FROM unnest(ARRAY['COST_OF_SALES','PURCHASE_DISCOUNTS','INVENTORY_LOSS','CASH_OVER_SHORT','OTHER_OPERATING_EXPENSE','SALES']) AS k`;
    assert.deepEqual(sql.filter(r => r.excluded).map(r => r.key).sort(), [...NON_OPERATING_EXPENSE_KEYS].sort());

    // 5900 (OTHER_OPERATING_EXPENSE) and custom accounts remain valid, whatever they are called or numbered.
    const other = await db.accountingAccount.findFirstOrThrow({ where: { entityId: entity.id, systemKey: "OTHER_OPERATING_EXPENSE" } });
    const custom = await make("5100", { name: "تكلفة مبيعات (اسم مضلل لحساب مخصص)" }).catch(() => make("5499", { name: "تكلفة مبيعات (اسم مضلل لحساب مخصص)" }));
    await map(cat.id, other.id, -5);
    await map((await category("S4B2_ELIG2")).id, custom.id, -5);
  } finally {
    await teardownTaggedCafe(fx.cafeId);
  }
});

test("closed periods bind any writer, and accounts cannot change under an existing mapping", { timeout: 90000 }, async () => {
  await requireServer();
  const { fx, entity, make, category, map } = await books("ACC012GUARD");
  try {
    await db.$transaction(tx => openPeriod(tx, { cafeId: fx.cafeId, startsOn: at(-120), endsOn: at(-91) }));
    const period = await db.accountingPeriod.findFirstOrThrow({ where: { entityId: entity.id } });
    await db.$transaction(tx => closePeriod(tx, { cafeId: fx.cafeId, periodId: period.id, actorId: fx.owner.id }));
    const acc = await make("5450");
    const cat = await category("S4B2_CLOSED");
    await assert.rejects(map(cat.id, acc.id, -100), /closed accounting period/, "inside the closed period");
    await assert.rejects(map(cat.id, acc.id, -91), /closed accounting period/, "its last day");
    await assert.rejects(map(cat.id, null, -95), /closed accounting period/, "an unlink row too");
    await map(cat.id, acc.id, -90);

    // Type, side and postability are frozen for any account a mapping row has ever named.
    for (const data of [{ type: "LIABILITY", normalBalance: "CREDIT" }, { normalBalance: "CREDIT" }, { isPostable: false }]) {
      await assert.rejects(db.accountingAccount.update({ where: { id: acc.id }, data: data as never }), /expense category mapping keeps/, JSON.stringify(data));
    }
    await map(cat.id, null, -40);
    await assert.rejects(db.accountingAccount.update({ where: { id: acc.id }, data: { normalBalance: "CREDIT" } }), /expense category mapping keeps/, "history still pins it");
    await db.accountingAccount.update({ where: { id: acc.id }, data: { name: "إيجار", code: "5455" } });
  } finally {
    await teardownTaggedCafe(fx.cafeId);
  }
});

test("deactivating an account and mapping to it at the same moment cannot both succeed", { timeout: 90000 }, async () => {
  await requireServer();
  const { fx, make, category } = await books("ACC012RACE");
  try {
    const run = async (i: number) => {
      const acc = await make(`56${String(i).padStart(2, "0")}`);
      const cat = await category(`S4B2_RACE${i}`);
      const release: { go: () => void } = { go: () => undefined };
      const gate = new Promise<void>(resolve => { release.go = resolve; });
      const deactivate = db.$transaction(async tx => {
        await tx.accountingAccount.update({ where: { id: acc.id }, data: { isActive: false } });
        await gate; // hold the first writer open while the second arrives
      }, { timeout: 20000 });
      await new Promise(r => setTimeout(r, 150));
      const mapping = db.expenseCategoryAccountMapping.create({ data: { cafeId: fx.cafeId, entityId: acc.entityId, categoryId: cat.id, accountId: acc.id, effectiveFrom: new Date(`${at(-5)}T00:00:00Z`), reason: "سباق", approvalRef: "ACC-RACE", createdById: fx.owner.id } }).then(() => "mapped", () => "refused");
      await new Promise(r => setTimeout(r, 300));
      release.go();
      await deactivate;
      const outcome = await mapping;
      const inactive = !(await db.accountingAccount.findUniqueOrThrow({ where: { id: acc.id } })).isActive;
      const mapped = (await db.expenseCategoryAccountMapping.count({ where: { accountId: acc.id } })) > 0;
      assert.ok(!(inactive && mapped), `round ${i}: an inactive account must not be mapped (${outcome})`);
      return outcome;
    };
    assert.deepEqual(await Promise.all([1, 2, 3].map(run)), ["refused", "refused", "refused"]);
  } finally {
    await teardownTaggedCafe(fx.cafeId);
  }
});
