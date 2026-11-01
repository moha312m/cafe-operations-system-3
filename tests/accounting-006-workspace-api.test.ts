// ACCOUNTING-006 (G2): the accounting workspace API — reading never creates
// books, every route enforces its key server-side, a branch reader sees only
// their branch, totals never depend on the page, and drill-down reaches the
// operational source.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { db, teardownTaggedCafe } from "./helpers/db";
import { countCafe, COUNT_PASSWORD, type CountCafe } from "./helpers/count";
import { as, login, requireServer } from "./helpers/http";
import { addDays, dateStrInTz, zonedDayStart } from "@/lib/date-range";
import { projectShadowLedger } from "@/lib/accounting/shadow-projection";

after(async () => { await db.$disconnect(); });

const at = (date: string, hour: number) => new Date(zonedDayStart(date).getTime() + hour * 3600_000);
let sequence = 0;
async function sale(fx: CountCafe, branchId: string, date: string, total: number, payments = 1) {
  sequence += 1;
  const o = await db.order.create({ data: { cafeId: fx.cafeId, branchId, orderNumber: 5000 + sequence, type: "TAKEAWAY", status: "SERVED", source: "CASHIER_POS", createdById: fx.cashier.id, createdAt: at(date, 9), servedAt: at(date, 9.25), subtotal: total, total, paidAmount: total, remainingAmount: 0, paymentStatus: "PAID" } });
  const part = Math.round((total / payments) * 100) / 100;
  for (let i = 0; i < payments; i++) {
    await db.payment.create({ data: { cafeId: fx.cafeId, branchId, orderId: o.id, cashierId: fx.cashier.id, receivedById: fx.cashier.id, amount: part, method: "CASH", type: "COLLECTION", status: "PAID", createdAt: at(date, 10 + i / 1000), paidAt: at(date, 10) } });
  }
  return o;
}

test("reading an unconfigured café shows setup state and creates nothing; keys are enforced", { timeout: 30000 }, async () => {
  await requireServer();
  const fx = await countCafe("ACC006EMPTY");
  try {
    await login(fx.owner.email, COUNT_PASSWORD);
    await login(fx.cashier.email, COUNT_PASSWORD);
    const r = await as<{ configured: boolean; notice: string }>(fx.owner.email, "/api/accounting/overview");
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.configured, false);
    assert.match(r.body.notice, /تجريبي/);
    assert.equal(await db.accountingEntity.count({ where: { cafeId: fx.cafeId } }), 0, "GET never initialises books");
    for (const path of ["/api/accounting/overview", "/api/accounting/trial-balance", "/api/accounting/journal", "/api/accounting/accounts"]) {
      assert.equal((await as(fx.cashier.email, path)).status, 403, `${path} refuses a cashier`);
    }
  } finally {
    await teardownTaggedCafe(fx.cafeId);
  }
});

