import test from 'node:test';
import assert from 'node:assert/strict';
import {productRows,paymentRows,staffRows,tableRows,pageRows,assertOutputScope,type SaleEvent,type MoneyLeg} from '../src/lib/sales-report-math';
const event=(id:string,amount:string,sku:string,productId:string|null=id):SaleEvent=>({id,orderId:'invoice-'+id,at:'2026-11-03T01:00:00Z',branchId:'b',creatorId:'A',serverId:'C',saleShiftId:'sale',servedShiftId:'serve',postingShiftId:null,sessionId:'visit1',revenue:amount,tax:'0',service:'0',lines:[{id,productId,variantId:null,name:'نفس الاسم',variant:null,sku,skuSource:'current',categoryId:'cat',category:'مشروبات',quantity:1,gross:amount,discount:'0',net:amount}]});
const leg=(id:string,type:'COLLECTION'|'REFUND',amount:string):MoneyLeg=>({id,orderId:'invoice-x',at:'2026-11-03T02:00:00Z',branchId:'b',actorId:'B',actor:'المحصل',shiftId:type==='REFUND'?'refund':'collect',method:'CASH',type,amount,sessionId:'visit1'});
test('stable IDs and leading-zero SKU; full-scope denominator survives search and pagination',()=>{
 const all=productRows([event('one','4000','0012'),event('two','6000','12')]);
 assert.equal(all.length,2); assert.equal(all.find(r=>r.cells.sku==='0012')?.cells.share,'40.00');
 const visible=pageRows(all,{q:'0012',page:1,pageSize:1,sort:'name'});
 assert.equal(visible.rows.length,1);assert.equal(visible.rows[0].cells.share,'40.00');
});
test('discounts, revision deltas and deleted identities stay exact and reconcile via explicit bridge',()=>{
 const a=event('a','90','0012');a.lines[0].gross='100';a.lines[0].discount='10';
 const revision=event('delta','-20','0012','a');revision.lines[0].quantity=-1;
 const unknown=event('old','5','',null);
 const rows=productRows([a,revision,unknown]);
 assert.equal(rows.find(r=>r.cells.sku==='0012')?.cells.net,'70.00');
 assert.equal(rows.reduce((n,r)=>n+Number(r.cells.net),0),75);
 assert.ok(rows.some(r=>r.cells.skuSource==='unmapped'));
 assert.equal(productRows([event('zero','0','0')])[0].cells.share,null);
 assert.equal(productRows([event('negative','-1','1')])[0].cells.share,null);
});
test('actual payment legs exclude invoice repetition and preserve positive refund magnitude',()=>{
 const rows=paymentRows([leg('p1','COLLECTION','40'),leg('p2','COLLECTION','60'),leg('r','REFUND','15')]);
 assert.deepEqual(rows.map(r=>r.cells.amount),['40.00','60.00','15.00']);
 assert.deepEqual(rows.map(r=>r.cells.shift),['collect','collect','refund']);
});
test('creator A collector B server C use distinct event bases',()=>{
 const events=[event('x','100','0012')],legs=[leg('p','COLLECTION','70')];
 assert.equal(staffRows(events,legs,'creator')[0].id,'A');
 assert.equal(staffRows(events,legs,'server')[0].id,'C');
 assert.equal(staffRows(events,legs,'collector')[0].id,'B');
 assert.equal(staffRows(events,legs,'collector')[0].cells.net,'70.00');
});
test('table visits remain separate and duplicate payment relationships never multiply money',()=>{
 const p=leg('p','COLLECTION','50');
 const sessions=[{id:'visit1',table:'1',branch:'b',startedAt:p.at,closedAt:null,status:'OPEN',remaining:'20'}, {id:'visit2',table:'1',branch:'b',startedAt:p.at,closedAt:p.at,status:'CLOSED',remaining:'0'}];
 const rows=tableRows(sessions,[event('a','100','1')],[p,p]);
 assert.equal(rows.length,2);assert.equal(rows[0].cells.collections,'50.00');assert.equal(rows[1].cells.collections,'0.00');
});
test('61 records prove page export and complete filtered export are different',()=>{
 const rows=productRows(Array.from({length:61},(_,i)=>event(String(i),'1',String(i))));
 assert.equal(pageRows(rows,{page:1,pageSize:30,sort:'name'}).rows.length,30);
 assert.equal(pageRows(rows,{page:3,pageSize:30,sort:'name'}).rows.length,1);
 assert.equal(pageRows(rows,{page:1,pageSize:30,sort:'name',all:true}).rows.length,61);
});
test('output scope rejects changed tenant, branch, role or permissions',()=>{
 assertOutputScope('c|b|owner|a,b','c|b|owner|a,b');
 for(const changed of ['d|b|owner|a,b','c|x|owner|a,b','c|b|staff|a,b','c|b|owner|a'])assert.throws(()=>assertOutputScope('c|b|owner|a,b',changed));
});

import {reportQuerySchema} from '../src/lib/sales-report-query';
test('report query rejects invalid calendar days, reversed dates, excess bounds and unknown fields',()=>{
 for(const input of [{from:'2026-02-30'},{from:'2026-11-03',to:'2026-11-02'},{pageSize:'501'},{sort:'sql'},{cafe:'other'}])assert.equal(reportQuerySchema.safeParse(input).success,false);
 assert.equal(reportQuerySchema.parse({page:'3',pageSize:'30'}).page,3);
});

