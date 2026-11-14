// ACCOUNTING-018: Period lifecycle (open/close), journal entry reversal,
// read-only subledger & bridge reconciliation, 38-account Arabic COGS
// classification in Executive P&L, and operational expense journal evidence.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { ensureAccountingEntity } from "@/lib/accounting/chart";
import { openPeriod, postEntry } from "@/lib/accounting/ledger";
import { getExecutivePnl } from "@/lib/accounting/pnl";
import { journalEntryDetail } from "@/lib/accounting/queries";
import { accountingBridgeReadiness } from "@/lib/accounting/subledgers";
import { db, teardownTaggedCafe } from "./helpers/db";
import { countCafe, countItem, COUNT_PASSWORD } from "./helpers/count";
import { as, login, requireServer } from "./helpers/http";

after(async () => {
  await db.$disconnect();
});

test(
  "periods, close, journal reversal, reconciliation API, Arabic COGS P&L and expense evidence",
  { timeout: 90_000 },
  async () => {
    await requireServer();
    const fx = await countCafe("ACC018LIFE");

    try {
      await login(fx.owner.email, COUNT_PASSWORD);
      await login(fx.manager.email, COUNT_PASSWORD);
      await login(fx.cashier.email, COUNT_PASSWORD);

      const entity = await db.$transaction((tx) => ensureAccountingEntity(tx, fx.cafeId));

      // ── 1. Periods GET & POST ───────────────────────────────────
      assert.equal(
        (await as(fx.cashier.email, "/api/accounting/periods")).status,
        403,
        "cashier cannot read periods",
      );
      assert.equal(
        (
          await as(fx.manager.email, "/api/accounting/periods", {
            method: "POST",
            headers: { "Idempotency-Key": crypto.randomUUID() },
            body: JSON.stringify({ startsOn: "2026-01-01", endsOn: "2026-01-31" }),
          })
        ).status,
        403,
        "branch manager cannot open café-wide period",
      );
      assert.equal(
        (
          await as(fx.owner.email, "/api/accounting/periods", {
            method: "POST",
            body: JSON.stringify({ startsOn: "2026-01-01", endsOn: "2026-01-31" }),
          })
        ).status,
        400,
        "Idempotency-Key required for opening period",
      );
      assert.equal(
        (
          await as(fx.owner.email, "/api/accounting/periods", {
            method: "POST",
            headers: { "Idempotency-Key": crypto.randomUUID() },
            body: JSON.stringify({ startsOn: "2026-02-01", endsOn: "2026-01-31" }),
          })
        ).status,
        400,
        "startsOn > endsOn rejected",
      );

      const openKey = `open-${crypto.randomUUID()}`;
      const pJanRes = await as<{ period: { id: string; startsOn: string; endsOn: string; status: string } }>(
        fx.owner.email,
        "/api/accounting/periods",
        {
          method: "POST",
          headers: { "Idempotency-Key": openKey },
          body: JSON.stringify({ startsOn: "2026-01-01", endsOn: "2026-01-31", reason: "دورة يناير" }),
        },
      );
      assert.equal(pJanRes.status, 201, pJanRes.text);
      assert.equal(pJanRes.body.period.status, "OPEN");

      const pJanReplay = await as<{ period: { id: string } }>(fx.owner.email, "/api/accounting/periods", {
        method: "POST",
        headers: { "Idempotency-Key": openKey },
        body: JSON.stringify({ startsOn: "2026-01-01", endsOn: "2026-01-31", reason: "دورة يناير" }),
      });
      assert.equal(pJanReplay.status, 201);
      assert.equal(pJanReplay.body.period.id, pJanRes.body.period.id);
      assert.equal(pJanReplay.headers.get("Idempotency-Replayed"), "true");

      // Overlap rejected
      assert.equal(
        (
          await as(fx.owner.email, "/api/accounting/periods", {
            method: "POST",
            headers: { "Idempotency-Key": crypto.randomUUID() },
            body: JSON.stringify({ startsOn: "2026-01-15", endsOn: "2026-02-15" }),
          })
        ).status,
        409,
        "overlapping period refused",
      );

      const pFebRes = await as<{ period: { id: string } }>(fx.owner.email, "/api/accounting/periods", {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ startsOn: "2026-02-01", endsOn: "2026-02-28" }),
      });
      assert.equal(pFebRes.status, 201, pFebRes.text);

      // Current ongoing/future period for close-blocking check
      const pFutureRes = await as<{ period: { id: string } }>(fx.owner.email, "/api/accounting/periods", {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ startsOn: "2099-01-01", endsOn: "2099-12-31" }),
      });
      assert.equal(pFutureRes.status, 201, pFutureRes.text);

      // ── 2. Journal reversal + TB net-zero + idempotency ────────
      const janPost = await db.$transaction((tx) =>
        postEntry(tx, {
          cafeId: fx.cafeId,
          entryDate: "2026-01-15",
          description: "مبيعات كاش تجريبية",
          sourceType: "MANUAL_TEST",
          sourceKey: `manual-test:${fx.cafeId}:1`,
          actorId: fx.owner.id,
          lines: [
            { account: { key: "CASH_DRAWER" }, debit: 250, branchId: fx.branchId },
            { account: { key: "SALES" }, credit: 250, branchId: fx.branchId },
          ],
        }),
      );

      assert.equal(
        (
          await as(fx.cashier.email, `/api/accounting/journal/${janPost.entry.id}/reverse`, {
            method: "POST",
            headers: { "Idempotency-Key": crypto.randomUUID() },
            body: JSON.stringify({ entryDate: "2026-02-05", reason: "اختبار صلاحية" }),
          })
        ).status,
        403,
      );

      const revKey = `rev-${crypto.randomUUID()}`;
      const revRes = await as<{ reversal: { id: string; number: number; reversalOfId: string } }>(
        fx.owner.email,
        `/api/accounting/journal/${janPost.entry.id}/reverse`,
        {
          method: "POST",
          headers: { "Idempotency-Key": revKey },
          body: JSON.stringify({ entryDate: "2026-02-05", reason: "تصحيح تسجيل خطأ" }),
        },
      );
      assert.equal(revRes.status, 201, revRes.text);
      assert.equal(revRes.body.reversal.reversalOfId, janPost.entry.id);

      const revReplay = await as<{ reversal: { id: string } }>(
        fx.owner.email,
        `/api/accounting/journal/${janPost.entry.id}/reverse`,
        {
          method: "POST",
          headers: { "Idempotency-Key": revKey },
          body: JSON.stringify({ entryDate: "2026-02-05", reason: "تصحيح تسجيل خطأ" }),
        },
      );
      assert.equal(revReplay.status, 201);
      assert.equal(revReplay.body.reversal.id, revRes.body.reversal.id);
      assert.equal(revReplay.headers.get("Idempotency-Replayed"), "true");

      // Different key on already-reversed entry -> 409; reversing reversal -> 400
      assert.equal(
        (
          await as(fx.owner.email, `/api/accounting/journal/${janPost.entry.id}/reverse`, {
            method: "POST",
            headers: { "Idempotency-Key": crypto.randomUUID() },
            body: JSON.stringify({ entryDate: "2026-02-06", reason: "محاولة تانية" }),
          })
        ).status,
        409,
      );
      assert.equal(
        (
          await as(fx.owner.email, `/api/accounting/journal/${revRes.body.reversal.id}/reverse`, {
            method: "POST",
            headers: { "Idempotency-Key": crypto.randomUUID() },
            body: JSON.stringify({ entryDate: "2026-02-06", reason: "عكس العكس" }),
          })
        ).status,
        400,
      );

      // TB across Jan + Feb nets to zero
      const tbRes = await as<{
        totals: { debit: number; credit: number; balanced: boolean };
        rows: { closing: number }[];
      }>(fx.owner.email, "/api/accounting/trial-balance?from=2026-01-01&to=2026-02-28");
      assert.equal(tbRes.status, 200);
      assert.equal(tbRes.body.totals.balanced, true);
      assert.equal(tbRes.body.totals.debit, 500);
      assert.ok(tbRes.body.rows.every((r) => r.closing === 0));

      // ── 3. Period close checks (blocking future vs closing past) ─
      assert.equal(
        (
          await as(fx.owner.email, `/api/accounting/periods/${pFutureRes.body.period.id}/close`, {
            method: "POST",
            headers: { "Idempotency-Key": crypto.randomUUID() },
            body: JSON.stringify({}),
          })
        ).status,
        409,
        "unended future period must block closing",
      );

      const closeKey = `close-${crypto.randomUUID()}`;
      const closeJan = await as<{ closed: boolean }>(
        fx.owner.email,
        `/api/accounting/periods/${pJanRes.body.period.id}/close`,
        {
          method: "POST",
          headers: { "Idempotency-Key": closeKey },
          body: JSON.stringify({ note: "إقفال يناير بعد المراجعة" }),
        },
      );
      assert.equal(closeJan.status, 200, closeJan.text);
      assert.equal(closeJan.body.closed, true);

      const closeReplay = await as<{ closed: boolean }>(
        fx.owner.email,
        `/api/accounting/periods/${pJanRes.body.period.id}/close`,
        {
          method: "POST",
          headers: { "Idempotency-Key": closeKey },
          body: JSON.stringify({ note: "إقفال يناير بعد المراجعة" }),
        },
      );
      assert.equal(closeReplay.status, 200);
      assert.equal(closeReplay.headers.get("Idempotency-Replayed"), "true");

      // New key on closed period -> 409; Feb period cannot close while it ended but wait earlier check closed Jan first!
      assert.equal(
        (
          await as(fx.owner.email, `/api/accounting/periods/${pJanRes.body.period.id}/close`, {
            method: "POST",
            headers: { "Idempotency-Key": crypto.randomUUID() },
            body: JSON.stringify({}),
          })
        ).status,
        409,
      );

      const auditActions = await db.auditLog.findMany({
        where: { cafeId: fx.cafeId },
        select: { action: true },
      });
      const actions = new Set(auditActions.map((a) => a.action));
      assert.ok(actions.has("ACCOUNTING_PERIOD_OPENED"));
      assert.ok(actions.has("ACCOUNTING_PERIOD_CLOSED"));
      assert.ok(actions.has("ACCOUNTING_JOURNAL_REVERSED"));

      // ── 4. Read-only Reconciliation API ──────────────────────────
      assert.equal((await as(fx.cashier.email, "/api/accounting/reconciliation")).status, 403);
      assert.equal((await as(fx.owner.email, "/api/accounting/reconciliation?asOf=bad-date")).status, 400);

      const recon = await as<{
        inventory: { unposted: number };
        suppliers: { payable: number; payableDiff: number };
        bridge: { expenseCategories: { totalActive: number }; controlBalances: { cashDrawer: number } };
      }>(fx.owner.email, "/api/accounting/reconciliation?asOf=2026-02-28");
      assert.equal(recon.status, 200, recon.text);
      assert.equal(recon.body.inventory.unposted, 0);
      assert.equal(recon.body.suppliers.payable, 0);
      assert.equal(recon.body.bridge.controlBalances.cashDrawer, 0);

      // ── 5. 38-Account Arabic chart COGS header compatibility ─────
      const marPeriod = await db.$transaction((tx) =>
        openPeriod(tx, { cafeId: fx.cafeId, startsOn: "2026-03-01", endsOn: "2026-03-31" }),
      );
      assert.ok(marPeriod.id);

      const cogsHeader = await db.accountingAccount.create({
        data: {
          cafeId: fx.cafeId,
          entityId: entity.id,
          code: "6005",
          name: "تكلفة المبيعات",
          type: "EXPENSE",
          normalBalance: "DEBIT",
          isPostable: false,
        },
      });
      const customCogsChild = await db.accountingAccount.create({
        data: {
          cafeId: fx.cafeId,
          entityId: entity.id,
          parentId: cogsHeader.id,
          code: "6099",
          name: "فروق تكلفة مخصصة",
          type: "EXPENSE",
          normalBalance: "DEBIT",
          isPostable: true,
        },
      });

      await db.$transaction((tx) =>
        postEntry(tx, {
          cafeId: fx.cafeId,
          entryDate: "2026-03-10",
          description: "قيد بيع ومطابقة تكلفة",
          sourceType: "MANUAL_TEST",
          sourceKey: `manual-test:${fx.cafeId}:mar1`,
          lines: [
            { account: { key: "CASH_DRAWER" }, debit: 500 },
            { account: { key: "SALES" }, credit: 500 },
            { account: { id: customCogsChild.id }, debit: 120 },
            { account: { key: "INVENTORY" }, credit: 120 },
          ],
        }),
      );

      const pnl = await getExecutivePnl({ cafeId: fx.cafeId, from: "2026-03-01", to: "2026-03-31" });
      assert.equal(pnl.kpis.netRevenue, 500);
      assert.equal(pnl.kpis.cogs, 120, "non-system child under 'تكلفة المبيعات' header must count as COGS");
      assert.equal(pnl.kpis.operatingExpenses, 0);
      assert.ok(pnl.sections.cogs.lines.some((l) => l.code === "6099"));

      // ── 6. Operating expense journal sourceEvidence lookup & bridge check ─
      const shift = await db.shift.create({
        data: {
          cafeId: fx.cafeId,
          branchId: fx.branchId,
          cashierId: fx.owner.id,
          shiftNumber: 1,
          openingCashAmount: 100,
          status: "OPEN",
        },
      });
      const cat = await db.expenseCategory.create({
        data: { cafeId: fx.cafeId, code: "EXP-ICE", nameAr: "ثلج ومستلزمات", createdById: fx.owner.id },
      });
      const cafeRow = await db.cafe.findUniqueOrThrow({
        where: { id: fx.cafeId },
        select: { currency: true },
      });
      const opExp = await db.operatingExpense.create({
        data: {
          cafeId: fx.cafeId,
          branchId: fx.branchId,
          shiftId: shift.id,
          categoryId: cat.id,
          categoryCodeSnapshot: cat.code,
          categoryNameSnapshot: cat.nameAr,
          amount: 45,
          occurredAt: new Date("2026-03-10T09:00:00Z"),
          currency: cafeRow.currency,
          description: "شراء ثلج عاجل",
          documentReference: "INV-ICE-1",
          actorId: fx.owner.id,
          actorNameSnapshot: fx.owner.name,
          idempotencyScope: `test-exp:${fx.cafeId}`,
          idempotencyKey: `key-${crypto.randomUUID()}`,
          requestHash: "test-hash",
        },
      });

      const reconBeforePost = await as<{
        bridge: {
          expenseCategories: { totalActive: number; unmappedActive: number };
          unpostedOperations: { operatingExpenses: number };
        };
      }>(fx.owner.email, "/api/accounting/reconciliation?asOf=2099-01-01");
      assert.equal(reconBeforePost.status, 200);
      assert.equal(reconBeforePost.body.bridge.expenseCategories.totalActive, 1);
      assert.equal(reconBeforePost.body.bridge.expenseCategories.unmappedActive, 1);
      assert.equal(reconBeforePost.body.bridge.unpostedOperations.operatingExpenses, 1);

      const expEntry = await db.$transaction((tx) =>
        postEntry(tx, {
          cafeId: fx.cafeId,
          entryDate: "2026-03-11",
          description: "إثبات مصروف ثلج",
          sourceType: "OPERATING_EXPENSE",
          sourceId: opExp.id,
          sourceKey: `opexp-test:${opExp.id}`,
          lines: [
            { account: { key: "OTHER_OPERATING_EXPENSE" }, debit: 45, branchId: fx.branchId },
            { account: { key: "CASH_DRAWER" }, credit: 45, branchId: fx.branchId },
          ],
        }),
      );
      const detail = await journalEntryDetail({ cafeId: fx.cafeId }, expEntry.entry.id);
      assert.deepEqual(detail.source.link, { label: "المصروفات", href: "/expenses" });
      assert.equal(detail.source.evidence?.kind, "مصروف تشغيلي");
      assert.equal(detail.source.evidence?.reference, "INV-ICE-1");
      assert.equal(detail.source.evidence?.amount, 45);
      for (const [asOf, unposted] of [["2026-03-10", 1], ["2026-03-11", 0]] as const) {
        const reconciliation = await as<typeof reconBeforePost.body>(
          fx.owner.email,
          `/api/accounting/reconciliation?asOf=${asOf}`,
        );
        assert.equal(reconciliation.status, 200, reconciliation.text);
        assert.equal(reconciliation.body.bridge.unpostedOperations.operatingExpenses, unposted, asOf);
      }
    } finally {
      await teardownTaggedCafe(fx.cafeId);
    }
  },
);