test("trial balance, ledger and journal agree, roll forward, and keep totals across pages", { timeout: 120000 }, async () => {
  await requireServer();
  const fx = await countCafe("ACC006BOOKS");
  try {
    await login(fx.owner.email, COUNT_PASSWORD);
    const d1 = addDays(dateStrInTz(new Date()), -3), d2 = addDays(d1, 1);
    await sale(fx, fx.branchId, d1, 30);
    const big = await sale(fx, fx.branchId, d2, 105, 105); // 105 drawer lines: more than one ledger page
    await projectShadowLedger({ cafeId: fx.cafeId, from: zonedDayStart(d1), to: zonedDayStart(addDays(d2, 1)), openMissingPeriods: true });

    type Tb = { rows: { accountId: string; code: string; opening: number; debit: number; credit: number; movement: number; closing: number }[]; totals: { debit: number; credit: number; balanced: boolean }; outputSnapshot: string | null };
    const both = await as<Tb>(fx.owner.email, `/api/accounting/trial-balance?from=${d1}&to=${d2}`);
    assert.equal(both.status, 200, both.text);
    assert.equal(both.body.totals.balanced, true);
    assert.ok(both.body.outputSnapshot, "the owner may export");
    const second = await as<Tb>(fx.owner.email, `/api/accounting/trial-balance?from=${d2}&to=${d2}`);
    const drawer = (tb: Tb) => tb.rows.find(r => r.code === "1110")!;
    assert.equal(drawer(second.body).opening, 30, "opening = everything before the window");
    assert.equal(drawer(second.body).closing, 135);
    assert.equal(drawer(both.body).closing, drawer(second.body).closing, "closing does not depend on the window start");

    type Gl = { opening: number; lineCount: number; totals: { debit: number; credit: number; closing: number }; lines: { balance: number }[] };
    const accountId = drawer(both.body).accountId;
    const p1 = await as<Gl>(fx.owner.email, `/api/accounting/ledger?accountId=${accountId}&from=${d1}&to=${d2}&page=1`);
    const p2 = await as<Gl>(fx.owner.email, `/api/accounting/ledger?accountId=${accountId}&from=${d1}&to=${d2}&page=2`);
    assert.equal(p1.status, 200, p1.text);
    assert.equal(p1.body.lineCount, 106);
    assert.deepEqual([p1.body.lines.length, p2.body.lines.length], [100, 6]);
    assert.equal(p2.body.totals.debit, 135, "totals cover every page");
    assert.equal(p2.body.lines.at(-1)!.balance, p2.body.totals.closing, "the running balance ends at the closing balance");

    type List = { count: number; entries: { id: string; sourceType: string }[] };
    const list = await as<List>(fx.owner.email, `/api/accounting/journal?from=${d1}&to=${d2}&sourceType=SALE`);
    assert.equal(list.body.count, 2);
    const saleEntry = (await as<List>(fx.owner.email, `/api/accounting/journal?from=${d2}&to=${d2}&sourceType=SALE`)).body.entries[0];
    type Detail = { totals: { debit: number; credit: number }; source: { link: { href: string } | null; evidence: { reference: string; servedAt: string } | null } };
    const detail = await as<Detail>(fx.owner.email, `/api/accounting/journal/${saleEntry.id}`);
    assert.equal(detail.status, 200, detail.text);
    assert.equal(detail.body.totals.debit, detail.body.totals.credit);
    assert.equal(detail.body.source.evidence?.reference, `#${big.orderNumber}`);
    assert.equal(detail.body.source.link?.href, "/sales");
  } finally {
    await teardownTaggedCafe(fx.cafeId);
  }
});

test("a branch reader sees only their branch, cannot export without the key, and cannot read another café", { timeout: 120000 }, async () => {
  await requireServer();
  const fx = await countCafe("ACC006SCOPE"), other = await countCafe("ACC006OTHER");
  try {
    await login(fx.owner.email, COUNT_PASSWORD);
    await login(fx.manager.email, COUNT_PASSWORD);
    await login(other.owner.email, COUNT_PASSWORD);
    await db.userPermissionOverride.create({ data: { userId: fx.manager.id, permissionKey: "accounting.view", allowed: true } });
    const date = addDays(dateStrInTz(new Date()), -2);
    await sale(fx, fx.branchId, date, 40);
    const elsewhere = await sale(fx, fx.otherBranchId, date, 70);
    await projectShadowLedger({ cafeId: fx.cafeId, from: zonedDayStart(date), to: zonedDayStart(addDays(date, 1)), openMissingPeriods: true });

    type Tb = { branchId: string | null; rows: { code: string; closing: number }[]; outputSnapshot: string | null };
    const mine = await as<Tb>(fx.manager.email, `/api/accounting/trial-balance?from=${date}&to=${date}&branchId=${fx.otherBranchId}`);
    assert.equal(mine.status, 200, mine.text);
    assert.equal(mine.body.branchId, fx.branchId, "the session's branch wins over the request");
    assert.equal(mine.body.rows.find(r => r.code === "4100")!.closing, 40);
    assert.equal(mine.body.outputSnapshot, null, "no export without accounting.export");
    const owner = await as<Tb>(fx.owner.email, `/api/accounting/trial-balance?from=${date}&to=${date}`);
    assert.equal(owner.body.rows.find(r => r.code === "4100")!.closing, 110);

    type List = { entries: { id: string; sourceId: string | null }[] };
    const entries = (await as<List>(fx.manager.email, `/api/accounting/journal?from=${date}&to=${date}`)).body.entries;
    assert.ok(entries.length > 0);
    const foreign = (await as<List>(fx.owner.email, `/api/accounting/journal?from=${date}&to=${date}&sourceType=SALE`)).body.entries.find(e => e.sourceId === elsewhere.id)!;
    assert.equal((await as(fx.manager.email, `/api/accounting/journal/${foreign.id}`)).status, 404, "another branch's entry is invisible");
    assert.equal((await as(other.owner.email, `/api/accounting/journal/${foreign.id}`)).status, 404, "another café's entry is invisible");
    type Overview = { configured: boolean; checklist: unknown };
    assert.equal((await as<Overview>(fx.manager.email, "/api/accounting/overview")).body.checklist, null, "café-wide control figures are withheld from a branch reader");
  } finally {
    await teardownTaggedCafe(fx.cafeId);
    await teardownTaggedCafe(other.cafeId);
  }
});
