// ACCOUNTING-008 (Step 4B.1): the chart route enforces its key, resolves the
// café's own entity, never creates books, validates its query and does not
// leak another café's accounts.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CHART } from "@/lib/accounting/chart";
import { db, teardownTaggedCafe } from "./helpers/db";
import { countCafe, COUNT_PASSWORD } from "./helpers/count";
import { as, login, requireServer } from "./helpers/http";
import { ensureAccountingEntity } from "@/lib/accounting/chart";

after(async () => { await db.$disconnect(); });

test("chart route: refuses without the key, reads unconfigured without creating books, then serves the café's own hierarchy only", { timeout: 60000 }, async () => {
  await requireServer();
  const fx = await countCafe("ACC007CHART");
  const other = await countCafe("ACC007OTHER");
  try {
    await login(fx.owner.email, COUNT_PASSWORD);
    await login(fx.cashier.email, COUNT_PASSWORD);
    assert.equal((await as(fx.cashier.email, "/api/accounting/chart-of-accounts")).status, 403);

    const empty = await as<{ configured: boolean }>(fx.owner.email, "/api/accounting/chart-of-accounts");
    assert.equal(empty.status, 200, empty.text);
    assert.equal(empty.body.configured, false);
    assert.equal(await db.accountingEntity.count({ where: { cafeId: fx.cafeId } }), 0, "GET never initialises books");

    await db.$transaction((tx) => ensureAccountingEntity(tx, fx.cafeId));
    await db.$transaction((tx) => ensureAccountingEntity(tx, other.cafeId));
    await db.accountingAccount.create({ data: { cafeId: other.cafeId, entityId: (await db.accountingEntity.findUniqueOrThrow({ where: { cafeId: other.cafeId } })).id, code: "5410", name: "حساب منشأة تانية", type: "EXPENSE", normalBalance: "DEBIT" } });

    type Res = { configured: boolean; total: number; rows: { code: string; name: string; depth: number; ledgerEligible: boolean }[]; mapping: { header: { codeState: { state: string } } } | null; mappingAllowed: boolean };
    const full = await as<Res>(fx.owner.email, "/api/accounting/chart-of-accounts");
    assert.equal(full.status, 200, full.text);
    assert.equal(full.body.total, DEFAULT_CHART_COUNT);
    assert.equal(full.body.rows.find((r) => r.code === "5000")!.ledgerEligible, false);
    assert.equal(full.body.rows.find((r) => r.code === "1110")!.depth, 1);
    assert.equal(full.body.rows.some((r) => r.name === "حساب منشأة تانية"), false, "another café's account never appears");
    assert.equal(full.body.mappingAllowed, true);
    assert.equal(full.body.mapping!.header.codeState.state, "free", "the other café's 5410 does not affect this chart");

    const found = await as<Res>(fx.owner.email, `/api/accounting/chart-of-accounts?q=${encodeURIComponent("نقدية")}`);
    assert.ok(found.body.rows.some((r) => r.code === "1110"));
    assert.equal((await as(fx.owner.email, `/api/accounting/chart-of-accounts?q=${"x".repeat(61)}`)).status, 400);
  } finally {
    await teardownTaggedCafe(other.cafeId);
    await teardownTaggedCafe(fx.cafeId);
  }
});
const DEFAULT_CHART_COUNT = DEFAULT_CHART.length;
