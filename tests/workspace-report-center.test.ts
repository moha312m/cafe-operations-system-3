import { test } from 'node:test';
import assert from 'node:assert/strict';
import { visibleReportCatalog } from '../src/lib/report-center';
import { purchaseReportSelection, purchaseReportWhere, purchaseReportSnapshot, purchaseReportActorId, assertPurchaseReportScope, assertPurchaseReportPermissions } from '../src/lib/purchase-report';
import { reportOutputFiles, signReportOutput, verifyReportOutput } from '../src/lib/report-output';

const features = { inventoryEnabled: true, purchasesEnabled: true, shiftManagementEnabled: true };
test('catalog hides cafe-wide customer/audit and balance statements from branch readers', () => {
  const keys = new Set(['reports.view', 'sales.view', 'accounting.view', 'customers.view', 'audit.view', 'purchases.view', 'purchases.view_cost']);
  const owner = visibleReportCatalog({ keys, features, role: 'CAFE_OWNER', branchId: null });
  const branch = visibleReportCatalog({ keys, features, role: 'BRANCH_MANAGER', branchId: 'b1' });
  assert.ok(owner.some(r => r.id === 'customers'));
  assert.ok(owner.some(r => r.id === 'balance-sheet'));
  for (const id of ['customers', 'audit', 'balance-sheet', 'cash-flow']) assert.ok(!branch.some(r => r.id === id), id);
  assert.ok(branch.some(r => r.id === 'income'));
  assert.ok(branch.some(r => r.id === 'purchase-invoices'));
  assert.ok(!visibleReportCatalog({ keys: new Set(['purchases.view']), features, role: 'CAFE_OWNER', branchId: null }).some(r => r.id === 'purchase-invoices'));
  assert.ok(!visibleReportCatalog({ keys, features: { ...features, inventoryEnabled: false }, role: 'CAFE_OWNER', branchId: null }).some(r => r.id === 'purchase-invoices'));
});

test('purchase selection uses Cairo calendar boundaries and refuses malformed filters', () => {
  const q = purchaseReportSelection(new URLSearchParams('from=2026-10-29&to=2026-10-30&page=2&search=مورد&status=CONFIRMED'), { cafeId: 'c1', branchId: 'b1', role: 'BRANCH_MANAGER' });
  assert.equal(q.from.toISOString(), '2026-10-28T21:00:00.000Z');
  assert.equal(q.to.toISOString(), '2026-10-30T22:00:00.000Z');
  assert.equal(q.skip, 25);
  const where = purchaseReportWhere(q);
  assert.equal(where.cafeId, 'c1'); assert.equal(where.branchId, 'b1');
  assert.deepEqual(where.invoiceDate, { gte: q.from, lt: q.to });
  for (const input of ['from=2026-02-30&to=2026-03-01', 'from=2026-11-02&to=2026-11-01', 'status=ANYTHING', 'page=-2', 'branchId=other']) {
    assert.throws(() => purchaseReportSelection(new URLSearchParams(input), { cafeId: 'c1', branchId: 'b1', role: 'BRANCH_MANAGER' }), input);
  }
  assert.throws(() => purchaseReportSelection(new URLSearchParams(), { cafeId: 'c1', branchId: null, role: 'CASHIER' }));
});

test('purchase output is the exact displayed page, protects scope and cannot use generic sales output', () => {
  const selection = purchaseReportSelection(new URLSearchParams('from=2026-11-01&to=2026-11-02&branchId=b1'), { cafeId: 'c1', branchId: null, role: 'CAFE_OWNER' });
  const row = { id: 'inv1', invoiceNumber: '=1+2', supplier: '+مورد', branch: 'الدقي', invoiceDate: '2026-11-01T12:00:00.000Z', status: 'CONFIRMED', paymentStatus: 'PARTIAL', totalAmount: '12.30', paidAmount: '2.10', remainingAmount: '10.20' };
  const report = purchaseReportSnapshot(selection, [row], { count: 31, totalAmount: '32.30', paidAmount: '2.10', remainingAmount: '30.20' }, [{ id: 'b1', name: 'الدقي' }], '2026-11-02T12:00:00Z');
  const token = signReportOutput(purchaseReportActorId('owner'), report);
  assert.throws(() => verifyReportOutput('owner', token));
  const verified = verifyReportOutput(purchaseReportActorId('owner'), token);
  assert.deepEqual(verified, report);
  assertPurchaseReportScope(verified, { cafeId: 'c1', branchId: 'b1', role: 'BRANCH_MANAGER' });
  assert.throws(() => assertPurchaseReportScope(verified, { cafeId: 'c1', branchId: 'b2', role: 'BRANCH_MANAGER' }));
  assert.throws(() => assertPurchaseReportScope(verified, { cafeId: 'c2', branchId: null, role: 'CAFE_OWNER' }));
  const files = reportOutputFiles(verified);
  assert.ok(files.csv.startsWith('\uFEFF'));
  assert.ok(files.csv.includes('الدقي')); assert.ok(files.csv.includes('"\'=1+2"')); assert.ok(files.csv.includes('"\'+مورد"'));
  assert.equal(verified.rows.length, 1);
  assert.ok(files.html.includes('12.3')); assert.ok(files.csv.includes('12.3'));
  assert.ok(files.html.includes('31')); assert.ok(files.csv.includes('31'));
});

test('a previously signed report does not grant print/export after current source permissions or features change', () => {
  const keys = ['purchases.view', 'purchases.view_cost', 'reports.export'];
  assertPurchaseReportPermissions(new Set(keys), features, true);
  for (const revoked of keys) assert.throws(() => assertPurchaseReportPermissions(new Set(keys.filter(key => key !== revoked)), features, true), revoked);
  assert.throws(() => assertPurchaseReportPermissions(new Set(keys), { ...features, purchasesEnabled: false }, true));
  assert.throws(() => assertPurchaseReportPermissions(new Set(keys), null, true));
  assertPurchaseReportPermissions(new Set(keys.slice(0, 2)), features, false);
});
