import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reportOutputFiles } from '../src/lib/report-output';
test('CSV protects formula markers after whitespace and controls while preserving Arabic and numbers', () => {
  for (const value of [' =1+1', '\n=1+1', '\t+1+1', '\r@SUM(A1)', '\uFEFF-1+2']) {
    const out = reportOutputFiles({ title: 'تقرير', reporting: {}, metrics: {}, rows: [{ الاسم: value, عربي: 'قهوة', رقم: -12.5 }], generatedAt: '2026-11-02T00:00:00Z' });
    assert.ok(out.csv.includes('"\'' + value + '"'), JSON.stringify(value));
    assert.ok(out.csv.startsWith('\uFEFF')); assert.ok(out.csv.includes('قهوة')); assert.ok(out.csv.includes('-12.5'));
  }
});
test('inclusive accounting dates are described accurately in output', () => {
  const out = reportOutputFiles({ title: 'قائمة', reporting: { mode: 'accounting', boundary: 'أيام محاسبية شاملة' }, metrics: {}, rows: [], generatedAt: '2026-11-02T00:00:00Z' });
  assert.ok(out.csv.includes('أيام محاسبية شاملة'));
  assert.ok(!out.csv.includes('النهاية مستبعدة'));
});
