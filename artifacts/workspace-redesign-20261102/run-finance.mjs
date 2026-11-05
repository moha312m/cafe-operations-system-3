import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import path from 'node:path';
const here=path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/,'$1'));
const configFile=path.join(here,'private-config.json'),config=JSON.parse(readFileSync(configFile,'utf8'));
process.env.NEXTCUP_WORKSPACE_CONFIG=configFile;process.env.NEXTCUP_WORKSPACE_FIXTURES=path.join(here,'private-fixtures.json');process.env.DATABASE_URL=config.databaseUrl;process.env.AUTH_SECRET=config.authSecret;
const {verifyWorkspace}=await import('./workspace-guard.mjs');const verified=await verifyWorkspace({requireCorrespondence:true}),fx=verified.config.fixtures;
const db=new PrismaClient({datasourceUrl:config.databaseUrl}),cases=[],ids={};
const tag=randomUUID().slice(0,8).toUpperCase();
async function req(route,body,cookie=fx.ownerCookie,method=body===undefined?'GET':'POST',key=randomUUID()){
 const r=await fetch(config.baseUrl+route,{method,headers:{Cookie:cookie,...body===undefined?{}:{'Content-Type':'application/json','Idempotency-Key':key}},...body===undefined?{}:{body:JSON.stringify(body)},signal:AbortSignal.timeout(60000)});return {status:r.status,body:await r.json()};
}
async function check(name,action){try{await action();cases.push({name,status:'PASS'});}catch(e){cases.push({name,status:'FAIL',detail:String(e.message)});}}
const retain=(kind,id)=>{ids[kind]=id;appendFileSync(path.join(here,'retained-fixtures.jsonl'),JSON.stringify({at:new Date().toISOString(),runId:config.runId,kind,id,retained:true})+'\n');};
try{
 await check('account create/replay preserves unknown balances; named search, kind and branch filters use scoped canonical rows',async()=>{
  for(const [label,kind,branchId]of[['bank','BANK',fx.branchId],['wallet','WALLET',fx.branchId],['safe','TREASURY',fx.branchId],['otherBank','BANK',fx.secondBranchId]]){
   const body={code:'WR_'+label.toUpperCase()+'_'+tag,name:'حساب '+label+' '+tag,kind,branchId,instaPayEnabled:false},key=randomUUID();
   const r=await req('/api/treasury/accounts',body,fx.ownerCookie,'POST',key);assert.equal(r.status,201,JSON.stringify(r.body));assert.ok(r.body.id);retain(label,r.body.id);
   assert.equal(r.body.recordedBalance,null);assert.equal(r.body.openingState,'UNSET');assert.equal(r.body.sourceCoverage,'LIMITED');assert.equal(r.body.realUseReady,false);
   const replay=await req('/api/treasury/accounts',body,fx.ownerCookie,'POST',key);assert.equal(replay.status,201);assert.equal(replay.body.id,r.body.id);
  }
  const r=await req('/api/treasury/accounts?'+new URLSearchParams({q:tag,kind:'BANK',branchId:fx.branchId}));assert.equal(r.status,200);assert.equal(r.body.count,1);assert.deepEqual(r.body.accounts.map(a=>a.id),[ids.bank]);
  assert.equal(await db.moneyAccount.count({where:{cafeId:fx.cafeId,code:{endsWith:tag}}}),4);
 });
 await check('account edits preserve version conflicts and archive/list active status; statements do not invent balances',async()=>{
  const changed=await req('/api/treasury/accounts/'+ids.wallet,{expectedVersion:0,name:'محفظة معدلة '+tag},fx.ownerCookie,'PATCH');assert.equal(changed.status,201,JSON.stringify(changed.body));assert.equal(changed.body.version,1);
  const stale=await req('/api/treasury/accounts/'+ids.wallet,{expectedVersion:0,name:'must not save'},fx.ownerCookie,'PATCH');assert.equal(stale.status,409);
  assert.equal((await db.moneyAccount.findUniqueOrThrow({where:{id:ids.wallet}})).version,1);
  const archived=await req('/api/treasury/accounts/'+ids.wallet,{expectedVersion:1,isActive:false},fx.ownerCookie,'PATCH');assert.equal(archived.status,201);
  const list=await req('/api/treasury/accounts?'+new URLSearchParams({q:tag,active:'false'}));assert.equal(list.body.count,1);assert.equal(list.body.accounts[0].id,ids.wallet);
  const statement=await req('/api/treasury/accounts/'+ids.bank+'/statement');assert.equal(statement.status,200);assert.equal(statement.body.account.recordedBalance,null);assert.deepEqual(statement.body.movements,[]);
 });
 await check('draft/replay has one effect, dispatch needs actual confirmation and refuses unknown opening; cancel records no movements',async()=>{
  const body={fromAccountId:ids.safe,toAccountId:ids.bank,amount:10,channel:'INTERNAL',note:'تحويل اختباري '+tag},key=randomUUID();
  const r=await req('/api/treasury/transfers',body,fx.ownerCookie,'POST',key);assert.equal(r.status,201,JSON.stringify(r.body));const id=r.body.transferId??r.body.id;assert.ok(id);retain('transfer',id);
  const replay=await req('/api/treasury/transfers',body,fx.ownerCookie,'POST',key);assert.equal(replay.status,201);assert.equal(replay.body.transferId??replay.body.id,id);
  assert.equal((await req('/api/treasury/transfers/'+id+'/dispatch',{moneyLeft:false})).status,400);
  const dispatch=await req('/api/treasury/transfers/'+id+'/dispatch',{moneyLeft:true});assert.equal(dispatch.status,409);assert.ok(dispatch.body.error.includes('غير معلوم'));
  const list=await req('/api/treasury/transfers?'+new URLSearchParams({status:'DRAFT',q:tag,accountId:ids.bank,branchId:fx.branchId}));assert.equal(list.status,200);assert.equal(list.body.count,0,'Search is account names/reference, not note');
  const byAccount=await req('/api/treasury/transfers?'+new URLSearchParams({status:'DRAFT',accountId:ids.bank,branchId:fx.branchId}));assert.equal(byAccount.body.count,1);assert.equal(byAccount.body.transfers[0].id,id);
  assert.equal((await req('/api/treasury/transfers/'+id+'/cancel',{reason:'إلغاء المسودة الاختبارية'})).status,201);
  assert.equal((await db.moneyTransfer.findUniqueOrThrow({where:{id}})).status,'CANCELLED');assert.equal(await db.moneyMovement.count({where:{cafeId:fx.cafeId}}),0);
 });
 await check('treasury owner-only, revoked-session and tenant guards remain authoritative',async()=>{
  for(const cookie of[fx.restrictedCookie,fx.branchPinnedCookie])assert.equal((await req('/api/treasury/accounts',undefined,cookie)).status,403);
  assert.ok([401,403].includes((await req('/api/treasury/accounts',undefined,fx.revokedCookie)).status));
  assert.equal((await req('/api/treasury/accounts/'+ids.bank,undefined,fx.otherTenantCookie)).status,404);
 });
 await check('expense filters/count/totals match actual retained drawer payouts; retry creates one receipt',async()=>{
  const opened=await req('/api/shifts',{branchId:fx.branchId,openingCashAmount:100});assert.ok([200,201].includes(opened.status),JSON.stringify(opened.body));retain('shift',opened.body.id??opened.body.shift?.id??'recorded via API');
  const category=await db.expenseCategory.findFirstOrThrow({where:{cafeId:fx.cafeId,code:'WORKSPACE'}});
  const body={branchId:fx.branchId,categoryId:category.id,amount:12.34,description:'قهوة اختبار '+tag},key=randomUUID();
  const e=await req('/api/expenses',body,fx.ownerCookie,'POST',key);assert.equal(e.status,201,JSON.stringify(e.body));retain('expense',e.body.id);
  const replay=await req('/api/expenses',body,fx.ownerCookie,'POST',key);assert.equal(replay.status,201);assert.equal(replay.body.id,e.body.id);
  const second=await req('/api/expenses',{...body,amount:5,description:'تنظيف '+tag});assert.equal(second.status,201);retain('expenseOther',second.body.id);
  const listed=await req('/api/expenses?'+new URLSearchParams({q:'قهوة اختبار '+tag,branchId:fx.branchId,categoryId:category.id}));assert.equal(listed.status,200);assert.equal(listed.body.count,1);assert.equal(listed.body.expenses[0].id,e.body.id);assert.equal(listed.body.totals.paid,12.34);
  assert.equal(await db.operatingExpense.count({where:{cafeId:fx.cafeId,description:body.description}}),1);
  assert.equal(await db.accountingEntity.count({where:{cafeId:fx.cafeId}}),0,'Recording fixture expense does not initialize shadow books');
 });
 const result={at:new Date().toISOString(),runId:config.runId,sourceSha256:config.source.sha256,status:cases.every(c=>c.status==='PASS')?'PASS':'FAIL',cases,retainedIds:ids};
 const file=path.join(here,'finance-runtime-'+Date.now()+'.json');writeFileSync(file,JSON.stringify(result,null,2),{flag:'wx'});console.log(JSON.stringify({...result,out:file}));if(result.status!=='PASS')process.exitCode=1;
}finally{await db.$disconnect();}
