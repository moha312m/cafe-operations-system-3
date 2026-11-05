import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {PrismaClient} from '@prisma/client';
const dir='artifacts/release-20261102';
assert.ok(process.argv.includes('--owner-approved-next-trial'));
const {databaseUrl}=JSON.parse(readFileSync(dir+'/private-db.json','utf8'));
const url=new URL(databaseUrl);assert.equal(url.hostname,'tokaido.proxy.rlwy.net');assert.equal(url.port,'23835');assert.equal(url.pathname,'/railway');
const healthy=JSON.parse(readFileSync(dir+'/healthy-release.json','utf8'));assert.equal(healthy.commit,'f4ff365c472f');assert.equal(healthy.ok,true);
const after=JSON.parse(readFileSync(dir+'/production-after.json','utf8'));assert.equal(after.pending.length,0);assert.equal(after.migrations.filter(x=>x.finished_at&&!x.rolled_back_at).length,91);
assert.ok(after.changedTables.every(x=>['AuditLog','User','CafeRolePermission'].includes(x)));
process.env.DATABASE_URL=databaseUrl;
const {auditInTransaction}=await import('../../src/lib/audit.ts');
const db=new PrismaClient({datasourceUrl:databaseUrl,log:[]});
const cafeId='cmrmxkpel0004pi0p974rpmil';
try{
 const result=await db.$transaction(async tx=>{
  await tx.$executeRawUnsafe("SET LOCAL lock_timeout='2s'");
  await tx.$executeRawUnsafe("SET LOCAL statement_timeout='10s'");
  const cafe=await tx.cafe.findUnique({where:{id:cafeId},select:{id:true,slug:true,name:true}});assert.equal(cafe?.slug,'next');
  await tx.$queryRawUnsafe('SELECT id FROM "CafeSettings" WHERE "cafeId"=$1 FOR UPDATE',cafeId);
  const prev=await tx.cafeSettings.findUniqueOrThrow({where:{cafeId}});assert.equal(prev.inventoryEnforcementMode,'ALLOW_NEGATIVE_STOCK','Policy already changed; inspect before retrying');
  const next=await tx.cafeSettings.update({where:{id:prev.id},data:{inventoryEnforcementMode:'OVERRIDE_ALL'}});
  await auditInTransaction(tx,{cafeId,userId:null,action:'INVENTORY_ENFORCEMENT_MODE_CHANGED',entity:'CafeSettings',entityId:next.id,details:{byName:'Owner-authorized Railway release administration',scope:'CAFE',oldValue:prev.inventoryEnforcementMode,newValue:next.inventoryEnforcementMode,reason:'Temporary café trial with existing menu and no recipes; consumption/cost reports remain incomplete',authorization:'Owner explicitly selected Enable Override all for the café trial in this chat on 2026-11-02',source:'NEXT CUP release automation; not attributed to a signed-in staff account',release:'f4ff365c472f55fca101250bc4ed897f8175b4d6'}});
  const differences=Object.keys(prev).filter(key=>JSON.stringify(prev[key])!==JSON.stringify(next[key]));assert.deepEqual(differences.sort(),['inventoryEnforcementMode','updatedAt'].sort());
  return {cafeId,cafeSlug:cafe.slug,oldValue:prev.inventoryEnforcementMode,newValue:next.inventoryEnforcementMode,changedFields:differences,transactionalAudit:true,staffImpersonation:false};
 },{maxWait:10000,timeout:30000});
 const receipt={at:new Date().toISOString(),status:'APPLIED',...result};writeFileSync(dir+'/approved-trial-policy.json',JSON.stringify(receipt,null,2),{flag:'wx'});console.log(JSON.stringify(receipt));
}finally{await db.$disconnect();}
