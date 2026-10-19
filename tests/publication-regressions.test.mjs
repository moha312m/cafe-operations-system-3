// Synthetic source-path tests only: no network, database, credentials or logins.
// Real SQL/transaction and browser verification remain separate release gates.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import ts from 'typescript';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const nativeRequire=createRequire(import.meta.url);
function sourceModule(relative,mocks={},extra='') {
 const filename=path.join(root,relative),compiledModule={exports:{}};
 const compiled=ts.transpileModule(fs.readFileSync(filename,'utf8')+'\n'+extra,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;
 const load=id=>{
  if(Object.hasOwn(mocks,id))return mocks[id];
  if(id.startsWith('@/')){
   const target=path.join('src',id.slice(2));
   const resolved=['.ts','.tsx'].find(ext=>fs.existsSync(path.join(root,target+ext)));
   assert.ok(resolved,`Missing source ${id}`);
   // Unmocked app dependencies may only be the pure helpers needed here.
   assert.ok(['@/lib/money','@/lib/charges','@/lib/date-range'].includes(id),`Unmocked application dependency ${id}`);
   return sourceModule(target+resolved,mocks);
  }
  assert.ok(['react','react/jsx-runtime','@prisma/client/runtime/index-browser','zod'].includes(id),`Unmocked external dependency ${id}`);
  return nativeRequire(id);
 };
 vm.runInNewContext(compiled,{module:compiledModule,exports:compiledModule.exports,require:load,console,Date,URL,Intl,Map,Set},{filename});
 return compiledModule.exports;
}
function uiMocks(keys) {
 const tag=name=>function SyntheticElement({children,...props}){return React.createElement(name,props,children);};
 return {
  '@/components/ui/badge':{Badge:tag('span')},
  '@/components/ui/button':{Button:tag('button')},
  '@/components/ui/label':{Label:tag('label')},
  '@/components/ui/input':{Input:tag('input')},
  '@/components/ui/table':Object.fromEntries(['Table','TableBody','TableCell','TableHead','TableHeader','TableRow'].map(n=>[n,tag('div')])),
  './handover-labels':sourceModule('src/components/handovers/handover-labels.ts'),
  '@/components/handovers/opening-cash-panel':{OpeningCashPanel:()=>null},
  '@/components/app-shell':{useApp:()=>({canKey:key=>keys.includes(key)})},
  '@/lib/client':{api:()=>{throw new Error('Network must not run in synthetic render');}},
  'next/link':{__esModule:true,default:tag('a')},sonner:{toast:{success(){},error(){}}},
 };
}
test('completed handover is reachable from history without becoming mutation-reviewable',()=>{
 const mocks=uiMocks([]);
 const {HandoverList}=sourceModule('src/components/handovers/handover-list.tsx',mocks);
 const html=renderToStaticMarkup(React.createElement(HandoverList,{handovers:[{id:'done',branchId:'b',status:'COMPLETED',target:'SHIFT_TO_SHIFT',outgoingShiftId:'s',outgoingUserId:'other',stockCountSessionId:'count',requiredItemCount:2,submittedAt:null,createdAt:'2026-10-19T00:00:00Z'}],selectedId:null,onSelect(){},viewerUserId:'viewer'}));
 assert.match(html,/عرض التسليم/);
 assert.equal(mocks['./handover-labels'].REVIEWABLE.includes('COMPLETED'),false);
});
for(const keys of [['stock_count.start'],['handover.accept'],['stock_count.start','shifts.view_current']])test(`opening action retains scoped ID fallback with ${keys.join('+')}`,()=>{
 const {OpeningVerificationPanel}=sourceModule('src/components/handovers/opening-verification-panel.tsx',uiMocks(keys));
 const html=renderToStaticMarkup(React.createElement(OpeningVerificationPanel,{branchId:'b'}));
 assert.match(html,/<input[^>]*id="opening-shift"/);
 assert.match(html,/<input[^>]*id="opening-count"/);
});
test('full discovery permissions retain the ordinary shift and count pickers',()=>{
 const {OpeningVerificationPanel}=sourceModule('src/components/handovers/opening-verification-panel.tsx',uiMocks(['stock_count.start','shifts.view_reports','stock_count.view']));
 const html=renderToStaticMarkup(React.createElement(OpeningVerificationPanel,{branchId:'b'}));
 assert.match(html,/<select[^>]*id="opening-shift"/);assert.match(html,/<select[^>]*id="opening-count"/);
});
function openingLoad(keys,api) {
 const state=[],callbacks=[],ref={current:0};let cursor=0;
 const mocks=uiMocks(keys);
 mocks.react={...React,useState:initial=>{const index=cursor++;state[index]=initial;return [initial,value=>{state[index]=value;}];},useRef:()=>ref,useCallback:callback=>{callbacks.push(callback);return callback;},useEffect(){}};
 mocks['@/lib/client']={api};
 const {OpeningVerificationPanel}=sourceModule('src/components/handovers/opening-verification-panel.tsx',mocks);
 OpeningVerificationPanel({branchId:'branch & one'});
 return {load:callbacks[0],state};
}
test('operational permission alone makes no unauthorized discovery request',async()=>{
 const harness=openingLoad(['stock_count.start'],()=>{assert.fail('Unauthorized discovery');});
 await harness.load();
});
test('one rejected list does not discard an independently authorized successful list',async()=>{
 const urls=[];
 const harness=openingLoad(['handover.accept','shifts.view_reports','stock_count.view'],async url=>{
  urls.push(url);if(url.startsWith('/api/shifts'))throw new Error('Synthetic list rejection');
  return {sessions:[{id:'kept-count',shiftId:'s',status:'CONFIRMED'}]};
 });
 await harness.load();
 assert.equal(harness.state[3][0].id,'kept-count');assert.equal(harness.state[5],true);assert.equal(harness.state[6],false);
 assert.ok(urls.every(url=>url.includes('branchId=branch%20%26%20one')));
});
test('stale discovery completion cannot overwrite a later refresh',async()=>{
 let release;let calls=0;
 const old=new Promise(resolve=>{release=resolve;});
 const harness=openingLoad(['stock_count.start','shifts.view_reports'],async()=>{
  calls++;return calls===1?old:{shifts:[{id:'new',custodyGateReason:'AWAITING_OPENING_VERIFICATION'}]};
 });
 const first=harness.load();await harness.load();
 release({shifts:[{id:'old',custodyGateReason:'AWAITING_OPENING_VERIFICATION'}]});await first;
 assert.equal(harness.state[2][0].id,'new');
});
function reportingHarness(relative) {
 const rows=[{productName:'Voided espresso',variantName:null,quantity:1,lineTotal:40,voidedAt:new Date()},{productName:'Retained cake',variantName:null,quantity:1,lineTotal:60,voidedAt:null}];
 const db=new Proxy({},{get:(_,model)=>({
  aggregate:async()=>({_sum:new Proxy({total:60,subtotal:60},{get:(o,k)=>o[k]??0}),_count:1}),
  count:async()=>0,findMany:async()=>[],findFirst:async()=>null,
  groupBy:async args=>model==='orderItem'?rows.filter(r=>args.where?.voidedAt===null?!r.voidedAt:true).map(r=>({productName:r.productName,variantName:r.variantName,_sum:{quantity:r.quantity,lineTotal:r.lineTotal}})):[],
 })});
 const api={requirePermission:async()=>({role:'CAFE_OWNER',cafeId:'synthetic',id:'owner'}),resolveCafeId:()=> 'synthetic',resolveReadScope:()=>({}),handleApiError:error=>{throw error;},ApiError:Error};
 const mocks={'next/server':{NextResponse:{json:body=>({status:200,body})}},'@/lib/db':{db},'@/lib/api':api,'@/lib/reporting':{periodFinancials:async()=>({}),salesByStaff:async()=>[],refundsByActor:async()=>[]},'@/lib/permissions':{hasPermission:()=>false},'@/lib/recipes':{},'@/lib/perms/effective':{},'@/lib/cafe-settings':{getCafeSettings:async()=>({purchasesEnabled:false})},'@/lib/low-stock':{withStockAlerts:()=>[]}};
 return sourceModule(relative,mocks).GET({nextUrl:new URL('http://localhost/api/reports?date=2026-10-19&range=day')});
}
test('daily report excludes a retained void row from sales',async()=>{
 const result=await reportingHarness('src/app/api/reports/daily/route.ts');
 assert.equal(result.status,200);assert.deepEqual(JSON.parse(JSON.stringify(result.body.items)),[{product:'Retained cake',variant:null,quantity:1,revenue:60}]);
});
test('both dashboard product rankings exclude a retained void row',async()=>{
 const result=await reportingHarness('src/app/api/dashboard/route.ts');
 assert.equal(result.status,200);
 for(const key of ['topProducts','leastProducts'])assert.deepEqual(JSON.parse(JSON.stringify(result.body[key])),[{name:'Retained cake',quantity:1,revenue:60}]);
});
test('actual void recalculation adjusts linked customer spend under customer lock, before table totals',async()=>{
 let spent=100,orders=1;const effects=[];
 const order={id:'o',cafeId:'synthetic',status:'CONFIRMED',paymentStatus:'UNPAID',paidAmount:0,payments:[],discountAmount:0,loyaltyPointsRedeemed:0,taxRateSnapshot:0,serviceRateSnapshot:0,serviceChargeAmount:0,type:'TAKEAWAY',customerId:'customer',tableSessionId:'table',total:100,orderNumber:1,items:[{id:'espresso',lineTotal:40,itemPayments:[],voidedAt:null},{id:'cake',lineTotal:60,itemPayments:[],voidedAt:null}]};
 const tx={order:{findFirst:async()=>order,update:async args=>({id:'o',...args.data})},orderItem:{update:async()=>{}},customer:{update:async args=>{effects.push('customer-update');spent+=args.data.totalSpent.increment!==undefined?Number(args.data.totalSpent.increment):-Number(args.data.totalSpent.decrement);orders-=args.data.totalOrders?.decrement??0;}}};
 const empty={};
 const mocks={'@/lib/protected-transaction':empty,'@/lib/api':{ApiError:Error},'@/lib/audit':{auditInTransaction:async()=>{}},'@/lib/owner-action-approvals':empty,'@/lib/refunds':empty,'@/lib/table-sessions':{recomputeSessionTotals:async()=>{effects.push('table');}},'@/lib/loyalty':empty,'@/lib/customers':empty,'@/lib/transaction-locks':{lockCustomers:async()=>{effects.push('customer-lock');}}};
 const {testVoid}=sourceModule('src/lib/approved-order-actions.ts',mocks,'exports.testVoid=voidOrderItemInTransaction;');
 await testVoid(tx,{actor:{id:'actor',cafeId:'synthetic'},requestId:'approval',orderId:'o',itemId:'espresso',reason:'synthetic void',now:new Date()});
 assert.equal(spent,60);assert.deepEqual(effects,['customer-lock','customer-update','table']);
 const customerHelpers=sourceModule('src/lib/customers.ts',{'@/lib/db':{db:tx},'@/lib/protected-transaction':{},'@/lib/audit':{},'@/lib/phone':{}});
 await customerHelpers.unrecordCustomerOrder('customer',60,tx);
 assert.equal(spent,0);assert.equal(orders,0);
});

for (const role of ['BRANCH_MANAGER','CASHIER']) test(`variance reason rejects unassigned ${role} before mutation`,async()=>{
 let mutations=0;
 const actor={id:'actor',role,cafeId:'cafe',branchId:null};
 const route=sourceModule('src/app/api/stock-counts/[id]/lines/[lineId]/variance-reason/route.ts',{
  'next/server':{NextResponse:{json:body=>({status:200,body})}},
  '@/lib/api':{requireKey:async()=>actor,requireFeature:async()=>{},resolveCafeId:()=>actor.cafeId,resolveReadScope:()=>{throw Object.assign(new Error('Unassigned branch'),{status:403});},handleApiError:error=>({status:error.status??500})},
  '@/lib/handover-variance-reason':{recordHandoverVarianceReason:async()=>{mutations++;return {recorded:true};}},
 });
 const result=await route.POST({json:async()=>({reasonCodeId:'reason'}),nextUrl:new URL('http://localhost/api/reason')},{params:Promise.resolve({id:'count',lineId:'line'})});
 assert.equal(result.status,403);assert.equal(mutations,0);
});

test('approved item void refuses already-awarded loyalty before any writes, preserving ledger and cancellation path',async()=>{
 let mutations=0;
 const order={id:'o',cafeId:'synthetic',status:'CONFIRMED',paymentStatus:'UNPAID',paidAmount:0,payments:[],discountAmount:0,loyaltyPointsRedeemed:0,loyaltyPointsAwardedAt:new Date(),loyaltyPointsEarned:10,taxRateSnapshot:0,serviceRateSnapshot:0,serviceChargeAmount:0,type:'TAKEAWAY',customerId:'customer',total:100,items:[{id:'espresso',lineTotal:40,itemPayments:[],voidedAt:null},{id:'cake',lineTotal:60,itemPayments:[],voidedAt:null}]};
 const tx={order:{findFirst:async()=>order,update:async()=>{mutations++;return {}; }},orderItem:{update:async()=>{mutations++;}},customer:{update:async()=>{mutations++;}}};
 class ApiError extends Error{constructor(status,message){super(message);this.status=status;}}
 const mocks={'@/lib/protected-transaction':{},'@/lib/api':{ApiError},'@/lib/audit':{auditInTransaction:async()=>{}},'@/lib/owner-action-approvals':{},'@/lib/refunds':{},'@/lib/table-sessions':{},'@/lib/loyalty':{},'@/lib/customers':{},'@/lib/transaction-locks':{lockCustomers:async()=>{}}};
 const {testVoid}=sourceModule('src/lib/approved-order-actions.ts',mocks,'exports.testVoid=voidOrderItemInTransaction;');
 await assert.rejects(testVoid(tx,{actor:{id:'actor',cafeId:'synthetic'},requestId:'approval',orderId:'o',itemId:'espresso',reason:'synthetic',now:new Date()}),error=>error.status===409&&/loyalty|points/i.test(error.message));
 assert.equal(mutations,0);
});
test('empty stock-order locking is a no-op but nonempty calls retain validated branch locking',async()=>{
 const acquired=[];
 const module=sourceModule('src/lib/stock-deduction.ts',{'@/lib/audit':{},'@/lib/costing':{},'@/lib/ledger':{},'@/lib/inventory-policy':{},'@/lib/inventory-freeze':{acquireInventorySharedLocks:async(_tx,branches)=>{assert.ok(branches.length>0);acquired.push(...branches);}},'@/lib/sale-consumption':{planOrderConsumption:async()=>({branchId:'validated-branch',demands:[]})}});
 await module.lockStockForOrders({},[]);assert.deepEqual(acquired,[]);
 await module.lockStockForOrders({order:{findUnique:async()=>({id:'o'})}},['o']);assert.deepEqual(acquired,['validated-branch']);
});
for(const stage of ['prelock','deduction'])test(`carry ${stage} rejects known consumption errors as409 with order reference and no writes`,async()=>{
 class ApiError extends Error{constructor(status,message){super(message);this.status=status;}}
 class StockError extends Error{}
 const mocks=Object.fromEntries(['@/lib/protected-transaction','@/lib/opening-readiness','@/lib/overnight-cash','@/lib/audit','@/lib/variance-case','@/lib/shifts','@/lib/tender-settlement','@/lib/handover-blockers','@/lib/handover-config','@/lib/inventory-freeze','@/lib/handover'].map(name=>[name,{}]));
 mocks['@/lib/api']={ApiError};mocks['@/lib/transaction-locks']={assertFinancialLocks(){}};
 mocks['@/lib/stock-deduction']={StockError,lockStockForOrders:async()=>{if(stage==='prelock')throw new ApiError(400,'Synthetic missing ingredient');},deductStockForOrder:async()=>{throw new ApiError(400,'Synthetic missing ingredient');}};
 let reads=0,writes=0;
 const tx={order:{findMany:async()=>++reads===1?[{id:'o'}]:[{id:'o',orderNumber:77,status:'READY',stockDeductedAt:null,items:[]}],update:async()=>{writes++;}}};
 const {testCarry}=sourceModule('src/lib/cash-close.ts',mocks,'exports.testCarry=carryOpenOrders;');
 await assert.rejects(testCarry(tx,{cafeId:'c',branchId:'b',actorId:'actor',at:new Date()}),error=>error.status===409&&error.message.includes('#77'));
 assert.equal(writes,0);
});
test('repeat mutation refuses processed recipes, preserves read-only discovery and permits pending finished stock',async()=>{
 const reachedPendingLock=new Error('Synthetic pending stock lock reached');
 const mocks={'@/lib/audit':{},'@/lib/costing':{},'@/lib/ledger':{},'@/lib/inventory-policy':{},'@/lib/inventory-freeze':{acquireInventorySharedLocks:async()=>{throw reachedPendingLock;}},'@/lib/sale-consumption':{planOrderConsumption:async()=>({branchId:'b',demands:[],processRecipes:false})}};
 const module=sourceModule('src/lib/stock-deduction.ts',mocks);
 const tx={order:{findUnique:async()=>({id:'o',stockDeductedAt:new Date()})}};
 await assert.rejects(module.deductStockForOrder(tx,'o',null),error=>error instanceof module.StockError&&/من قبل/.test(error.message));
 assert.deepEqual(JSON.parse(JSON.stringify(await module.stockItemIdsForOrders(tx,['o']))),[]);
 mocks['@/lib/sale-consumption'].planOrderConsumption=async()=>({branchId:'b',demands:[{finishedAllocations:[{orderItemId:'pending',quantity:1}]}],processRecipes:false});
 const pending=sourceModule('src/lib/stock-deduction.ts',mocks);
 await assert.rejects(pending.deductStockForOrder(tx,'o',null),error=>error===reachedPendingLock);
});
for(const revoked of [false,true])test(`session recovery retains the browser origin with a relative redirect; revoked=${revoked}`,async()=>{
 class ApiError extends Error{constructor(status){super('Synthetic revoked session');this.status=status;}}
 class SafeResponse extends Response{static redirect(url){return new SafeResponse(null,{status:307,headers:{location:String(url)}});}}
 let cleared=0;
 const {GET}=sourceModule('src/app/api/auth/recover/route.ts',{'next/server':{NextResponse:SafeResponse},'@/lib/api':{ApiError,requireActiveSession:async()=>{if(revoked)throw new ApiError(403);return {role:'CAFE_OWNER'};},handleApiError:error=>{throw error;}},'@/lib/auth':{clearSessionCookie:async()=>{cleared++;}}});
 const response=await GET({url:'http://localhost:3130/api/auth/recover'});
 assert.equal(response.status,307);assert.equal(response.headers.get('location'),revoked?'/login':'/dashboard');assert.equal(cleared,revoked?1:0);
});