test("cutover counts exact zero and positive active stock separately", async () => {
  await requireServer();
  const fx = await countCafe("ACC018ZERO");
  try {
    await countItem(fx, "opening zero");
    await countItem(fx, "negative variance", { stock: -0.001 });
    await countItem(fx, "positive stock", { stock: 0.001 });
    await countItem(fx, "archived zero", { archived: true });
    await countItem(fx, "inactive zero", { isActive: false });

    const bridge = await accountingBridgeReadiness({ cafeId: fx.cafeId, branchId: fx.branchId, asOf: "2026-03-10" });
    assert.deepEqual(bridge.inventoryCutover, { totalActiveItems: 3, zeroStockItems: 1, positiveStockItems: 1 });
  } finally {
    await teardownTaggedCafe(fx.cafeId);
  }
});

test("different keys racing to reverse one journal produce one success and one audit", { timeout: 30_000 }, async () => {
  await requireServer();
  const fx = await countCafe("ACC018REVRACE");
  try {
    await login(fx.owner.email, COUNT_PASSWORD);
    const { entry } = await db.$transaction(async (tx) => {
      await ensureAccountingEntity(tx, fx.cafeId);
      await openPeriod(tx, { cafeId: fx.cafeId, startsOn: "2026-02-01", endsOn: "2026-02-28" });
      return postEntry(tx, {
        cafeId: fx.cafeId,
        entryDate: "2026-02-01",
        description: "مبيعات تجريبية",
        sourceType: "MANUAL_TEST",
        sourceKey: "reversal-race-original",
        lines: [
          { account: { key: "CASH_DRAWER" }, debit: 10, branchId: fx.branchId },
          { account: { key: "SALES" }, credit: 10, branchId: fx.branchId },
        ],
      });
    });
    const reverse = (reason: string) => as(fx.owner.email, `/api/accounting/journal/${entry.id}/reverse`, {
      method: "POST",
      headers: { "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify({ entryDate: "2026-02-02", reason }),
    });
    let requests: ReturnType<typeof reverse>[] = [];
    try {
      // Make both requests pass the initial lookup before either can post.
      await db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "AccountingEntity" WHERE "cafeId" = ${fx.cafeId} FOR UPDATE`;
        const [{ pid }] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
        requests = [reverse("سبب التصحيح الأول"), reverse("سبب التصحيح الثاني")];
        const deadline = Date.now() + 5_000;
        do {
          const [{ waiting }] = await db.$queryRaw<{ waiting: number }[]>`
            WITH RECURSIVE waiters(pid) AS (
              VALUES (${pid}::int)
              UNION
              SELECT activity.pid
              FROM pg_stat_activity activity
              JOIN waiters ON waiters.pid = ANY(pg_blocking_pids(activity.pid))
              WHERE activity.datname = current_database()
                AND activity.wait_event_type = 'Lock'
                AND activity.query LIKE '%FROM "AccountingEntity"%FOR UPDATE%'
            )
            SELECT (count(*) - 1)::int AS waiting FROM waiters
          `;
          if (waiting === 2) return;
          await new Promise((resolve) => setTimeout(resolve, 15));
        } while (Date.now() < deadline);
        assert.fail("both reversal requests must reach the posting lock");
      }, { timeout: 10_000 });
    } finally {
      await Promise.allSettled(requests);
    }
    const results = await Promise.all(requests);
    assert.equal(await db.journalEntry.count({ where: { reversalOfId: entry.id } }), 1);
    assert.equal(await db.auditLog.count({ where: { cafeId: fx.cafeId, action: "ACCOUNTING_JOURNAL_REVERSED" } }), 1);
    assert.deepEqual(results.map((result) => result.status).sort(), [201, 409]);
  } finally {
    await teardownTaggedCafe(fx.cafeId);
  }
});
