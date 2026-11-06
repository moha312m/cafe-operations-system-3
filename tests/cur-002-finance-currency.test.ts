// CUR-002 - drawer expenses and the treasury follow the cafe's currency (C9 of the branch-currency work).
//
// Migration 20261106131000_finance_currency_follows_cafe replaces "currency = 'EGP'" in four CHECKs and one
// trigger clause with "the cafe's currency". These tests prove (1) nothing else in those objects changed,
// (2) the database refuses a money row in another currency, (3) a SAR cafe and an EGP cafe both run the real
// flows end to end (treasury accounts and an InstaPay transfer with its movements, a drawer expense and its
// return), and (4) the old EGP-only literals are gone.
// The older finance runtime suites (expenses-006..008, treasury-003..006) are pinned to the finf5 database and
// are not runnable on cafe_ops_test; this suite re-proves the same behaviours on the current tree.

import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { db, teardownTaggedCafe } from "./helpers/db";
import { countCafe, type CountCafe } from "./helpers/count";
import { as, requireServer } from "./helpers/http";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file: string) => readFileSync(path.join(root, file), "utf8").replace(/\r\n/g, "\n");
const NEW_SQL = read("prisma/migrations/20261106131000_finance_currency_follows_cafe/migration.sql");
const TREASURY_SQL = read("prisma/migrations/20261031220000_treasury_accounts_transfers/migration.sql");
const DRAWER_SQL = read("prisma/migrations/20261030190000_drawer_operating_expenses/migration.sql");

// Money accounts and movements are immutable (no-delete triggers, Restrict foreign keys), so a cafe that holds
// them cannot be torn down: like the older treasury suites, these fixtures stay in the disposable database,
// tagged CUR002. Cafes without money rows are removed.
const cleanup: string[] = [];
after(async () => {
  for (const id of cleanup) await teardownTaggedCafe(id).catch(() => {});
  await db.$disconnect();
});

const SHAPE = "\"currency\" ~ '^[A-Z]{3}$' AND \"currency\" NOT IN ('BHD','IQD','JOD','KWD','LYD','OMR','TND','BIF','CLP','DJF','GNF','ISK','JPY','KMF','KRW','PYG','RWF','UGX','UYI','VND','VUV','XAF','XOF','XPF','CLF','UYW')";

function checkBody(text: string, name: string): string {
  const start = text.indexOf(`CONSTRAINT "${name}" CHECK (`) + `CONSTRAINT "${name}" CHECK (`.length;
  let depth = 1, i = start;
  while (depth) { const c = text[i++]; if (c === "(") depth++; else if (c === ")") depth--; }
  return text.slice(start, i - 1);
}
function addedCheck(name: string): string {
  const start = NEW_SQL.indexOf(`ADD CONSTRAINT "${name}" CHECK (`) + `ADD CONSTRAINT "${name}" CHECK (`.length;
  let depth = 1, i = start;
  while (depth) { const c = NEW_SQL[i++]; if (c === "(") depth++; else if (c === ")") depth--; }
  return NEW_SQL.slice(start, i - 1);
}
function functionText(text: string, header: string): string {
  const i = text.indexOf(header);
  return text.slice(i, text.indexOf("END $$;", i) + "END $$;".length);
}

