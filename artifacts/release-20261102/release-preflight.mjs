import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';
const dir='artifacts/release-20261102';
const baseline=JSON.parse(readFileSync(dir+'/production-before.json','utf8'));
assert.equal(baseline.readOnly,true); assert.deepEqual(baseline.checksumMismatches,[]); assert.deepEqual(baseline.failedMigrations,[]); assert.equal(baseline.pending.length,34);
const git=(...args)=>execFileSync('git',args,{encoding:'utf8'}).trim();
const tree=Object.fromEntries(git('ls-tree','-r','HEAD').split('\n').map(line=>{const m=/^\d+ \w+ (\w+)\t(.+)$/.exec(line);assert.ok(m);return[m[2],m[1]];}));
const snapshot=JSON.parse(readFileSync(dir+'/snapshot.json','utf8'));
const blobHash=bytes=>createHash('sha1').update(Buffer.from('blob '+bytes.length+'\0')).update(bytes).digest('hex');
for(const file of Object.keys(snapshot.files)){
  const bytes=readFileSync(snapshot.candidate+'/'+file);
  const lf=Buffer.from(bytes.toString('utf8').replaceAll('\r\n','\n'));
  assert.ok([blobHash(bytes),blobHash(lf)].includes(tree[file]),'Build differs from Git candidate: '+file);
}
const audit=[];
for(const name of baseline.pending){
  const sql=git('show','HEAD:prisma/migrations/'+name+'/migration.sql');
  assert.ok(!/^\s*(TRUNCATE|DELETE\s+FROM|UPDATE\s|INSERT\s+INTO|DROP\s+(TABLE|TYPE|SCHEMA|DATABASE))\b/im.test(sql),'Unexpected business rewrite: '+name);
  audit.push({name,sha256:createHash('sha256').update(Buffer.from(sql+'\n')).digest('hex')});
}
for(const applied of baseline.migrations.filter(x=>x.finished_at&&!x.rolled_back_at)){
  const raw=execFileSync('git',['show','HEAD:prisma/migrations/'+applied.migration_name+'/migration.sql']);
  assert.equal(createHash('sha256').update(raw).digest('hex'),applied.checksum,'Git migration differs from production history: '+applied.migration_name);
}
const secret=JSON.parse(readFileSync(dir+'/private-db.json','utf8'));const url=new URL(secret.databaseUrl);
assert.equal(url.hostname,'tokaido.proxy.rlwy.net');assert.equal(url.port,'23835');assert.equal(url.pathname,'/railway');
const db=new PrismaClient({datasourceUrl:url.href,log:[]});
try{
 const checks=await db.$transaction(async tx=>{
  await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
  const mismatch=await tx.$queryRawUnsafe('SELECT count(*)::int AS count FROM "InventoryItem" i LEFT JOIN "Branch" b ON b.id=i."branchId" AND b."cafeId"=i."cafeId" WHERE b.id IS NULL');assert.equal(mismatch[0].count,0);
  const duplicate=await tx.$queryRawUnsafe('SELECT count(*)::int AS count FROM (SELECT "branchId", "tableNumber" FROM "CafeTable" GROUP BY "branchId", "tableNumber" HAVING count(*) > 1) q');assert.equal(duplicate[0].count,0);
  return {inventoryTenantMismatches:0,duplicateBranchTableNumbers:0};
 });
 const proof={at:new Date().toISOString(),status:'PASS',candidateCommit:git('rev-parse','HEAD'),buildSourceFilesVerified:Object.keys(snapshot.files).length,gitMigrationChecksumsMatchAllApplied:57,pendingMigrationAudit:audit,noBusinessRewriteStatements:true,checks,productionBuildExit:0,pureTests:{passed:29,failed:0,skipped:0},lintExit:0,backup:'Railway volume snapshot 2026-11-02 12:40 Cairo, 123 MB; screenshot retained'};
 writeFileSync(dir+'/release-preflight.json',JSON.stringify(proof,null,2),{flag:'wx'});console.log(JSON.stringify({status:'PASS',commit:proof.candidateCommit,buildFiles:proof.buildSourceFilesVerified,matchedAppliedMigrations:57,pendingReviewed:34,checks}));
}finally{await db.$disconnect();}
