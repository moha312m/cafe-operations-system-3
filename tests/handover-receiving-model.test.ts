import { test } from 'node:test';
import assert from 'node:assert/strict';
import { receivingDecisions, receivingRequestKey, reviewPriority } from '../src/components/handovers/receiving-model';

test('receiving requires an explicit decision for every line and preserves zero vs absent count', () => {
  assert.equal(receivingDecisions(['a','b'], {a:{quantity:'0',withoutCount:false,reason:'',note:''}}), null);
  assert.deepEqual(receivingDecisions(['a','b'], {a:{quantity:'0',withoutCount:false,reason:'',note:''},b:{quantity:'',withoutCount:true,reason:'',note:''}}), [{stockCountLineId:'a',incomingCountedQuantity:0},{stockCountLineId:'b',incomingCountedQuantity:null}]);
  assert.equal(receivingDecisions(['a'], {a:{quantity:'',withoutCount:false,reason:'',note:''}}), null);
  assert.equal(receivingDecisions(['a'], {a:{quantity:'-1',withoutCount:false,reason:'',note:''}}), null);
  assert.equal(receivingDecisions(['a'], {a:{quantity:'NaN',withoutCount:false,reason:'',note:''}}), null);
});
// HND-UX-003: a reason and note belong to an explicit refusal only. A counted
// quantity without `refuse` is an acceptance and sends no dispute fields.
test('receiving decisions retain decimals; reasons and notes are trimmed and sent only with an explicit refusal', () => {
  assert.deepEqual(receivingDecisions(['a'], {a:{quantity:'1.234',withoutCount:false,reason:' reason ',note:' note ',refuse:true}}), [{stockCountLineId:'a',incomingCountedQuantity:1.234,refuse:true,disputeReasonCodeId:'reason',disputeNote:'note'}]);
  assert.deepEqual(receivingDecisions(['a'], {a:{quantity:'1.234',withoutCount:false,reason:' stale ',note:' stale '}}), [{stockCountLineId:'a',incomingCountedQuantity:1.234}]);
  assert.equal(receivingDecisions(['a'], {a:{quantity:'5',withoutCount:false,reason:' ',note:'',refuse:true}}), null, 'a refusal without a reason is not yet a decision');
  assert.deepEqual(receivingDecisions(['a'], {a:{quantity:'',withoutCount:true,reason:'r',note:'',refuse:true}}), [{stockCountLineId:'a',incomingCountedQuantity:null,refuse:true,disputeReasonCodeId:'r'}]);
});
test('lost-response retries keep the same request key, a changed count or decision changes it', () => {
  const rows=[{stockCountLineId:'a',incomingCountedQuantity:null}];
  const previous={fingerprint:JSON.stringify({countSessionId:'v1',lines:rows}),key:'same-key'};
  assert.equal(receivingRequestKey('v1',rows,previous,()=> 'new-key').key,'same-key');
  assert.equal(receivingRequestKey('v2',rows,previous,()=> 'new-key').key,'new-key');
  assert.equal(receivingRequestKey('v1',[{stockCountLineId:'a',incomingCountedQuantity:0}],previous,()=> 'new-key').key,'new-key');
});
test('review brings missing counts and differences ahead of matching evidence', () => {
  const rows=[{id:'match',disposition:'WITHIN_TOLERANCE',varianceQuantity:'0'}, {id:'gap',disposition:'PENDING',varianceQuantity:null}, {id:'diff',disposition:'WITHIN_TOLERANCE',varianceQuantity:'0.001'}];
  assert.deepEqual([...rows].sort((a,b)=>reviewPriority(a)-reviewPriority(b)).map(x=>x.id),['gap','diff','match']);
});
