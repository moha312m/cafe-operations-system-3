import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {db} from '../src/lib/db';
import type {SessionUser} from '../src/lib/auth';
import {saveReportingHours,resolveReportingSelection,readReportingHours} from '../src/lib/reporting-hours';
import {reportEventWhere} from '../src/lib/report-window-scope';
import {periodFinancials} from '../src/lib/reporting';
import {recognizedSales,contributionTotals} from '../src/lib/sales-recognition';
import {listSales} from '../src/lib/sales-query';
import {reportOutputFiles,signReportOutput,verifyReportOutput} from '../src/lib/report-output';
import {zonedDateTime} from '../src/lib/date-range';
const hours={startTime:'08:00',endTime:'02:00',timezone:'Africa/Cairo',is24Hours:false,effectiveDate:'2026-10-24',acknowledgeGap:true},now=new Date('2026-10-23T09:00Z');
test.before(async()=>{
 assert.equal(process.env.DATABASE_URL,'postgresql://postgres@127.0.0.1:5434/cafe_ops_test_sales_20261024a?schema=public');
 const [id]=await db.$queryRawUnsafe(`SELECT current_database() name,host(inet_server_addr()) host,inet_server_port() port,(SELECT system_identifier::text FROM pg_control_system()) system,(SELECT oid::text FROM pg_database WHERE datname=current_database()) oid`) as unknown[];
 assert.deepEqual(id,{name:'cafe_ops_test_sales_20261024a',host:'127.0.0.1',port:5434,system:'7693368256609479860',oid:'81948'});
 assert.deepEqual(await db.$queryRawUnsafe('SELECT id,note FROM "_disposable_test_database"'),[{id:1,note:'Synthetic Sales amendment tests only. No owner business rows.'}]);
});test.after(()=>db.$disconnect());
async function fixture(){const tag=crypto.randomUUID();const cafe=await db.cafe.create({data:{name:'Business reporting synthetic '+tag,slug:'report-'+tag}});await db.cafeSettings.create({data:{cafeId:cafe.id,advancedReportsEnabled:true}});const a=await db.branch.create({data:{cafeId:cafe.id,name:'A Cairo'}}),b=await db.branch.create({data:{cafeId:cafe.id,name:'B Dubai'}});const owner=await db.user.create({data:{cafeId:cafe.id,email:tag+'@example.invalid',passwordHash:'NO_LOGIN',name:'Synthetic owner',role:'CAFE_OWNER'}});const actor={...owner} as SessionUser;return {cafe,a,b,actor};}
async function sale(f:Awaited<ReturnType<typeof fixture>>,branchId:string,local:string,amount=100){return db.order.create({data:{cafeId:f.cafe.id,branchId,orderNumber:crypto.randomInt(100,2140000000),type:'TAKEAWAY',status:'SERVED',subtotal:amount,total:amount,paidAmount:0,remainingAmount:amount,paymentStatus:'UNPAID',createdById:f.actor.id,createdAt:zonedDateTime(local,'Africa/Cairo').at,items:{create:{productName:'Synthetic tea',quantity:1,unitPrice:amount,lineTotal:amount}}}});}
const params=(branchId?:string,extra:Record<string,string>={})=>new URLSearchParams({reportMode:'business',businessFrom:'2026-10-24',businessTo:'2026-10-24',...(branchId?{branchId}:{}),...extra});
test('SQL filters include 08:00 and next 01:30; outside view exposes both opening-gap and end boundary',async()=>{
 const f=await fixture();await saveReportingHours(f.actor,f.a.id,hours,now);
 const before=await sale(f,f.a.id,'2026-10-24T07:59'),opening=await sale(f,f.a.id,'2026-10-24T08:00'),late=await sale(f,f.a.id,'2026-10-25T01:30'),closing=await sale(f,f.a.id,'2026-10-25T02:00');
 const report=await listSales(f.actor,params(f.a.id));assert.deepEqual(new Set(report.orders.map(o=>o.id)),new Set([opening.id,late.id]));assert.equal(Number(report.totals.total),200);
 const out=await listSales(f.actor,params(f.a.id,{reportMode:'outside'}));assert.deepEqual(out.orders.map(o=>o.id),[closing.id]);assert.equal(out.reporting.outsideCounts[0].orders,1);
 const previous=await listSales(f.actor,params(f.a.id,{reportMode:'outside',businessFrom:'2026-10-23',businessTo:'2026-10-23'}));assert.deepEqual(previous.orders.map(o=>o.id),[before.id]);
});
test('branches, multi-day gaps and consolidated totals use one row per matching transaction',async()=>{
 const f=await fixture();await saveReportingHours(f.actor,f.a.id,hours,now);await saveReportingHours(f.actor,f.b.id,{...hours,startTime:'10:00',endTime:'18:00',timezone:'Asia/Dubai'},now);
 await sale(f,f.a.id,'2026-10-24T09:00',10);await sale(f,f.a.id,'2026-10-25T09:00',20);await sale(f,f.a.id,'2026-10-25T05:00',999);await sale(f,f.b.id,'2026-10-24T09:00',30);
 const selection=await resolveReportingSelection(f.actor,params(undefined,{businessTo:'2026-10-25'}));assert.ok(selection);const scope={cafeId:f.cafe.id,period:{gte:new Date('2020-01-01')},windows:selection.windows};
 const totals=contributionTotals(await recognizedSales(scope));assert.equal(totals.orders,3);assert.equal(totals.revenue,60);assert.equal((await periodFinancials(scope)).grossSales,60);
});
test('collections and refunds use payment timestamps rather than sale date, including legacy nullable branch',async()=>{
 const f=await fixture();await saveReportingHours(f.actor,f.a.id,hours,now);const o=await sale(f,f.a.id,'2026-10-23T10:00');
 await db.payment.createMany({data:[{cafeId:f.cafe.id,orderId:o.id,receivedById:f.actor.id,amount:100,method:'CARD',type:'COLLECTION',createdAt:zonedDateTime('2026-10-25T01:30','Africa/Cairo').at},{cafeId:f.cafe.id,orderId:o.id,receivedById:f.actor.id,amount:25,method:'CARD',type:'REFUND',createdAt:zonedDateTime('2026-10-25T02:00','Africa/Cairo').at}]});
 const s=await resolveReportingSelection(f.actor,params(f.a.id));assert.ok(s);const scope={cafeId:f.cafe.id,period:{gte:new Date('2020-01-01')},windows:s.windows};const r=await periodFinancials(scope);assert.equal(r.grossSales,0);assert.equal(r.collections,100);assert.equal(r.refunds,0);
 const out=await resolveReportingSelection(f.actor,params(f.a.id,{reportMode:'outside'}));assert.ok(out);const outside=await periodFinancials({...scope,windows:out.windows});assert.equal(outside.refunds,25);assert.equal(outside.netSales,-25);
});
test('amendments contribute only their delta at revision time, with original sale preserved',async()=>{
 const f=await fixture();await saveReportingHours(f.actor,f.a.id,hours,now);const o=await sale(f,f.a.id,'2026-10-23T10:00',120);const base={subtotal:'100',total:'100',discountAmount:'0',taxAmount:'0',serviceChargeAmount:'0',status:'SERVED',items:[]};
 await db.orderRevision.create({data:{orderId:o.id,number:1,amendmentId:crypto.randomUUID(),cafeId:f.cafe.id,branchId:f.a.id,actorId:f.actor.id,reason:'Synthetic amendment',before:base,after:{...base,total:'120',subtotal:'120'},oldTotal:100,newTotal:120,discountDelta:0,recognizedDelta:20,createdAt:zonedDateTime('2026-10-25T01:30','Africa/Cairo').at}});
 const s=await resolveReportingSelection(f.actor,params(f.a.id));assert.ok(s);const scope={cafeId:f.cafe.id,period:{gte:new Date('2020-01-01')},windows:s.windows};const rows=await recognizedSales(scope);assert.equal(rows.length,1);assert.equal(rows[0].orders,0);assert.equal(rows[0].revenue,20);assert.equal((await periodFinancials(scope)).grossSales,20);
});
test('saving versions is audited, future-only, immutable and concurrency-safe',async()=>{
 const f=await fixture();const results=await Promise.allSettled([saveReportingHours(f.actor,f.a.id,hours,now),saveReportingHours(f.actor,f.a.id,hours,now)]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 const versions=await readReportingHours(f.actor,f.a.id);assert.equal(versions.length,1);await assert.rejects(()=>db.branchReportingVersion.update({where:{id:versions[0].id},data:{startTime:'09:00'}}));await assert.rejects(()=>db.branchReportingVersion.delete({where:{id:versions[0].id}}));
 const audits=await db.auditLog.findMany({where:{cafeId:f.cafe.id,action:'REPORTING_HOURS_CHANGED'}});assert.equal(audits.length,1);assert.equal(audits[0].userId,f.actor.id);assert.equal((audits[0].details as {effectiveDate:string}).effectiveDate,hours.effectiveDate);
 await assert.rejects(()=>saveReportingHours(f.actor,f.a.id,{...hours,effectiveDate:'2026-10-23'},now));
});
test('configuration gaps require acknowledgement and overlapping transition is rejected',async()=>{
 const f=await fixture();await assert.rejects(()=>saveReportingHours(f.actor,f.a.id,{...hours,acknowledgeGap:false},now));await saveReportingHours(f.actor,f.a.id,hours,now);
 await assert.rejects(()=>saveReportingHours(f.actor,f.a.id,{...hours,startTime:'01:00',endTime:'23:00',effectiveDate:'2026-10-26'},now));assert.equal((await readReportingHours(f.actor,f.a.id)).length,1);
});
test('cashier and cross-branch/cafe attempts cannot read or configure another branch',async()=>{
 const f=await fixture(),foreign=await fixture();const cashier=await db.user.create({data:{cafeId:f.cafe.id,branchId:f.a.id,email:crypto.randomUUID()+'@example.invalid',name:'Cashier',passwordHash:'NO_LOGIN',role:'CASHIER'}});const actor={...cashier} as SessionUser;
 await assert.rejects(()=>saveReportingHours(actor,f.a.id,hours,now));await assert.rejects(()=>readReportingHours(actor,f.b.id));await assert.rejects(()=>resolveReportingSelection(actor,params(f.b.id)));await assert.rejects(()=>readReportingHours(f.actor,foreign.a.id));
 const manager=await db.user.create({data:{cafeId:f.cafe.id,branchId:f.a.id,email:crypto.randomUUID()+'@example.invalid',name:'Manager',passwordHash:'NO_LOGIN',role:'BRANCH_MANAGER',permissionOverrides:{create:{permissionKey:'settings.edit',allowed:true}}}});await saveReportingHours({...manager} as SessionUser,f.a.id,hours,now);await assert.rejects(()=>saveReportingHours({...manager} as SessionUser,f.b.id,hours,now));
});
test('historical versions remain applicable and a custom range does not alter saved configuration',async()=>{
 const f=await fixture();await saveReportingHours(f.actor,f.a.id,hours,now);await saveReportingHours(f.actor,f.a.id,{...hours,startTime:'10:00',endTime:'18:00',effectiveDate:'2026-11-01'},now);
 const old=await resolveReportingSelection(f.actor,params(f.a.id));assert.equal(old?.windows[0].startLocal,'2026-10-24T08:00');const later=await resolveReportingSelection(f.actor,params(f.a.id,{businessFrom:'2026-11-01',businessTo:'2026-11-01'}));assert.equal(later?.windows[0].startLocal,'2026-11-01T10:00');
 const custom=await resolveReportingSelection(f.actor,params(f.a.id,{reportMode:'custom',customStart:'2026-10-24T07:00',customEnd:'2026-10-24T09:00',customTimezone:'Africa/Cairo'}));assert.equal(custom?.windows[0].startLocal,'2026-10-24T07:00');assert.equal((await readReportingHours(f.actor,f.a.id)).length,2);
});
test('unconfigured reporting is unchanged; empty outside window never widens a query',async()=>{
 const f=await fixture();assert.equal(await resolveReportingSelection(f.actor,new URLSearchParams(),{optional:true}),null);const s=await resolveReportingSelection(f.actor,params(f.a.id,{reportMode:'outside'}));assert.equal(s?.windows.length,0);assert.equal(await db.order.count({where:{...reportEventWhere([])}}),0);
});
test('inactive authorized branches remain in historical consolidated reports and explicit legacy filters stay intact',async()=>{
 const f=await fixture();await saveReportingHours(f.actor,f.a.id,hours,now);const o=await sale(f,f.a.id,'2026-10-24T09:00',75);await db.branch.update({where:{id:f.a.id},data:{isActive:false}});
 const all=await listSales(f.actor,params());assert.ok(all.orders.some(row=>row.id===o.id));const selected=await listSales(f.actor,params(f.a.id));assert.equal(selected.orders[0].id,o.id);
 const legacy=new URLSearchParams({from:'2026-10-24',to:'2026-10-24',branchId:f.a.id});assert.equal(await resolveReportingSelection(f.actor,legacy,{optional:true}),null);assert.equal((await listSales(f.actor,legacy)).orders[0].id,o.id);
});
test('custom default timezone is the displayed Cairo choice for every consolidated branch',async()=>{
 const f=await fixture();await saveReportingHours(f.actor,f.a.id,hours,now);await saveReportingHours(f.actor,f.b.id,{...hours,timezone:'Asia/Dubai'},now);
 const custom=await resolveReportingSelection(f.actor,params(undefined,{reportMode:'custom',customStart:'2026-10-24T10:00',customEnd:'2026-10-24T12:00'}));assert.ok(custom);assert.equal(new Set(custom.windows.map(w=>w.from.toISOString())).size,1);assert.ok(custom.windows.every(w=>w.timezone==='Africa/Cairo'));
});
test('signed print and CSV use the same snapshot totals/periods, reject tampering and different users',()=>{
 const report={title:'تقرير مخصص',reporting:{mode:'custom',start:'2026-10-24T05:00Z',end:'2026-10-24T23:00Z'},metrics:{grossSales:100,refunds:25,collections:80,netSales:75},rows:[{product:'<script>bad</script>',total:'=cmd'}],generatedAt:'2026-10-25T00:00Z'};
 const token=signReportOutput('owner',report),verified=verifyReportOutput('owner',token),files=reportOutputFiles(verified);assert.deepEqual(verified,report);for(const value of ['100','25','80','75','2026-10-24T05:00Z','2026-10-24T23:00Z']){assert.ok(files.csv.includes(value));assert.ok(files.html.includes(value));}assert.ok(!files.html.includes('<script>'));assert.throws(()=>verifyReportOutput('other',token));assert.throws(()=>verifyReportOutput('owner',token+'x'));
});
