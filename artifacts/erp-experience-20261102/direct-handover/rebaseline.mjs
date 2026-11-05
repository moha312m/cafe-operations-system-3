// Direct-handover closeout preview evidence. The original reviewed guard (workspace-guard.mjs) pins 91
// migrations and workspace-guard-4b2.mjs pins 93; this closeout adds three reviewed direct-handover
// migrations (93 -> 96), so a copy of workspace-guard.mjs is made whose only change is that count (91 -> 96).
// Every earlier guard and config file stays untouched.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';

const dir = path.resolve('artifacts/workspace-redesign-20261102');
const original = fs.readFileSync(path.join(dir, 'workspace-guard.mjs'), 'utf8');
assert.equal(original.split("assert.equal(config.migrations.rows.length, 91);").length - 1, 1, 'expected exactly one pinned count');
const copy = original.replace("assert.equal(config.migrations.rows.length, 91);", "assert.equal(config.migrations.rows.length, 96);");
const guardPath = path.join(dir, 'workspace-guard-direct-handover.mjs');
fs.writeFileSync(guardPath, copy);
const { sourceFiles, sha } = await import('../../workspace-redesign-20261102/workspace-guard-direct-handover.mjs');

const config = JSON.parse(fs.readFileSync(path.join(dir, 'private-step5-config.json'), 'utf8'));
const db = new PrismaClient({ datasourceUrl: config.databaseUrl });
try {
  const rows = await db.$transaction(async tx => {
    await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
    const [id] = await tx.$queryRawUnsafe("SELECT current_database() AS name, (SELECT oid::text FROM pg_database WHERE datname=current_database()) AS oid");
    assert.equal(id.name, config.database.name);
    assert.equal(id.oid, '65538');
    return (await tx.$queryRawUnsafe('SELECT migration_name AS name,checksum,finished_at IS NOT NULL AS finished,rolled_back_at IS NOT NULL AS rolled_back FROM "_prisma_migrations" ORDER BY migration_name'));
  });
  assert.ok(rows.every(r => r.finished && !r.rolled_back));
  const migrations = rows.map(({ name, checksum }) => ({ name, checksum }));
  const names = fs.readdirSync('prisma/migrations', { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort();
  assert.deepEqual(names, migrations.map(m => m.name).sort(), 'DB and repository migration inventories must match');
  assert.equal(migrations.length, 96);
  const old = new Set(config.migrations.rows.map(r => r.name + r.checksum));
  const added = migrations.filter(m => !old.has(m.name + m.checksum));
  assert.deepEqual(
    added.map(m => m.name),
    [
      '20261106090000_direct_handover_cash_disposition',
      '20261106100000_handover_issue',
      '20261106110000_handover_direct_flag',
    ],
    'only the three reviewed direct-handover migrations are new; the 93 earlier rows are unchanged'
  );
  for (const m of added) {
    const diskChecksum = sha(fs.readFileSync(path.join('prisma/migrations', m.name, 'migration.sql')));
    assert.equal(m.checksum, diskChecksum, 'Checksum of added migration matches disk: ' + m.name);
  }
  config.migrations = { count: migrations.length, rows: migrations, sha256: sha(Buffer.from(JSON.stringify(migrations))) };
} finally {
  await db.$disconnect();
}

const files = Object.fromEntries(sourceFiles().map(p => [p, sha(fs.readFileSync(p))]));
const manifest = path.resolve('artifacts/erp-experience-20261102/direct-handover/source.json');
fs.writeFileSync(manifest, JSON.stringify(files, null, 2));
config.source = { file: manifest, sha256: sha(fs.readFileSync(manifest)) };
config.guardSha256 = sha(fs.readFileSync(guardPath));
fs.writeFileSync(path.join(dir, 'private-direct-handover-config.json'), JSON.stringify(config, null, 2));
console.log(JSON.stringify({ sourceFiles: Object.keys(files).length, sourceSha256: config.source.sha256, migrations: config.migrations.count, added: 3, guardSha256: config.guardSha256 }));
