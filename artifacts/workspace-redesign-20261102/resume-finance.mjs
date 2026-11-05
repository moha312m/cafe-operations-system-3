import assert from 'node:assert/strict';
import {readFileSync,writeFileSync}from'node:fs';
import {randomUUID}from'node:crypto';
import {PrismaClient}from'@prisma/client';
import path from'node:path';
const here=path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/,'$1'));
const file=path.join(here,'private-config.json'),config=JSON.parse(readFileSync(file,'utf8'));
process.env.NEXTCUP_WORKSPACE_CONFIG=file;process.env.NEXTCUP_WORKSPACE_FIXTURES=path.join(here,'private-fixtures.json');process.env.DATABASE_URL=config.databaseUrl;process.env.AUTH_SECRET=config.authSecret;
const {verifyWorkspace,sha}=await import('./workspace-guard.mjs');const {config:verified}=await verifyWorkspace({requireCorrespondence:true}),fx=verified.fixtures;
const initialFile=path.join(here,'finance-runtime-1793611412480.json'),initial=JSON.parse(readFileSync(initialFile,'utf8')),ids=initial.retainedIds;
assert.equal(initial.runId,config.runId);assert.equal(initial.status,'FAIL');
const db=new PrismaClient({datasourceUrl:config.databaseUrl});const cases=[];
async function req(route,body,method=body===undefined?'GET':'POST',key=randomUUID()) {const r=await fetch(config.baseUrl+route,{method,headers:{Cookie:fx.ownerCookie,...body===undefined?{}:{'Content-Type':'application/json','Idempotency-Key':key}},...body===undefined?{}:{body:JSON.stringify(body)},signal:AbortSignal.timeout(60000)});return{status:r.status,body:await r.json()};}
async function check(name,run){try{await run();cases.push({name,status:'PASS'});}catch(e){cases.push({name,status:'FAIL',detail:e.message});}}
try{
 await check('retained draft replay/filter/unknown-opening refusal/cancellation has no money effect',async()=>{
  const t=await db.moneyTransfer.findUniqueOrThrow({where:{id:ids.transfer}});assert.equal(t.cafeId,fx.cafeId);assert.equal(t.status,'DRAFT');
  const replay=await req('/api/treasury/transfers',{fromAccountId:t.fromAccountId,toAccountId:t.toAccountId,amount:Number(t.amount),channel:t.channel,note:t.note},'POST',t.creationKey);assert.equal(replay.status,201);assert.equal(replay.body.transferId,t.id);
  assert.equal((await req('/api/treasury/transfers/'+t.id+'/dispatch',{moneyLeft:false})).status,400);
  const dispatch=await req('/api/treasury/transfers/'+t.id+'/dispatch',{moneyLeft:true});assert.equal(dispatch.status,409);assert.ok(dispatch.body.error.includes('غير معلوم'));
  const search=await req('/api/treasury/transfers?'+new URLSearchParams({status:'DRAFT',q:t.note,accountId:ids.bank,branchId:fx.branchId}));assert.equal(search.status,200);assert.equal(search.body.count,0,'Full note text does not match account names or reference');
  const byAccount=await req('/api/treasury/transfers?'+new URLSearchParams({status:'DRAFT',accountId:ids.bank,branchId:fx.branchId}));assert.equal(byAccount.status,200);assert.equal(byAccount.body.count,1);assert.equal(byAccount.body.transfers[0].id,t.id);
  const cancel=await req('/api/treasury/transfers/'+t.id+'/cancel',{reason:'إلغاء المسودة الاختبارية'});assert.equal(cancel.status,201);
  assert.equal((await db.moneyTransfer.findUniqueOrThrow({where:{id:t.id}})).status,'CANCELLED');assert.equal(await db.moneyMovement.count({where:{cafeId:fx.cafeId}}),0);
 });
 await check('exact retained expense search regression returns matching receipt/count/totals and stored category snapshot search',async()=>{
  const e=await db.operatingExpense.findUniqueOrThrow({where:{id:ids.expense}});assert.equal(e.cafeId,fx.cafeId);
  const list=await req('/api/expenses?'+new URLSearchParams({q:e.description,branchId:fx.branchId,categoryId:e.categoryId}));assert.equal(list.status,200,JSON.stringify(list.body));assert.equal(list.body.count,1);assert.equal(list.body.expenses[0].id,e.id);assert.equal(list.body.totals.paid,12.34);
  assert.equal(await db.operatingExpense.count({where:{cafeId:fx.cafeId,description:e.description}}),1);
  const byCategory=await req('/api/expenses?'+new URLSearchParams({q:e.categoryNameSnapshot,branchId:fx.branchId,categoryId:e.categoryId}));assert.equal(byCategory.status,200);assert.equal(byCategory.body.count,2);assert.equal(byCategory.body.totals.paid,17.34);
  assert.equal(await db.accountingEntity.count({where:{cafeId:fx.cafeId}}),0);
 });
 const result={at:new Date().toISOString(),runId:config.runId,initial:{file:path.basename(initialFile),sha256:sha(readFileSync(initialFile)),retained:true},sourceSha256:config.source.sha256,cases,status:cases.every(c=>c.status==='PASS')?'PASS':'FAIL',noNewBusinessFixtures:true};
 const out=path.join(here,'finance-runtime-resume-'+Date.now()+'.json');writeFileSync(out,JSON.stringify(result,null,2),{flag:'wx'});console.log(JSON.stringify({...result,out}));if(result.status!=='PASS')process.exitCode=1;
}finally{await db.$disconnect();}
