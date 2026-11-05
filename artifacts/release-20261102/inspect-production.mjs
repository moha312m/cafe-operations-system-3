import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import path from 'node:path';
assert.ok(process.argv.includes('--production-read-only'));
const dir = path.resolve('artifacts/release-20261102');
const secret = JSON.parse(readFileSync(path.join(dir,'private-db.json'),'utf8'));
const url = new URL(secret.databaseUrl);
assert.equal(url.hostname, 'tokaido.proxy.rlwy.net'); assert.equal(url.port,'23835'); assert.equal(url.pathname,'/railway');
url.searchParams.set('connection_limit','1'); url.searchParams.set('connect_timeout','20');
const db = new PrismaClient({datasourceUrl:url.href,log:[]});
const quote = value => '"' + value.replaceAll('"','""') + '"';
const after = process.argv.includes('--after');
const previous = after ? JSON.parse(readFileSync(path.join(dir,'production-before.json'),'utf8')) : null;
try {
  const result = await db.$transaction(async tx => {
    await tx.$executeRawUnsafe('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
    const identity = await tx.$queryRawUnsafe("SELECT current_database() AS database, current_setting('transaction_read_only') AS read_only, current_setting('server_version') AS version");
    assert.equal(identity[0].database,'railway'); assert.equal(identity[0].read_only,'on');
    const migrations = await tx.$queryRawUnsafe('SELECT migration_name, checksum, finished_at, rolled_back_at, applied_steps_count FROM "_prisma_migrations" ORDER BY migration_name');
    const local = readdirSync('prisma/migrations',{withFileTypes:true}).filter(x=>x.isDirectory()).map(x=>x.name).sort();
    const applied = migrations.filter(x=>x.finished_at && !x.rolled_back_at);
    const mismatch = [], normalizedOnly = [];
    for(const m of applied) {
      if(!local.includes(m.migration_name)){mismatch.push({name:m.migration_name,reason:'missing-local'});continue;}
      const bytes=readFileSync('prisma/migrations/'+m.migration_name+'/migration.sql');
      if(createHash('sha256').update(bytes).digest('hex')!==m.checksum) {
        const lf=bytes.toString('utf8').replaceAll('\r\n','\n');
        if([lf,lf.replaceAll('\n','\r\n')].some(x=>createHash('sha256').update(x).digest('hex')===m.checksum)) normalizedOnly.push(m.migration_name);
        else mismatch.push({name:m.migration_name,reason:'checksum'});
      }
    }
    const pending=local.filter(n=>!applied.some(m=>m.migration_name===n));
    const tables=previous ? Object.keys(previous.records) : (await tx.$queryRawUnsafe("SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename <> '_prisma_migrations' ORDER BY tablename")).map(x=>x.tablename);
    const records={};
    for(const table of tables) {
      const columns=previous?.records[table].columns ?? (await tx.$queryRawUnsafe("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position",table)).map(x=>x.column_name);
      const list=columns.map(quote).join(',');
      const rows=await tx.$queryRawUnsafe(`SELECT count(*)::int AS count, md5(COALESCE(string_agg(digest, ',' ORDER BY digest),'')) AS hash FROM (SELECT md5(row_to_json(r)::text) AS digest FROM (SELECT ${list} FROM ${quote(table)}) r) q`);
      records[table]={columns,...rows[0]};
    }
    return {at:new Date().toISOString(),identity:identity[0],readOnly:true,migrations,pending,checksumMismatches:mismatch,lineEndingOnlyChecksums:normalizedOnly,failedMigrations:migrations.filter(x=>!x.finished_at&&!x.rolled_back_at).map(x=>x.migration_name),records};
  },{maxWait:30000,timeout:180000});
  if(previous) result.changedTables=Object.keys(previous.records).filter(t=>result.records[t].count!==previous.records[t].count || result.records[t].hash!==previous.records[t].hash);
  writeFileSync(path.join(dir,after?'production-after.json':'production-before.json'),JSON.stringify(result,null,2),{flag:'wx'});
  console.log(JSON.stringify({status:'READ_ONLY_CAPTURED',applied:result.migrations.filter(x=>x.finished_at&&!x.rolled_back_at).length,pending:result.pending,checksumMismatches:result.checksumMismatches,lineEndingOnlyChecksums:result.lineEndingOnlyChecksums,failedMigrations:result.failedMigrations,records:Object.fromEntries(Object.entries(result.records).map(([t,v])=>[t,v.count])),...(after?{changedTables:result.changedTables}:{})}));
} finally {await db.$disconnect();}
