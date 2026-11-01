import assert from 'node:assert/strict';
import {test} from 'node:test';
import {paymentOverview} from '../src/lib/handover-overview-model';
import {pendingHandover} from '../src/components/handovers/workflow-state';
test('every configured payment method is shown, with committed net totals and no invented external reconciliation',()=>{
 const rows=paymentOverview(['CASH','CARD','WALLET'],{CASH:'80',CARD:'20',WALLET:'0'},[{method:'CARD',expectedAmount:'20',actualAmount:'19',varianceAmount:'-1',status:'SUBMITTED',reasonNote:'terminal difference'}]);
 assert.deepEqual(rows.map(r=>r.method),['CASH','CARD','WALLET']);assert.equal(rows[0].netSales,'80');assert.equal(rows[2].actual,null);assert.equal(rows[1].variance,'-1');assert.equal(rows[1].status,'SUBMITTED');assert.equal(rows[1].externalReconciliation,'NOT_EVIDENCED');
});
test('historical method rows are preserved and missing settlement remains unknown',()=>{
 const rows=paymentOverview(['CASH'],{CASH:'0'},[{method:'OTHER',expectedAmount:'7',actualAmount:null,varianceAmount:null,status:'SUBMITTED',reasonNote:null}]);assert.equal(rows.length,2);assert.equal(rows[1].netSales,null);assert.equal(rows[1].actual,null);
});
test('auto-selection refuses ambiguity and never crosses branches',()=>{
 assert.equal(pendingHandover([{id:'a',branchId:'b',status:'DRAFT'}],'b')?.id,'a');assert.equal(pendingHandover([{id:'a',branchId:'b',status:'DRAFT'},{id:'c',branchId:'b',status:'OUTGOING_SUBMITTED'}],'b'),null);assert.equal(pendingHandover([{id:'a',branchId:'foreign',status:'DRAFT'}],'b'),null);
});
