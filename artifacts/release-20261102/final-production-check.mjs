import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {PrismaClient} from '@prisma/client';
const dir='artifacts/release-20261102';
const before=JSON.parse(readFileSync(dir+'/production-before.json','utf8'));
const {databaseUrl}=JSON.parse(readFileSync(dir+'/private-db.json','utf8'));const url=new URL(databaseUrl);
assert.equal(url.hostname,'tokaido.proxy.rlwy.net');assert.equal(url.port,'23835');assert.equal(url.pathname,'/railway');
const quote=x=>'"'+x.replaceAll('"','""')+'"';const literal=x=>"'"+x.replaceAll("'","''")+"'";
const db=new PrismaClient({datasourceUrl:databaseUrl,log:[]});
try{
 const result=await db.$transaction(async tx=>{
  await tx.$executeRawUnsafe('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
  const tables=Object.keys(before.records).filter(t=>!['AuditLog','User','CafeRolePermission','CafeSettings'].includes(t));
  const query=tables.map(t=>`SELECT ${literal(t)} AS name,count(*)::int AS count,md5(COALESCE(string_agg(digest,',' ORDER BY digest),'')) AS hash FROM (SELECT md5(row_to_json(r)::text) AS digest FROM (SELECT ${before.records[t].columns.map(quote).join(',')} FROM ${quote(t)}) r) q`).join(' UNION ALL ');
  const rows=await tx.$queryRawUnsafe(query);for(const row of rows){assert.equal(row.count,before.records[row.name].count,row.name+' count changed');assert.equal(row.hash,before.records[row.name].hash,row.name+' content changed');}
  const cafe=await tx.cafe.findUniqueOrThrow({where:{id:'cmrmxkpel0004pi0p974rpmil'},select:{id:true,slug:true,name:true,settings:{select:{inventoryEnforcementMode:true,enableTables:true,finishedGoodsSalesEnabled:true}},users:{where:{role:'CAFE_OWNER',isActive:true},select:{email:true,name:true}}}});assert.equal(cafe.slug,'next');assert.equal(cafe.settings.inventoryEnforcementMode,'OVERRIDE_ALL');assert.equal(cafe.settings.enableTables,true);assert.equal(cafe.settings.finishedGoodsSalesEnabled,false);
  const logs=await tx.auditLog.findMany({where:{cafeId:cafe.id,action:'INVENTORY_ENFORCEMENT_MODE_CHANGED'},select:{id:true,userId:true,details:true}});const policyAudit=logs.filter(x=>x.details?.release==='f4ff365c472f55fca101250bc4ed897f8175b4d6');assert.equal(policyAudit.length,1);assert.equal(policyAudit[0].userId,null);
  const books=await tx.accountingEntity.count();const moneyAccounts=await tx.moneyAccount.count();const entries=await tx.journalEntry.count();assert.equal(books,0);assert.equal(moneyAccounts,0);assert.equal(entries,0);
  const migrations=await tx.$queryRawUnsafe('SELECT count(*) FILTER (WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL)::int AS applied,count(*) FILTER (WHERE finished_at IS NULL AND rolled_back_at IS NULL)::int AS failed FROM "_prisma_migrations"');assert.equal(migrations[0].applied,91);assert.equal(migrations[0].failed,0);
  return {at:new Date().toISOString(),status:'PASS',readOnly:true,unchangedTables:rows.length,records:Object.fromEntries(rows.map(x=>[x.name,{count:x.count,hash:x.hash}])),migrations:migrations[0],trialPolicy:{cafeId:cafe.id,slug:cafe.slug,mode:cafe.settings.inventoryEnforcementMode,enableTables:true,auditId:policyAudit[0].id,systemAudit:true},noBooksCreated:{books,moneyAccounts,entries},ownerAccounts:cafe.users,allowedChanges:['auth login audit/timestamps','runtime permission-catalog synchronization','owner-approved next trial policy and transactional system audit'],noSyntheticOrdersPaymentsOrShifts:true};
 },{maxWait:20000,timeout:60000});
 writeFileSync(dir+'/final-production-check.json',JSON.stringify(result,null,2),{flag:'wx'});console.log(JSON.stringify({status:result.status,unchangedTables:result.unchangedTables,migrations:result.migrations,trialPolicy:result.trialPolicy,noBooksCreated:result.noBooksCreated,ownerAccounts:result.ownerAccounts,noSyntheticOrdersPaymentsOrShifts:true}));
}finally{await db.$disconnect();}