import {recognitionShift,reconcileProductSales} from '../src/lib/sales-report-math';
test('later adjustments never fall back to the original closed sale shift',()=>{
 const original=event('x','110','0012'),revision={...event('delta','-10','0012'),id:'revision:delta',saleShiftId:'sale',postingShiftId:'adjust'};
 assert.equal(recognitionShift(original),'sale');assert.equal(recognitionShift(revision),'adjust');assert.equal(recognitionShift({...revision,postingShiftId:null}),null);
});
test('discounted invoice, served revision and partial refund reconcile exactly with tax and service',()=>{
 const sale=event('x','120','0012');sale.tax='10';sale.service='10';sale.lines[0].net='100';
 const amendment=event('delta','-10','0012','x');amendment.lines[0].net='-20';
 const r=reconcileProductSales([sale,amendment],'15');
 assert.deepEqual(r,{itemNet:'80.00',canonicalNet:'95.00',tax:'10.00',service:'10.00',bridge:'-5.00'});
 assert.equal(Number(r.itemNet)+Number(r.tax)+Number(r.service)+Number(r.bridge),Number(r.canonicalNet));
});

import {windowsForDates} from '../src/lib/business-day';
import {visibleReportCatalog} from '../src/lib/report-center';
import {SALES_REPORT_CATALOG} from '../src/lib/sales-report-catalog';
test('a 23:00–07:00 business window stays intact and date grouping uses its business date',()=>{
 const [w]=windowsForDates('b','2026-11-02','2026-11-02',[{startTime:'23:00',endTime:'07:00',timezone:'Africa/Cairo',is24Hours:false,effectiveDate:'2026-01-01'}]);
 assert.equal(w.to.getTime()-w.from.getTime(),8*60*60*1000);
 const sale={...event('night','100','0012'),at:new Date(w.from.getTime()+3*60*60*1000).toISOString(),businessDate:w.businessDate};
 assert.equal(productRows([sale],'date')[0].cells.name,'2026-11-02');
});
test('physical receipts remain a separate documented quantity, never a money refund inference',()=>{
 const sale=event('goods','100','0012');sale.lines[0].quantity=5;sale.lines[0].returned=2;
 const row=productRows([sale])[0];assert.equal(row.cells.quantity,'5');assert.equal(row.cells.returned,'2');assert.equal(row.cells.net,'100.00');assert.equal(row.cells.allocatedRefund,null);
});
test('one catalog drives all six reports and gates combined purchase costs and optional modules',()=>{
 const keys=new Set(SALES_REPORT_CATALOG.flatMap(r=>r.keys));
 const features={inventoryEnabled:true,purchasesEnabled:true,shiftManagementEnabled:true,enableTables:true};
 const reports=visibleReportCatalog({keys,features,role:'CAFE_OWNER'});
 for(const entry of SALES_REPORT_CATALOG)assert.ok(reports.some(r=>r.id===entry.id&&r.href==='/reports/'+entry.id));
 keys.delete('purchases.view_cost');assert.ok(!visibleReportCatalog({keys,features,role:'CAFE_OWNER'}).some(r=>r.id==='purchase-sales'));
 assert.ok(!visibleReportCatalog({keys,features:{...features,enableTables:false},role:'CAFE_OWNER'}).some(r=>r.id==='tables'));
});

import {eventShiftForBasis,activitySessionIds,normalizePaymentEvidence} from '../src/lib/sales-report-math';
test('served-by filtering follows service shift B while creator follows sale A and revision follows posting C',()=>{
 const e={...event('x','100','0012'),saleShiftId:'A',servedShiftId:'B'};
 assert.equal(eventShiftForBasis(e,'server'),'B');assert.equal(eventShiftForBasis(e,'creator'),'A');
 assert.equal(eventShiftForBasis({...e,id:'revision:x',postingShiftId:'C'},'server'),'C');
});
test('activity session candidates include closed visits referenced only by revisions or legacy order-linked payments',()=>{
 const revision={...event('x','-5','0012'),id:'revision:x',sessionId:'closed-revision'};
 const payment={...leg('old','COLLECTION','10'),sessionId:'closed-payment'};
 assert.deepEqual(activitySessionIds([revision],[payment]),['closed-revision','closed-payment']);
});
test('legacy refunded collection preserves gross pair and source evidence without inventing a refund actor',()=>{
 const source={...leg('old','COLLECTION','100'),status:'REFUNDED'};
 const rows=normalizePaymentEvidence(source);
 assert.equal(rows.length,2);assert.equal(rows[0].type,'COLLECTION');assert.equal(rows[1].type,'REFUND');
 assert.equal(rows[0].sourceId,'old');assert.equal(rows[1].sourceId,'old');assert.notEqual(rows[0].id,rows[1].id);assert.equal(rows[1].actorId,null);
 assert.equal(rows.filter(r=>r.type==='COLLECTION').reduce((n,r)=>n+Number(r.amount),0),100);
 assert.equal(rows.filter(r=>r.type==='REFUND').reduce((n,r)=>n+Number(r.amount),0),100);
 assert.deepEqual(normalizePaymentEvidence({...source,status:'UNPAID'}),[]);
});
