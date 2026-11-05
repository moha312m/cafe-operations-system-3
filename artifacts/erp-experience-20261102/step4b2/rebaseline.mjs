// Step 4B.2 preview evidence. The reviewed guard (workspace-guard.mjs) pins exactly 91 migrations; this
// closeout adds two reviewed migrations, so a COPY of the guard is made whose only change is that count
// (91 -> 93). Every other check is byte-identical. The reviewed guard and all earlier configs stay untouched.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';

const dir = path.resolve('artifacts/workspace-redesign-20261102');
const original = fs.readFileSync(path.join(dir, 'workspace-guard.mjs'), 'utf8');
assert.equal(original.split("assert.equal(config.migrations.rows.length, 91);").length - 1, 1, 'expected exactly one pinned count');
const copy = original.replace("assert.equal(config.migrations.rows.length, 91);", "assert.equal(config.migrations.rows.length, 93);");
fs.writeFileSync(path.join(dir, 'workspace-guard-4b2.mjs'), copy);
const { sourceFiles, sha } = await import('../../workspace-redesign-20261102/workspace-guard-4b2.mjs');

const config = JSON.parse(fs.readFileSync(path.join(dir, 'private-step4b1-config.json'), 'utf8'));
const db = new PrismaClient({ datasourceUrl: config.databaseUrl });
try {
  const rows = await db.$transaction(async tx => {
    await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
    const [id] = await tx.$queryRawUnsafe("SELECT current_database() AS name, (SELECT oid::text FROM pg_database WHERE datname=current_database()) AS oid");
    assert.equal(id.name, config.database.name); assert.equal(id.oid, '65538');
    return (await tx.$queryRawUnsafe('SELECT migration_name AS name,checksum,finished_at IS NOT NULL AS finished,rolled_back_at IS NOT NULL AS rolled_back FROM "_prisma_migrations" ORDER BY migration_name'));
  });
  assert.ok(rows.every(r => r.finished && !r.rolled_back));
  const migrations = rows.map(({ name, checksum }) => ({ name, checksum }));
  const names = fs.readdirSync('prisma/migrations', { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort();
  assert.deepEqual(names, migrations.map(m => m.name).sort(), 'DB and repository migration inventories must match');
  assert.equal(migrations.length, 93);
  const old = new Set(config.migrations.rows.map(r => r.name + r.checksum));
  const added = migrations.filter(m => !old.has(m.name + m.checksum)).map(m => m.name);
  assert.deepEqual(added, ['20261104120000_expense_category_account_mapping', '20261105090000_mapping_guard_hardening'], 'only the two reviewed migrations are new; the 91 earlier rows are unchanged');
  config.migrations = { count: migrations.length, rows: migrations, sha256: sha(Buffer.from(JSON.stringify(migrations))) };
} finally { await db.$disconnect(); }

const files = Object.fromEntries(sourceFiles().map(p => [p, sha(fs.readFileSync(p))]));
const manifest = path.resolve('artifacts/erp-experience-20261102/step4b2/source.json');
fs.writeFileSync(manifest, JSON.stringify(files, null, 2));
config.source = { file: manifest, sha256: sha(fs.readFileSync(manifest)) };
config.guardSha256 = sha(fs.readFileSync(path.join(dir, 'workspace-guard-4b2.mjs')));
fs.writeFileSync(path.join(dir, 'private-step4b2-config.json'), JSON.stringify(config, null, 2));
console.log(JSON.stringify({ sourceFiles: Object.keys(files).length, sourceSha256: config.source.sha256, migrations: config.migrations.count, added: 2, guardSha256: config.guardSha256 }));
