import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Opt-in only: no .env fallback, bootstrap, finance mutation or fixture cleanup.
// A removed Branch lock lets both competitors pass; a detached/best-effort
// audit permits the rejected mutation to persist. These are the breaks caught.
test('Step 1 table rename serialization and transactional audit rollback', {
  skip: !process.env.NEXTCUP_WORKSPACE_CONFIG, timeout: 180_000,
}, async t => {
  const { verifyWorkspace } = await import(pathToFileURL(path.resolve('artifacts/workspace-redesign-20261102/workspace-guard.mjs')).href);
  const { config, proof } = await verifyWorkspace({ requireCorrespondence: true });
  assert.ok(process.env.NEXTCUP_WORKSPACE_FIXTURES, 'Explicit retained fixture identity required');
  const f = JSON.parse(readFileSync(process.env.NEXTCUP_WORKSPACE_FIXTURES!, 'utf8'));
  assert.equal(f.runId, config.runId);
  assert.equal(config.source.file, path.resolve('artifacts/erp-experience-20261102/source-step1.json'));
  const { db } = await import('@/lib/db');
  const { protectedTransaction } = await import('@/lib/protected-transaction');
  const { lockBranchAllocator } = await import('@/lib/transaction-locks');
  const { attachOrderToTableSession } = await import('@/lib/table-sessions');
  const tag = 's1' + randomBytes(4).toString('hex');
  const retained: string[] = [], cases: string[] = [];
  async function request(route: string, method: string, body: unknown) {
    const r = await fetch(config.baseUrl + route, { method, headers: { Cookie: f.ownerCookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(45_000) });
    return { status: r.status, data: await r.json() };
  }
  const patch = (id: string, body: unknown) => request('/api/tables/config/' + id, 'PATCH', body);
  async function create(suffix: string) {
    const tableNumber = tag + '-' + suffix;
    const r = await request('/api/tables/config', 'POST', { branchId: f.branchId, tableNumber, seatsCount: 4 });
    assert.equal(r.status, 201, JSON.stringify(r.data)); retained.push(r.data.id);
    // Compile and validate PATCH on this owned fixture before measuring lock queues.
    assert.equal((await patch(r.data.id, { displayName: null })).status, 200);
    return { id: r.data.id as string, tableNumber };
  }
  async function order(tableNumber: string, suffix: string) {
    return protectedTransaction(async tx => {
      await lockBranchAllocator(tx, f.branchId);
      const last = await tx.order.findFirst({ where: { branchId: f.branchId }, orderBy: { orderNumber: 'desc' }, select: { orderNumber: true } });
      const row = await tx.order.create({ data: { id: tag + '-' + suffix, cafeId: f.cafeId, branchId: f.branchId,
        orderNumber: (last?.orderNumber ?? 0) + 1, tableNumber, type: 'DINE_IN', source: 'QR_MENU',
        status: 'PENDING_WAITER_APPROVAL', approvalStatus: 'PENDING_APPROVAL', subtotal: '0.00', total: '0.00',
        remainingAmount: '0.00', createdById: f.ownerUserId, notes: 'Retained Step 1 zero-value synthetic table fixture' } });
      retained.push(row.id); return row;
    }, { cafeId: f.cafeId, branchId: f.branchId });
  }
  try {
    await t.test('rename and session creation share the parent lock in both queue orders', async () => {
      for (const first of ['rename', 'session'] as const) {
        const table = await create(first), renamed = tag + '-n-' + first;
        const billOrder = await order(first === 'rename' ? renamed : table.tableNumber, 'order-' + first);
        let release!: () => void, acquired!: (pid: number) => void, failed!: (error: unknown) => void;
        const held = new Promise<void>(r => { release = r; });
        const ready = new Promise<number>((resolve, reject) => { acquired = resolve; failed = reject; });
        const controller = protectedTransaction(async tx => {
          await lockBranchAllocator(tx, f.branchId);
          const [r] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid()::int AS pid`;
          acquired(r.pid); await held;
        }, { cafeId: f.cafeId, branchId: f.branchId });
        const controllerSettled = controller.then(() => ({ error: null }), error => { failed(error); return { error }; });
        let pid = 0;
        async function queued(want: number) {
          const until = Date.now() + 3_000;
          do {
            const [r] = await db.$queryRaw<{ count: number }[]>`WITH RECURSIVE waiting AS (
              SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND ${pid}=ANY(pg_blocking_pids(pid))
              UNION SELECT a.pid FROM pg_stat_activity a JOIN waiting w ON w.pid=ANY(pg_blocking_pids(a.pid)) WHERE a.datname=current_database()
            ) SELECT count(DISTINCT pid)::int AS count FROM waiting`;
            if (r.count >= want) return;
            await new Promise(r => setTimeout(r, 25));
          } while (Date.now() < until);
          assert.fail('Competing operations did not queue on the same Branch lock');
        }
        // Observe immediately; still rethrow through the awaited cleanup/results.
        const observe = <T>(promise: Promise<T>) => { void promise.catch(() => {}); return promise; };
        const attach = () => observe(attachOrderToTableSession(billOrder, f.ownerUserId));
        const rename = () => observe(patch(table.id, { tableNumber: renamed }));
        let renaming: ReturnType<typeof patch> | undefined, opening: ReturnType<typeof attach> | undefined;
        try {
          pid = await ready;
          if (first === 'rename') renaming = rename(); else opening = attach();
          await queued(1);
          if (first === 'rename') opening = attach(); else renaming = rename();
          await queued(2);
        } finally {
          release();
          const [controlled, competitors] = await Promise.all([
            controllerSettled, Promise.allSettled([renaming, opening].filter(p => p !== undefined)),
          ]);
          if (controlled.error) throw controlled.error;
          const rejected = competitors.find(r => r.status === 'rejected');
          if (rejected?.status === 'rejected') throw rejected.reason;
        }
        const [r, session] = await Promise.all([renaming!, opening!]);
        assert.equal(r.status, first === 'rename' ? 200 : 409); assert.ok(session);
        const fresh = await db.cafeTable.findUniqueOrThrow({ where: { id: table.id } });
        assert.equal(fresh.tableNumber, first === 'rename' ? renamed : table.tableNumber);
        assert.equal(session.tableNumber, fresh.tableNumber);
        assert.equal(await db.tableSession.count({ where: { cafeId: f.cafeId, branchId: f.branchId, tableNumber: fresh.tableNumber, status: 'OPEN' } }), 1);
      }
      cases.push('rename/session both PostgreSQL queue orders');
    });
    await t.test('audit rejection rolls back create, edit, archive, restore and bulk effects', async () => {
      const target = await create('rollback'), archived = await create('restore');
      assert.equal((await patch(archived.id, { archived: true })).status, 200);
      const bulkFrom = 3_000_000 + Math.floor(Math.random() * 1_000_000);
      assert.equal(await db.cafeTable.count({ where: { branchId: f.branchId, tableNumber: { in: [String(bulkFrom), String(bulkFrom + 1)] } } }), 0);
      const countBefore = await db.auditLog.count({ where: { cafeId: f.cafeId } });
      const hook = 'step1_audit_' + tag;
      // The guard verified this synthetic namespace; both SQL values exclude quotes.
      assert.match(f.cafeId, /^wr_[a-f0-9]{32}$/); assert.match(hook, /^[a-z0-9_]+$/);
      let installed = false, created = false;
      try {
        await db.$executeRawUnsafe(`CREATE FUNCTION "${hook}"() RETURNS trigger LANGUAGE plpgsql AS $hook$
          BEGIN
            IF NEW."cafeId" = '${f.cafeId}' AND
              ((NEW.details->>'tableNumber') LIKE '${tag}%' OR
                (NEW.action = 'TABLES_BULK_CREATED' AND (NEW.details->>'from') = '${bulkFrom}'))
            THEN RAISE EXCEPTION 'Step 1 intentional audit rollback'; END IF;
            RETURN NEW;
          END $hook$`);
        created = true;
        await db.$executeRawUnsafe('CREATE TRIGGER "' + hook + '" BEFORE INSERT ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION "' + hook + '"()'); installed = true;
        for (const change of [{ area: 'must rollback' }, { archived: true }, { tableNumber: tag + '-refused' }]) assert.equal((await patch(target.id, change)).status, 500);
        assert.equal((await patch(archived.id, { archived: false })).status, 500);
        assert.equal((await request('/api/tables/config', 'POST', { branchId: f.branchId, tableNumber: tag + '-failed' })).status, 500);
        assert.equal((await request('/api/tables/config/bulk', 'POST', { branchId: f.branchId, from: bulkFrom, to: bulkFrom + 1 })).status, 500);
        const fresh = await db.cafeTable.findUniqueOrThrow({ where: { id: target.id } });
        assert.equal(fresh.area, null); assert.equal(fresh.archivedAt, null); assert.equal(fresh.tableNumber, target.tableNumber); assert.equal(fresh.isActive, true);
        assert.ok((await db.cafeTable.findUniqueOrThrow({ where: { id: archived.id } })).archivedAt);
        assert.equal(await db.cafeTable.count({ where: { branchId: f.branchId, tableNumber: { in: [tag + '-failed', String(bulkFrom), String(bulkFrom + 1)] } } }), 0);
        assert.equal(await db.auditLog.count({ where: { cafeId: f.cafeId } }), countBefore);
      } finally {
        if (installed) await db.$executeRawUnsafe('DROP TRIGGER "' + hook + '" ON "AuditLog"');
        if (created) await db.$executeRawUnsafe('DROP FUNCTION "' + hook + '"()');
      }
      const left = await db.$queryRaw<{ count: number }[]>`SELECT count(*)::int AS count FROM pg_trigger WHERE tgname = ${hook}`;
      assert.equal(left[0].count, 0);
      assert.equal((await patch(target.id, { area: 'hook removed' })).status, 200);
      cases.push('create/edit/archive/restore/bulk audit rollback; hook removed');
    });
  } finally {
    mkdirSync('artifacts/erp-experience-20261102', { recursive: true });
    writeFileSync('artifacts/erp-experience-20261102/tables-' + tag + '.json', JSON.stringify({ at: new Date().toISOString(), proof, retained, cases }, null, 2));
    await db.$disconnect();
  }
});
