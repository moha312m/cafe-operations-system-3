import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { matchingHandoverLine } from '../src/lib/handover-count-match';
const at = new Date('2026-10-28T08:00:00.000Z');
const line = (over: Record<string, unknown> = {}) => ({
  id:'line', countedQuantity:10, expectedQuantity:10, itemVersion:BigInt(2), expectedBasis:'LOCKED_ITEM_VERSION',
  countedAt:at, counterId:'employee', recounts:[], corrections:[], disposition:'WITHIN_TOLERANCE', ...over,
});
describe('matching handover evidence', () => {
  test('explicit zero and decimals match at supported precision', () => {
    assert.equal(matchingHandoverLine(line(), BigInt(2)), true);
    assert.equal(matchingHandoverLine(line({countedQuantity:0,expectedQuantity:0}),BigInt(2)),true);
    assert.equal(matchingHandoverLine(line({countedQuantity:1.234,expectedQuantity:1.234}),BigInt(2)),true);
  });
  test('every nonzero quantity gap needs review regardless of tolerance or pricing', () => {
    for (const quantity of [9.999,10.001,9,11]) assert.equal(matchingHandoverLine(line({countedQuantity:quantity}),BigInt(2)),false);
  });
  test('missing and invalid comparison evidence never match', () => {
    for (const over of [{countedQuantity:null},{expectedQuantity:null},{itemVersion:null},{countedAt:null},{counterId:null},{expectedBasis:null},{expectedQuantity:NaN},{countedQuantity:Infinity},{countedQuantity:-1}]) {
      assert.equal(matchingHandoverLine(line(over),BigInt(2)),false,JSON.stringify(over));
    }
  });
  test('stock handover v2: an observation stands at its own cursor; a cursor ahead of the ledger never matches', () => {
    // Owner decision 2026-11-12: stock keeps moving during a handover, so a later sale
    // does not make the count stale — the comparison adds the movement instead.
    assert.equal(matchingHandoverLine(line(),BigInt(3)),true);
    assert.equal(matchingHandoverLine(line(),BigInt(1)),false);
  });
  test('unsettled dispositions never match', () => {
    for (const disposition of ['PENDING','COUNTED','OUTSIDE_TOLERANCE','RECOUNT_REQUIRED']) assert.equal(matchingHandoverLine(line({disposition}),BigInt(2)),false);
  });
  test('unresolved or internally inconsistent recounts never match', () => {
    const recount={id:'r',attempt:1,countedQuantity:10,expectedQuantity:10,varianceQuantity:0,itemVersion:BigInt(2),countedAt:at,counterId:'receiver',resolved:false};
    assert.equal(matchingHandoverLine(line({recounts:[recount]}),BigInt(2)),false);
    assert.equal(matchingHandoverLine(line({recounts:[{...recount,resolved:true}]}),BigInt(2)),true);
    assert.equal(matchingHandoverLine(line({recounts:[{...recount,resolved:true,varianceQuantity:1}]}),BigInt(2)),false);
  });
});
