import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

type Fixtures = {
  cafeId: string; branchId: string; secondBranchId: string; ownerUserId: string;
  ownerCookie: string; restrictedCookie: string; branchPinnedCookie: string;
  otherTenantCookie: string; revokedCookie: string; unassignedCookie: string;
};
type SaleList = { orders: { id: string; total: string }[]; count: number; totals: { total: string }; outputSnapshot: string };

// Opt-in only. The parent guard independently proves source/migrations,
// cluster identity, disposable marker and server/database correspondence.
// There is deliberately no fixture deletion, trigger change or bootstrap.
test('NEXT CUP retained dining-table and sales runtime', { skip: !process.env.NEXTCUP_WORKSPACE_CONFIG, timeout: 180_000 }, async t => {
  const guardUrl = pathToFileURL(path.resolve('artifacts/workspace-redesign-20261102/workspace-guard.mjs')).href;
  const { verifyWorkspace } = await import(guardUrl);
  const verified = await verifyWorkspace({ requireCorrespondence: true });
  const config = verified.config;
  assert.equal(config.allowRetainedSyntheticWrites, true);
  assert.equal(config.baseUrl, 'http://localhost:3113');
  const url = new URL(process.env.DATABASE_URL ?? '');
  assert.equal(url.hostname, '127.0.0.1');
  assert.equal(url.port, '5434');
  assert.equal(decodeURIComponent(url.pathname.slice(1)), 'cafe_ops_test_integr20261101_replay_66515e42c85e8ec4');
  const fixtureData = process.env.NEXTCUP_WORKSPACE_FIXTURES
    ? JSON.parse(readFileSync(process.env.NEXTCUP_WORKSPACE_FIXTURES, 'utf8')) : config.fixtures;
  const f = fixtureData as Fixtures;
  for (const key of ['cafeId','branchId','secondBranchId','ownerUserId','ownerCookie','restrictedCookie','branchPinnedCookie','otherTenantCookie','revokedCookie','unassignedCookie'] as const) assert.ok(f?.[key], `Missing fixture ${key}`);
  assert.notEqual(f.branchId, f.secondBranchId);

  // Import production clients/helpers only after the process URL and live
  // correspondence have passed the parent guard.
  const { db } = await import('@/lib/db');
  const { protectedTransaction } = await import('@/lib/protected-transaction');
  const { lockBranchAllocator } = await import('@/lib/transaction-locks');
  const { attachOrderToTableSession } = await import('@/lib/table-sessions');
  const tag = randomUUID().slice(0, 8), retained: { kind: string; id: string }[] = [];
  const cases: string[] = [];
  async function request<T = Record<string, unknown>>(route: string, method = 'GET', body?: unknown, cookie = f.ownerCookie) {
    const result = await fetch(config.baseUrl + route, { method, headers: { Cookie: cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(45_000) });
    const data = await result.json() as T;
    return { status: result.status, data };
  }
  async function createTable(suffix: string, branchId = f.branchId) {
    const tableNumber = `w${tag}-${suffix}`;
    const result = await request<{ id: string }>('/api/tables/config', 'POST', { branchId, tableNumber, area: 'اختبار مساحة العمل', seatsCount: 4 });
    assert.equal(result.status, 201, JSON.stringify(result.data));
    retained.push({ kind: 'CafeTable', id: result.data.id });
    return { id: result.data.id, tableNumber };
  }
  async function createOrder(tableNumber: string | null, suffix: string, amount = '0.00') {
    const order = await protectedTransaction(async tx => {
      await lockBranchAllocator(tx, f.branchId);
      const last = await tx.order.findFirst({ where: { branchId: f.branchId }, orderBy: { orderNumber: 'desc' }, select: { orderNumber: true } });
      return tx.order.create({ data: {
        id: `workspace-${tag}-${suffix}`, cafeId: f.cafeId, branchId: f.branchId,
        orderNumber: (last?.orderNumber ?? 0) + 1, tableNumber, type: tableNumber ? 'DINE_IN' : 'TAKEAWAY',
        source: 'QR_MENU', status: 'PENDING_WAITER_APPROVAL', approvalStatus: 'PENDING_APPROVAL',
        subtotal: amount, total: amount, remainingAmount: amount, createdById: f.ownerUserId,
        notes: `Retained synthetic workspace fixture ${tag}; no stock or recognition event`,
      } });
    }, { cafeId: f.cafeId, branchId: f.branchId });
    retained.push({ kind: 'Order', id: order.id });
    return order;
  }
  async function patch(id: string, body: unknown, cookie = f.ownerCookie) { return request(`/api/tables/config/${id}`, 'PATCH', body, cookie); }

  try {
    await t.test('single/bulk creation, duplicate refusal, nullable edit, branch uniqueness and retained archive/restore', async () => {
      const table = await createTable('crud');
      assert.equal((await request('/api/tables/config', 'POST', { branchId: f.branchId, tableNumber: table.tableNumber })).status, 409);
      assert.equal((await request('/api/tables/config', 'POST', { branchId: f.secondBranchId, tableNumber: table.tableNumber })).status, 201);
      const numericStart = 100000 + Math.floor(Math.random() * 1000000);
      const bulk = { branchId: f.branchId, from: numericStart, to: numericStart + 2, area: `workspace-${tag}` };
      assert.deepEqual((await request('/api/tables/config/bulk', 'POST', bulk)).data, { created: 3, skipped: 0 });
      assert.deepEqual((await request('/api/tables/config/bulk', 'POST', bulk)).data, { created: 0, skipped: 3 });
      assert.equal((await patch(table.id, { area: 'الحديقة', seatsCount: 6, sortOrder: 23, displayName: 'اختبار' })).status, 200);
      assert.equal((await patch(table.id, { area: null, seatsCount: null, displayName: null })).status, 200);
      const order = await createOrder(table.tableNumber, 'history');
      const session = await attachOrderToTableSession(order, f.ownerUserId);
      assert.ok(session);
      // Close this zero-value synthetic bill through its existing API, with
      // the same locks and transactional audit as an ordinary session.
      assert.equal((await request(`/api/tables/${session.id}/close`, 'POST')).status, 200);
      assert.equal((await patch(table.id, { archived: true })).status, 200);
      assert.equal((await db.order.findUniqueOrThrow({ where: { id: order.id } })).tableSessionId, session.id);
      assert.equal((await db.tableSession.findUniqueOrThrow({ where: { id: session.id } })).status, 'CLOSED');
      assert.equal((await patch(table.id, { archived: false })).status, 200);
      const restored = await db.cafeTable.findUniqueOrThrow({ where: { id: table.id } });
      assert.equal(restored.archivedAt, null); assert.equal(restored.isActive, false);
      assert.equal((await patch(table.id, { isActive: true })).status, 200);
      const logs = await db.auditLog.findMany({ where: { entityId: table.id, cafeId: f.cafeId }, select: { action: true } });
      for (const action of ['TABLE_CREATED','TABLE_UPDATED','TABLE_ARCHIVED','TABLE_REACTIVATED']) assert.ok(logs.some(log => log.action === action), action);
      cases.push('single/bulk/duplicate/edit/archive/restore/history/audits');
    });

    await t.test('occupied rename/deactivate/archive denied; harmless metadata remains editable; disabled targets reject attachment', async () => {
      const table = await createTable('occupied'), order = await createOrder(table.tableNumber, 'occupied');
      const opened = await attachOrderToTableSession(order, f.ownerUserId); assert.ok(opened);
      for (const change of [{ tableNumber: `w${tag}-rename` }, { isActive: false }, { archived: true }]) assert.equal((await patch(table.id, change)).status, 409);
      assert.equal((await patch(table.id, { seatsCount: 8, area: 'اختبار منطقة' })).status, 200);
      assert.equal((await db.tableSession.findUniqueOrThrow({ where: { id: opened.id } })).status, 'OPEN');
      const inactive = await createTable('inactive');
      assert.equal((await patch(inactive.id, { isActive: false })).status, 200);
      const rejected = await createOrder(inactive.tableNumber, 'inactive');
      await assert.rejects(attachOrderToTableSession(rejected, f.ownerUserId), /غير متاحة/);
      assert.equal(await db.tableSession.count({ where: { cafeId: f.cafeId, branchId: f.branchId, tableNumber: inactive.tableNumber, status: 'OPEN' } }), 0);
      cases.push('occupied guards and inactive target');
    });

    await t.test('ordinary selector allowed; management, revoked, tenant and branch denials hold on server', async () => {
      const table = await createTable('denial');
      assert.equal((await request(`/api/tables/selector?branchId=${f.branchId}`, 'GET', undefined, f.restrictedCookie)).status, 200);
      for (const [route, method, body] of [
        [`/api/tables/config?branchId=${f.branchId}`, 'GET', undefined],
        ['/api/tables/config', 'POST', { branchId: f.branchId, tableNumber: `w${tag}-deny` }],
        ['/api/tables/config/bulk', 'POST', { branchId: f.branchId, from: 9000001, to: 9000002 }],
        [`/api/tables/config/${table.id}`, 'PATCH', { archived: true }],
      ] as const) assert.equal((await request(route, method, body, f.restrictedCookie)).status, 403);
      for (const cookie of [f.branchPinnedCookie, f.otherTenantCookie]) {
        assert.equal((await patch(table.id, { archived: true }, cookie)).status, 403);
        assert.equal((await request('/api/tables/config', 'POST', { branchId: f.branchId, tableNumber: `w${tag}-deny` }, cookie)).status >= 400, true);
      }
      assert.equal((await patch(table.id, { archived: true }, f.revokedCookie)).status, 401);
      assert.equal((await request(`/api/tables/config?branchId=${f.branchId}`, 'GET', undefined, f.unassignedCookie)).status, 403);
      assert.equal((await patch(table.id, { area: 'must be refused' }, f.unassignedCookie)).status, 403);
      assert.equal((await db.cafeTable.findUniqueOrThrow({ where: { id: table.id } })).archivedAt, null);
      cases.push('selector and management/tenant/branch/revoked denials');
    });

    await t.test('real PostgreSQL archive/new-session races in both queue orders', async () => {
      for (const first of ['archive', 'session'] as const) {
        const table = await createTable(`r-${first}`), order = await createOrder(table.tableNumber, `race-${first}`);
        let release!: () => void, held!: (pid: number) => void;
        const releaseLock = new Promise<void>(resolve => { release = resolve; });
        const acquired = new Promise<number>(resolve => { held = resolve; });
        const controller = protectedTransaction(async tx => {
          await lockBranchAllocator(tx, f.branchId);
          const [row] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid()::int AS pid`;
          held(row.pid); await releaseLock;
        }, { cafeId: f.cafeId, branchId: f.branchId });
        const controllerPid = await acquired;
        async function blocked(count: number) {
          const until = Date.now() + 1400;
          do {
            const [row] = await db.$queryRaw<{ count: number }[]>`WITH RECURSIVE waiters AS (
              SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND ${controllerPid}=ANY(pg_blocking_pids(pid))
              UNION SELECT a.pid FROM pg_stat_activity a JOIN waiters w ON w.pid=ANY(pg_blocking_pids(a.pid)) WHERE a.datname=current_database() AND a.wait_event_type='Lock'
            ) SELECT count(DISTINCT pid)::int AS count FROM waiters`;
            if (row.count >= count) return;
            await new Promise(resolve => setTimeout(resolve, 25));
          } while (Date.now() < until);
          throw Error(`Did not observe ${count} requests queued on Branch lock`);
        }
        const archive = () => patch(table.id, { archived: true });
        const attach = () => attachOrderToTableSession(order, f.ownerUserId).then(value => ({ value, error: null }), error => ({ value: null, error }));
        let archiving: ReturnType<typeof archive> | undefined, attaching: ReturnType<typeof attach> | undefined;
        try {
          if (first === 'archive') archiving = archive(); else attaching = attach();
          await blocked(1);
          if (first === 'archive') attaching = attach(); else archiving = archive();
          await blocked(2);
        } finally { release(); await controller; }
        const [archived, attached] = await Promise.all([archiving!, attaching!]);
        assert.equal(archived.status, first === 'archive' ? 200 : 409);
        assert.equal(!!attached.error, first === 'archive');
        if (first === 'archive') assert.match(String(attached.error?.message), /غير متاحة/);
        else assert.match(String(archived.data.error), /جلسة مفتوحة/);
        const openCount = await db.tableSession.count({ where: { cafeId: f.cafeId, branchId: f.branchId, tableNumber: table.tableNumber, status: 'OPEN' } });
        assert.equal(openCount, first === 'archive' ? 0 : 1);
        const freshTable = await db.cafeTable.findUniqueOrThrow({ where: { id: table.id } });
        assert.equal(!!freshTable.archivedAt, first === 'archive');
      }
      cases.push('actual PostgreSQL race both orders');
    });

    await t.test('payment filter excludes refunds and unconfirmed rows; count, total, snapshot and export agree', async () => {
      const wallet = await createOrder(null, 'sale-wallet', '10.00'), cash = await createOrder(null, 'sale-cash', '12.00');
      await db.payment.createMany({ data: [
        { cafeId: f.cafeId, branchId: f.branchId, orderId: wallet.id, receivedById: f.ownerUserId, amount: '10.00', method: 'WALLET', type: 'COLLECTION', status: 'PAID' },
        { cafeId: f.cafeId, branchId: f.branchId, orderId: cash.id, receivedById: f.ownerUserId, amount: '10.00', method: 'CASH', type: 'COLLECTION', status: 'PAID' },
        { cafeId: f.cafeId, branchId: f.branchId, orderId: cash.id, receivedById: f.ownerUserId, amount: '2.00', method: 'WALLET', type: 'REFUND', status: 'PAID', refundReason: `Retained synthetic filter fixture ${tag}` },
        { cafeId: f.cafeId, branchId: f.branchId, orderId: cash.id, receivedById: f.ownerUserId, amount: '7.00', method: 'WALLET', type: 'COLLECTION', status: 'UNPAID' },
      ] });
      const query = new URLSearchParams({ branchId: f.branchId, q: `workspace-${tag}-sale`, paymentMethod: 'WALLET', from: '2020-01-01', to: '2090-12-31' });
      const result = await request<SaleList>('/api/sales?' + query);
      assert.equal(result.status, 200); assert.equal(result.data.count, 1);
      assert.deepEqual(result.data.orders.map(order => order.id), [wallet.id]);
      assert.equal(Number(result.data.totals.total), 10);
      const payload = JSON.parse(Buffer.from(result.data.outputSnapshot.split('.')[0], 'base64url').toString('utf8'));
      assert.equal(payload.report.metrics.count, 1); assert.equal(Number(payload.report.metrics.latestInvoices.total), 10);
      assert.deepEqual(payload.report.rows.map((row: { id: string }) => row.id), [wallet.id]);
      const output = await request<{ csv: string }>('/api/reports/output', 'POST', { snapshot: result.data.outputSnapshot });
      assert.equal(output.status, 200); assert.ok(output.data.csv.includes(wallet.id)); assert.equal(output.data.csv.includes(cash.id), false);
      assert.equal((await request('/api/reports/output', 'POST', { snapshot: result.data.outputSnapshot }, f.revokedCookie)).status, 401);
      query.set('paymentMethod', 'MIXED');
      assert.equal((await request('/api/sales?' + query)).status, 400);
      cases.push('payment-filter/list/count/totals/signed-export');
    });
  } finally {
    const directory = path.resolve('artifacts/workspace-redesign-20261102'); mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, `tables-runtime-${tag}.json`), JSON.stringify({ runId: config.runId, tag, at: new Date().toISOString(), retained, cases, noCleanup: true }, null, 2));
    await db.$disconnect();
  }
});
