import { test } from 'node:test';
import assert from 'node:assert/strict';
import { statementRequest, assertStatementOutputScope } from '../src/lib/accounting/statement-request';

test('cafe-wide statements refuse a branch reader before any calculation', () => {
  for (const kind of ['balance-sheet', 'cash-flow']) {
    assert.throws(() => statementRequest(new URLSearchParams({ kind }), { cafeId: 'c', branchId: 'b' }, '2026-11-02'), /الكافيه/);
  }
});
test('income statement retains the authorized branch rather than request scope', () => {
  const r = statementRequest(new URLSearchParams({ kind: 'income', branchId: 'elsewhere', from: '2026-11-01', to: '2026-11-02' }), { cafeId: 'c', branchId: 'mine' }, '2026-11-02');
  assert.equal(r.branchId, 'mine');
  assert.equal(r.from, '2026-11-01');
});
test('statement dates reject rollover, invalid kind and reversed ranges', () => {
  for (const query of ['kind=unknown', 'kind=income&from=2026-02-30', 'kind=income&from=2026-12-01&to=2026-11-01', 'kind=income&from=bad']) {
    assert.throws(() => statementRequest(new URLSearchParams(query), { cafeId: 'c' }, '2026-11-02'));
  }
});
test('default boundaries are exact cafe calendar days', () => {
  assert.deepEqual(statementRequest(new URLSearchParams(), { cafeId: 'c' }, '2026-11-02'), { kind: 'income', cafeId: 'c', from: '2026-11-01', to: '2026-11-02', branchId: undefined });
});
test('retained output refuses changed cafe or branch scope and cafe-wide reports for a branch reader', () => {
  assertStatementOutputScope({ cafeId: 'c', branchId: 'b', kind: 'income' }, { cafeId: 'c', branchId: 'b' });
  for (const metadata of [{ cafeId: 'other', branchId: 'b', kind: 'income' }, { cafeId: 'c', branchId: null, kind: 'income' }, { cafeId: 'c', branchId: 'b', kind: 'cash-flow' }]) assert.throws(() => assertStatementOutputScope(metadata, { cafeId: 'c', branchId: 'b' }));
});
