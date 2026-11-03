import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Prisma } from '@prisma/client';
import { assertTableAvailable, assertTableConfigurationChange, loadConfiguredTable } from '@/lib/table-configuration';
import { initializeProtectedTransaction } from '@/lib/protected-transaction';
import { listSales, salesFilters } from '@/lib/sales-query';
import type { SessionUser } from '@/lib/auth';
import { db } from '@/lib/db';
import { verifyReportOutput } from '@/lib/report-output';

// No database calls: all transaction delegates below are in-memory fakes.
const actor = { id: 'owner', role: 'CAFE_OWNER', cafeId: 'cafe', branchId: null } as SessionUser;
const table = { id: 'table', cafeId: 'cafe', branchId: 'branch', tableNumber: '3', isActive: true, archivedAt: null };
async function transaction({ occupied = false, active = true, archived = false, configured = true } = {}) {
  const reads: string[] = [];
  const tx = {
    $executeRaw: async () => 0,
    $queryRaw: async () => { reads.push('branch-lock'); return [{ id: 'branch' }]; },
    cafeTable: { findUnique: async () => { reads.push('configuration'); return configured ? { ...table, isActive: active, archivedAt: archived ? new Date() : null } : null; } },
    tableSession: { findFirst: async () => { reads.push('occupancy'); return occupied ? { id: 'open-session' } : null; } },
  } as unknown as Prisma.TransactionClient;
  await initializeProtectedTransaction(tx, { cafeId: 'cafe', branchId: 'branch' });
  return { tx, reads };
}

test('sales payment filter accepts only real methods and retains branch restriction', () => {
  assert.equal(salesFilters(new URLSearchParams('paymentMethod=CARD'), actor).f.paymentMethod, 'CARD');
  assert.throws(() => salesFilters(new URLSearchParams('paymentMethod=bogus'), actor));
  assert.throws(() => salesFilters(new URLSearchParams('paymentMethod=MIXED'), actor));
  assert.throws(() => salesFilters(new URLSearchParams('branchId=other&paymentMethod=CASH'), { ...actor, branchId: 'branch' }), /الفرع/);
});

test('table management denies branchless non-owner before loading a table', async () => {
  const { tx, reads } = await transaction();
  await assert.rejects(loadConfiguredTable({ ...actor, role: 'BRANCH_MANAGER', branchId: null }, table.id, tx), /غير معيّن على فرع/);
  assert.deepEqual(reads, []);
});

test('table management preserves owner access and refuses foreign tenant/branch', async () => {
  const { tx } = await transaction();
  assert.equal((await loadConfiguredTable(actor, table.id, tx)).id, table.id);
  await assert.rejects(loadConfiguredTable({ ...actor, cafeId: 'other' }, table.id, tx), /صلاحية/);
  await assert.rejects(loadConfiguredTable({ ...actor, branchId: 'other' }, table.id, tx), /فرع تاني/);
});

for (const patch of [{ tableNumber: '4' }, { isActive: false }, { archived: true }]) {
  test(`occupied table rejects ${JSON.stringify(patch)} after parent lock`, async () => {
    const { tx, reads } = await transaction({ occupied: true });
    await assert.rejects(assertTableConfigurationChange(tx, table, patch), /جلسة مفتوحة/);
    assert.deepEqual(reads, ['branch-lock', 'occupancy']);
  });
}

test('occupied table allows harmless metadata, unchanged number, activation and restoration', async () => {
  const { tx, reads } = await transaction({ occupied: true });
  await assertTableConfigurationChange(tx, table, { tableNumber: '3', isActive: true, archived: false });
  assert.deepEqual(reads, ['branch-lock']);
});

test('vacant table permits archive/renumber/deactivate', async () => {
  const { tx } = await transaction();
  await assertTableConfigurationChange(tx, table, { tableNumber: '4', isActive: false, archived: true });
});

for (const state of [{ active: false }, { archived: true }]) {
  test(`new/transfer session rejects unavailable configured table ${JSON.stringify(state)}`, async () => {
    const { tx, reads } = await transaction(state);
    await assert.rejects(assertTableAvailable(tx, 'cafe', 'branch', '3'), /غير متاحة/);
    assert.deepEqual(reads, ['branch-lock', 'configuration']);
  });
}

