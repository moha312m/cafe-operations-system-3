import { test } from 'node:test';
import assert from 'node:assert/strict';

async function build(rows: unknown[], employeeId?: string) {
  const lib = await import('@/lib/employee-variance-report').catch(() => null);
  assert.ok(lib?.summarizeEmployeeVariances, 'employee variance report must exist');
  return lib.summarizeEmployeeVariances(rows as never[], employeeId);
}
const employee = { id: 'A', name: 'Outgoing cashier' };
const row = (overrides: Record<string, unknown> = {}) => ({
  id: 'cash', category: 'CASH', type: 'CASH', status: 'OPEN', openedAt: '2026-10-03T22:05:00Z',
  employee, relatedEmployees: [employee], assignedResponsibility: null, attribution: 'NOT_APPLICABLE',
  confidence: 'VERIFIED', responsibility: 'CUSTODY', expected: 100, actual: 75, variance: -25,
  amountVariance: -25, financialImpact: 25, item: null, unit: null, reason: 'Change overpaid',
  shift: { id: 'S1', number: 5, openedAt: '2026-10-03T18:00:00Z' }, branch: { id: 'B', name: 'Test' },
  handoverId: null, ...overrides,
});

test('shortages and surpluses remain separate and card is not mixed into cash', async () => {
  const result = await build([row(), row({id:'plus',variance:15,amountVariance:15}), row({id:'card', category:'CARD',variance:-10,amountVariance:-10})]);
  assert.equal(result.employees[0].totals.CASH.shortage,25);
  assert.equal(result.employees[0].totals.CASH.surplus,15);
  assert.equal(result.employees[0].totals.CARD.shortage,10);
  assert.equal(result.rows[0].reason,'Change overpaid');
});
test('uncertain stock keeps staff context without counting it as their established shortage', async () => {
  const result = await build([row({id:'stock',category:'STOCK',type:'STOCK',employee:null,responsibility:'UNRESOLVED',attribution:'PERIOD_UNRESOLVED',confidence:'PARTIAL',variance:-0.02,amountVariance:null,financialImpact:null,item:{id:'beans',name:'Beans'},unit:'KG'})],'A');
  assert.equal(result.rows.length,1);
  assert.equal(result.unresolved.length,1);
  assert.equal(result.employees[0].totals.STOCK.shortage,0);
  assert.equal(result.rows[0].financialImpact,null);
});
test('verified stock quantities are grouped by item and unit rather than added to money', async () => {
  const result = await build([row({category:'STOCK',type:'STOCK',variance:-0.02,amountVariance:16.4,financialImpact:16.4,item:{id:'beans',name:'Beans'},unit:'KG'}),row({id:'milk',category:'STOCK',type:'STOCK',variance:-1,amountVariance:40,financialImpact:40,item:{id:'milk',name:'Milk'},unit:'LITER'})]);
  assert.equal(result.employees[0].stock.length,2);
  assert.equal(result.employees[0].stock.find((s: {itemId:string})=>s.itemId==='beans')!.shortage,0.02);
  assert.equal(result.employees[0].totals.STOCK.shortage,56.4);
});
test('period totals include more than the old 200-row board limit', async () => {
  const result = await build(Array.from({length:205},(_,i)=>row({id:String(i),variance:-1,amountVariance:-1})));
  assert.equal(result.employees[0].totals.CASH.shortage,205);
  assert.equal(result.rows.length,205);
});
test('staff filtering preserves shared unresolved context but excludes unrelated employees', async () => {
  const result = await build([row(),row({id:'other',employee:{id:'B',name:'Other'},relatedEmployees:[{id:'B',name:'Other'}]})],'A');
  assert.equal(result.rows.length,1);
});