describe("CUR-002 migration parity", () => {
  test("the four CHECKs differ from the original ones only in the currency predicate", () => {
    const original = {
      MoneyAccount_values: checkBody(TREASURY_SQL, "MoneyAccount_values"),
      MoneyTransfer_values: checkBody(TREASURY_SQL, "MoneyTransfer_values"),
    };
    for (const [name, body] of Object.entries(original)) {
      assert.ok(body.startsWith("\"currency\"='EGP' AND"), name);
      assert.equal(addedCheck(name), SHAPE + body.slice("\"currency\"='EGP'".length), name);
    }
    for (const name of ["OperatingExpense_amount_check", "OperatingExpenseReturn_amount_check"]) {
      const table = name.replace("_amount_check", "");
      const originalLine = DRAWER_SQL.split("\n").find(l => l.includes(`ALTER TABLE "${table}" ADD CONSTRAINT "${name}"`))!;
      assert.ok(originalLine.includes("\"amount\" > 0 AND \"amount\" <> 'NaN'::numeric AND \"currency\" = 'EGP'"), name);
      assert.equal(addedCheck(name), `"amount" > 0 AND "amount" <> 'NaN'::numeric AND ${SHAPE}`, name);
    }
  });

  test("money_movement_guard is the original body with exactly one clause changed", () => {
    const original = functionText(TREASURY_SQL, 'CREATE FUNCTION "money_movement_guard"()');
    const replaced = functionText(NEW_SQL, 'CREATE OR REPLACE FUNCTION "money_movement_guard"()');
    const expected = original.replace("CREATE FUNCTION", "CREATE OR REPLACE FUNCTION")
      .replace("IF a.\"currency\"<>'EGP' OR NOT EXISTS(", "IF a.\"currency\"<>(SELECT \"currency\" FROM \"Cafe\" WHERE \"id\"=NEW.\"cafeId\") OR NOT EXISTS(");
    assert.notEqual(expected, original.replace("CREATE FUNCTION", "CREATE OR REPLACE FUNCTION"), "the clause is really there");
    assert.equal(replaced, expected);
  });

  test("the deployed database matches: no EGP literal left in those constraints or in the guard", async () => {
    const cons = await db.$queryRawUnsafe<{ def: string }[]>(`SELECT pg_get_constraintdef(oid) def FROM pg_constraint WHERE conname IN ('MoneyAccount_values','MoneyTransfer_values','OperatingExpense_amount_check','OperatingExpenseReturn_amount_check')`);
    assert.equal(cons.length, 4);
    for (const c of cons) assert.ok(!c.def.includes("'EGP'"), c.def);
    const [fn] = await db.$queryRawUnsafe<{ def: string }[]>(`SELECT pg_get_functiondef('money_movement_guard()'::regprocedure) def`);
    assert.ok(!fn.def.includes("'EGP'") && fn.def.includes("SELECT \"currency\" FROM \"Cafe\""));
    const triggers = await db.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int n FROM pg_trigger WHERE tgname LIKE '%\\_currency\\_follows\\_cafe'`);
    assert.equal(triggers[0].n, 4);
  });

  test("no EGP-only literal or notice is left in the finance services and screens", () => {
    for (const file of ["src/lib/expenses.ts", "src/lib/treasury-accounts.ts", "src/lib/treasury-transfers.ts", "src/app/api/expenses/route.ts", "src/components/expenses/expense-workspace.tsx", "src/components/treasury/treasury-workspace.tsx", "src/components/treasury/treasury-details.tsx"]) {
      const text = read(file).replace(/\?\?\s*["']EGP["']/g, "");
      assert.ok(!/["']EGP["']|ج\.م|جنيه/.test(text), file);
    }
  });
});

// ── database guards ──────────────────────────────────────────────────────────
async function cafeIn(label: string, currency: string): Promise<CountCafe> {
  const fx = await countCafe(label);
  cleanup.push(fx.cafeId);
  await db.cafe.update({ where: { id: fx.cafeId }, data: { currency } });
  return fx;
}

describe("CUR-002 database guards (disposable DB)", () => {
  test("a money account or transfer must carry the cafe's currency, in any 2-decimal currency", async () => {
    const sar = await cafeIn("CUR002DB", "SAR");
    const account = (code: string, currency: string, cafeId = sar.cafeId) => db.moneyAccount.create({ data: { cafeId, code, name: "CUR002 " + code, kind: "TREASURY", currency, createdById: sar.owner.id } });
    await assert.rejects(account("WRONGEGP", "EGP"), /cafe currency|23514/);
    await assert.rejects(account("WRONGUSD", "USD"), /cafe currency|23514/);
    await assert.rejects(account("BADCASE", "sar"), /check|constraint|cafe currency|23514/i);
    const a = await account("OKA", "SAR"), b = await account("OKB", "SAR");
    assert.equal(a.currency, "SAR");
    const transfer = (currency: string) => db.moneyTransfer.create({ data: { cafeId: sar.cafeId, fromAccountId: a.id, toAccountId: b.id, amount: 5, currency, channel: "INTERNAL", note: "x", fromNameSnapshot: a.name, toNameSnapshot: b.name, creationKey: "cur002-" + currency + "-" + Math.random().toString(36).slice(2), creationFingerprint: "a".repeat(64), createdById: sar.owner.id } });
    await assert.rejects(transfer("EGP"), /currency|23514/);
    assert.equal((await transfer("SAR")).currency, "SAR");
  });

  test("an EGP cafe is unchanged and a 3-decimal code is refused for every cafe", async () => {
    const egp = await cafeIn("CUR002EGP", "EGP");
    const row = await db.moneyAccount.create({ data: { cafeId: egp.cafeId, code: "EGPACC", name: "CUR002 egp", kind: "TREASURY", currency: "EGP", createdById: egp.owner.id } });
    assert.equal(row.currency, "EGP");
    await assert.rejects(db.moneyAccount.create({ data: { cafeId: egp.cafeId, code: "KWDACC", name: "CUR002 kwd", kind: "TREASURY", currency: "KWD", createdById: egp.owner.id } }), /check|constraint|cafe currency|23514/i);
  });

  test("after the first account the cafe currency is locked", async () => {
    const fx = await cafeIn("CUR002LOCK", "AED");
    await db.moneyAccount.create({ data: { cafeId: fx.cafeId, code: "LOCKACC", name: "CUR002 lock", kind: "TREASURY", currency: "AED", createdById: fx.owner.id } });
    await assert.rejects(db.cafe.update({ where: { id: fx.cafeId }, data: { currency: "SAR" } }), /CURRENCY_LOCKED/);
  });
});

// ── real flows over HTTP ─────────────────────────────────────────────────────
describe("CUR-002 end to end", { timeout: 300_000 }, () => {
  const key = () => ({ "Idempotency-Key": crypto.randomUUID() });
  const post = <T = Record<string, unknown>>(email: string, url: string, body: unknown, method = "POST") =>
    as<T>(email, url, { method, body: JSON.stringify(body), headers: key() });

  async function flow(label: string, currency: string, symbol: string) {
    await requireServer();
    const fx = await cafeIn(label, currency);

    // Treasury: two accounts, an approved opening on the source (synthetic, as the older suites do), an InstaPay transfer.
    const src = await post<{ id: string }>(fx.owner.email, "/api/treasury/accounts", { code: "SRC", name: label + " source", kind: "BANK", instaPayEnabled: true });
    assert.equal(src.status, 201, src.text);
    const dst = await post<{ id: string }>(fx.owner.email, "/api/treasury/accounts", { code: "DST", name: label + " dest", kind: "BANK", instaPayEnabled: false });
    assert.equal(dst.status, 201, dst.text);
    const accounts = await db.moneyAccount.findMany({ where: { cafeId: fx.cafeId } });
    assert.deepEqual(accounts.map(a => a.currency), [currency, currency]);

    const reference = label + "-opening";
    await db.$transaction(async tx => {
      const [stamp] = await tx.$queryRaw<{ at: Date }[]>`SELECT (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3) AS at`;
      await tx.moneyAccount.update({ where: { id: src.body.id }, data: { openingState: "APPROVED", openingAt: stamp.at, openingReference: reference, openingApprovedAt: stamp.at, openingApprovedById: fx.owner.id, version: { increment: 1 } } });
      await tx.moneyMovement.create({ data: { cafeId: fx.cafeId, accountId: src.body.id, kind: "OPENING", signedAmount: 500, occurredAt: stamp.at, actorId: fx.owner.id, sourceKey: "money-opening:" + src.body.id, openingReference: reference } });
    });
    const draft = await post<{ transferId: string }>(fx.owner.email, "/api/treasury/transfers", { fromAccountId: src.body.id, toAccountId: dst.body.id, amount: 120.5, channel: "INSTAPAY", reference, note: "declared synthetic internal transfer" });
    assert.equal(draft.status, 201, draft.text);
    const out = await post(fx.owner.email, `/api/treasury/transfers/${draft.body.transferId}/dispatch`, { moneyLeft: true, reference });
    assert.ok(out.status === 200 || out.status === 201, out.text);
    const inn = await post(fx.owner.email, `/api/treasury/transfers/${draft.body.transferId}/receive`, { moneyReceived: true, reference });
    assert.ok(inn.status === 200 || inn.status === 201, inn.text);
    const transfer = await db.moneyTransfer.findUniqueOrThrow({ where: { id: draft.body.transferId } });
    assert.deepEqual([transfer.currency, transfer.status], [currency, "RECEIVED"]);
    const movements = await db.moneyMovement.findMany({ where: { cafeId: fx.cafeId }, orderBy: { occurredAt: "asc" } });
    assert.deepEqual(movements.map(m => [m.kind, m.signedAmount.toFixed(2)]), [["OPENING", "500.00"], ["TRANSFER_OUT", "-120.50"], ["TRANSFER_IN", "120.50"]]);

    // Drawer expense and its return, recorded by the manager in an open shift.
    const grant = await as(fx.owner.email, `/api/users/${fx.manager.id}/permissions`, { method: "PUT", body: JSON.stringify({ overrides: [{ key: "expenses.view", allowed: true }, { key: "expenses.manage", allowed: true }] }) });
    assert.equal(grant.status, 200, grant.text);
    const shift = await as(fx.manager.email, "/api/shifts", { method: "POST", body: JSON.stringify({ branchId: fx.branchId, openingCashAmount: 1000 }) });
    assert.ok(shift.status === 200 || shift.status === 201, shift.text);
    const category = await post<{ category: { id: string } }>(fx.owner.email, "/api/expenses/categories", { code: "OPERATING", nameAr: "تنظيف تشغيلي تجريبي", classification: "OPERATING_EXPENSE" });
    assert.equal(category.status, 201, category.text);
    const paid = await post<{ id: string; currency: string; amount: number }>(fx.manager.email, "/api/expenses", { branchId: fx.branchId, categoryId: category.body.category.id, amount: 120, description: "مصروف تشغيل تجريبي" });
    assert.ok(paid.status === 200 || paid.status === 201, paid.text);
    assert.equal(paid.body.currency, currency);
    const returned = await post(fx.manager.email, `/api/expenses/${paid.body.id}/returns`, { amount: 20, reason: "استلام نقد فعلي تجريبي" });
    assert.ok(returned.status === 200 || returned.status === 201, returned.text);
    const rows = await db.operatingExpenseReturn.findMany({ where: { expenseId: paid.body.id } });
    assert.deepEqual(rows.map(r => r.currency), [currency], "the return inherits the expense currency");
    const listing = await as<{ currency: string; totals: { paid: number } }>(fx.manager.email, "/api/expenses");
    assert.equal(listing.status, 200, listing.text);
    assert.equal(listing.body.currency, currency, "the list reports the cafe currency");
    assert.equal(listing.body.totals.paid, 120);

    // The database refuses a copy of that expense in another currency.
    const original = await db.operatingExpense.findUniqueOrThrow({ where: { id: paid.body.id } });
    const { id: _id, ...rest } = original;
    void _id;
    await assert.rejects(db.operatingExpense.create({ data: { ...rest, currency: currency === "EGP" ? "USD" : "EGP", idempotencyKey: "cur002-" + Math.random().toString(36).slice(2) } }), /cafe currency|23514/);

    // Both flows now hold records, so the currency is locked.
    await assert.rejects(db.cafe.update({ where: { id: fx.cafeId }, data: { currency: "TRY" } }), /CURRENCY_LOCKED/);
    return { fx, symbol };
  }

  test("a SAR cafe runs the treasury and a drawer expense in SAR", async () => {
    await flow("CUR002SAR", "SAR", "ر.س");
  });

  test("an EGP cafe still runs the same flows in EGP", async () => {
    await flow("CUR002EGPFLOW", "EGP", "ج.م");
  });
});