test('active configured tables and legacy custom table numbers remain usable', async () => {
  for (const configured of [true, false]) {
    const { tx, reads } = await transaction({ configured });
    await assertTableAvailable(tx, 'cafe', 'branch', '3');
    assert.deepEqual(reads, ['branch-lock', 'configuration']);
  }
});

test('branch-pinned actor cannot lock or open a different branch', async () => {
  const { tx, reads } = await transaction();
  await assert.rejects(assertTableAvailable(tx, 'cafe', 'other', '3'));
  assert.deepEqual(reads, []);
});

test('session opening and archive serialize both race orders on the Branch parent', async () => {
  for (const first of ['archive', 'session']) {
    let available = true, occupied = false, release!: () => void;
    const locked = new Promise<void>(resolve => { release = resolve; });
    let gotFirst!: () => void;
    const acquired = new Promise<void>(resolve => { gotFirst = resolve; });
    let lockCount = 0;
    const makeTx = async () => {
      const tx = {
        $executeRaw: async () => 0,
        $queryRaw: async (query: TemplateStringsArray) => {
          assert.match(query.join(''), /FROM "Branch"[\s\S]*FOR NO KEY UPDATE/);
          if (++lockCount === 1) gotFirst(); else await locked;
          return [{ id: 'branch' }];
        },
        cafeTable: { findUnique: async () => ({ ...table, isActive: available, archivedAt: available ? null : new Date() }) },
        tableSession: { findFirst: async () => occupied ? { id: 'open' } : null },
      } as unknown as Prisma.TransactionClient;
      await initializeProtectedTransaction(tx, { cafeId: 'cafe', branchId: 'branch' });
      return tx;
    };
    const [archiveTx, sessionTx] = await Promise.all([makeTx(), makeTx()]);
    const archive = () => assertTableConfigurationChange(archiveTx, table, { archived: true });
    const session = () => assertTableAvailable(sessionTx, 'cafe', 'branch', '3');
    const winner = first === 'archive' ? archive() : session();
    await acquired;
    const loser = first === 'archive' ? session() : archive();
    await winner;
    if (first === 'archive') available = false; else occupied = true;
    release();
    await assert.rejects(loser, first === 'archive' ? /غير متاحة/ : /جلسة مفتوحة/);
    assert.equal(lockCount, 2);
  }
});

test('sales list, count, totals and signed export use the same confirmed-collection filter', async t => {
  const selected: Prisma.OrderWhereInput[] = [];
  // Prisma model delegates are lazy proxies; direct assignments avoid
  // node:test's descriptor lookup on proxy-generated methods.
  function replace(target: object, method: string, implementation: unknown) {
    const delegate = target as Record<string, unknown>, previous = delegate[method];
    delegate[method] = implementation;
    t.after(() => { delegate[method] = previous; });
  }
  replace(db.branch, 'findMany', async () => [{ id: 'branch', name: 'الفرع', reportingVersions: [] }]);
  replace(db.user, 'findMany', async () => []);
  replace(db.order, 'findMany', async ({ where }: { where: Prisma.OrderWhereInput }) => { selected.push(where); return []; });
  replace(db.order, 'count', async ({ where }: { where: Prisma.OrderWhereInput }) => { selected.push(where); return 7; });
  replace(db.order, 'aggregate', async ({ where }: { where: Prisma.OrderWhereInput }) => { selected.push(where); return { _sum: { total: '240.50', paidAmount: '200.00', remainingAmount: '40.50' } }; });
  const admin = { ...actor, role: 'SUPER_ADMIN' } as SessionUser;
  const result = await listSales(admin, new URLSearchParams('paymentMethod=WALLET&branchId=branch&status=PARTIAL&page=2&from=2026-11-01&to=2026-11-02'));
  assert.equal(selected.length, 3);
  assert.ok(selected.every(where => where === selected[0]));
  assert.equal(selected[0].branchId, 'branch');
  assert.equal(selected[0].paymentStatus, 'PARTIAL');
  assert.deepEqual(selected[0].payments, { some: { method: 'WALLET', status: 'PAID', type: 'COLLECTION' } });
  const output = verifyReportOutput(admin.id, result.outputSnapshot);
  assert.equal(output.metrics.count, result.count);
  assert.deepEqual(output.metrics.latestInvoices, result.totals);
  assert.equal(output.metrics.page, 2);
});
