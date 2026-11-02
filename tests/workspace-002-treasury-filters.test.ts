import { test } from 'node:test';
import assert from 'node:assert/strict';
import { treasuryListFilters, accountListWhere, transferListWhere } from '../src/lib/treasury-list-filters';
test('search and filters keep the authorized branch and cafe predicates', () => {
  const q = treasuryListFilters.parse({ q: 'البنك', branchId: 'elsewhere', kind: 'BANK', active: 'true' });
  const w = accountListWhere({ cafeId: 'mine', branchId: 'own' }, q);
  assert.equal(w.cafeId, 'mine'); assert.equal(w.branchId, 'own');
  assert.equal(w.kind, 'BANK'); assert.equal(w.isActive, true);
  assert.deepEqual(w.OR, [{ name: { contains: 'البنك', mode: 'insensitive' } }, { code: { contains: 'البنك', mode: 'insensitive' } }]);
});
test('an unrestricted owner can select one branch without changing tenant', () => {
  assert.equal(accountListWhere({ cafeId: 'mine' }, treasuryListFilters.parse({ branchId: 'selected' })).branchId, 'selected');
});
test('transfer account filter cannot replace own branch predicates', () => {
  const where = transferListWhere({ cafeId: 'mine', branchId: 'own' }, treasuryListFilters.parse({ accountId: 'a', branchId: 'elsewhere', q: 'bank' }));
  assert.equal(where.cafeId, 'mine');
  assert.deepEqual(where.fromAccount, { branchId: 'own' });
  assert.deepEqual(where.toAccount, { branchId: 'own' });
  assert.ok(Array.isArray(where.AND));
});
test('invalid pagination, dates, status and search bounds refuse', () => {
  for (const q of [{ page: 0 }, { from: '2026-02-30' }, { from: '2026-12-01', to: '2026-11-01' }, { status: 'POSTED' }, { q: 'a'.repeat(121) }]) assert.equal(treasuryListFilters.safeParse(q).success, false);
});
