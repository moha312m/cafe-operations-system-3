import assert from 'node:assert/strict';
import { readFileSync, readdirSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
export const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const ROOT = 'C:/Users/Acer/.codex/worktrees/nextcup-workspace-redesign/cafe-operations-system-3';
const slash = s => s.replaceAll('\\', '/');
const MARKER = 'Disposable. Automated tests create and delete data here. Never point this at real cafe data.';
export function sourceFiles() {
  const files = [];
  function walk(folder) { for (const e of readdirSync(path.join(ROOT, folder), { withFileTypes: true })) { const file = folder + '/' + e.name; if (e.isDirectory()) walk(file); else if (e.isFile()) files.push(file); } }
  for (const folder of ['src', 'tests', 'scripts', 'prisma', 'public']) walk(folder);
  for (const e of readdirSync(ROOT, { withFileTypes: true })) if (e.isFile() && /\.(?:ts|tsx|mts|mjs|json)$/.test(e.name) && e.name !== 'next-env.d.ts') files.push(e.name);
  return files.sort();
}
export function loadWorkspace() {
  assert.ok(process.env.NEXTCUP_WORKSPACE_CONFIG, 'Explicit workspace configuration required; no environment-file fallback');
  const file = path.resolve(process.env.NEXTCUP_WORKSPACE_CONFIG);
  assert.equal(slash(path.dirname(file)), ROOT + '/artifacts/workspace-redesign-20261102');
  const config = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  assert.equal(config.version, 1); assert.equal(config.root, ROOT);
  assert.equal(slash(realpathSync(process.cwd())), ROOT);
  assert.deepEqual(readdirSync(ROOT).filter(n => /^\.env(?:\.|$)/i.test(n) && n !== '.env.example'), [], 'No environment files permitted in isolated preview');
  assert.match(config.runId, /^workspace20261102-[a-f0-9]{12}$/);
  assert.equal(config.baseUrl, 'http://localhost:3113');
  assert.equal(config.database.host, '127.0.0.1'); assert.equal(config.database.port, 5434);
  assert.equal(config.database.name, 'cafe_ops_test_integr20261101_replay_66515e42c85e8ec4');
  assert.equal(String(config.database.oid), '65538');
  assert.equal(config.database.systemIdentifier, '7693368256609479860');
  assert.equal(config.database.dataDirectory, 'C:/Dev/_nextcup_test_postgres/pgdata');
  assert.equal(config.database.marker, MARKER);
  const expectedUrl = 'postgresql://postgres@127.0.0.1:5434/' + config.database.name + '?schema=public';
  assert.equal(config.databaseUrl, expectedUrl);
  assert.equal(process.env.DATABASE_URL, expectedUrl, 'Process datasource must equal explicit owned disposable target');
  assert.equal(config.allowRetainedSyntheticWrites, true);
  assert.equal(sha(readFileSync(new URL(import.meta.url))), config.guardSha256, 'Guard code changed after review');
  return config;
}
export async function verifyWorkspace({ requireCorrespondence = false } = {}) {
  const config = loadWorkspace();
  assert.equal(sha(readFileSync(config.source.file)), config.source.sha256, 'Source manifest digest mismatch');
  const files = JSON.parse(readFileSync(config.source.file, 'utf8'));
  assert.deepEqual(sourceFiles(), Object.keys(files).sort(), 'Exact native source inventory required');
  for (const [file, hash] of Object.entries(files)) {
    const full = path.resolve(config.root, file);
    assert.ok(slash(full).startsWith(ROOT + '/'), 'Source path escapes owned workspace');
    assert.equal(sha(readFileSync(full)), hash, 'Source changed after review: ' + file);
  }
  const names = readdirSync(path.join(ROOT, 'prisma/migrations'), { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort();
  assert.deepEqual(names, config.migrations.rows.map(m => m.name).sort(), 'Exact migration directory inventory required');
  assert.equal(config.migrations.rows.length, 91);
  assert.equal(sha(Buffer.from(JSON.stringify(config.migrations.rows))), config.migrations.sha256);
  const db = new PrismaClient({ datasourceUrl: config.databaseUrl });
  try {
    const proof = await db.$transaction(async tx => {
      await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
      const [id] = await tx.$queryRawUnsafe("SELECT current_database() AS name, host(inet_server_addr()) AS host, current_setting('port') AS port, current_setting('data_directory') AS directory, system_identifier::text AS system_identifier, (SELECT oid::text FROM pg_database WHERE datname=current_database()) AS oid FROM pg_control_system()");
      assert.equal(id.name, config.database.name); assert.equal(id.host, '127.0.0.1'); assert.equal(id.port, '5434');
      assert.equal(slash(id.directory), config.database.dataDirectory); assert.equal(id.system_identifier, config.database.systemIdentifier); assert.equal(id.oid, '65538');
      assert.deepEqual(await tx.$queryRawUnsafe('SELECT id,note FROM "_disposable_test_database" ORDER BY id'), [{ id: 1, note: MARKER }]);
      const rows = await tx.$queryRawUnsafe('SELECT migration_name AS name,checksum,finished_at IS NOT NULL AS finished,rolled_back_at IS NOT NULL AS rolled_back FROM "_prisma_migrations" ORDER BY migration_name');
      assert.ok(rows.every(r => r.finished && !r.rolled_back), 'Unresolved migration row');
      assert.deepEqual(rows.map(({name,checksum}) => ({name,checksum})), config.migrations.rows);
      if (process.env.NEXTCUP_WORKSPACE_FIXTURES) {
        const fx = JSON.parse(readFileSync(process.env.NEXTCUP_WORKSPACE_FIXTURES, 'utf8'));
        assert.equal(fx.runId, config.runId, 'Fixture ownership mismatch');
        for (const cafeId of [fx.cafeId, fx.otherCafeId, fx.configuredAccounting?.cafeId].filter(Boolean)) {
          const cafe = await tx.cafe.findUniqueOrThrow({ where: { id: cafeId }, select: { name: true } });
          assert.ok(cafe.name.startsWith(config.runId), 'Refuse fixtures outside this run');
        }
        const branch = await tx.branch.findUniqueOrThrow({ where: { id: fx.branchId }, select: { cafeId: true } });
        assert.equal(branch.cafeId, fx.cafeId); config.fixtures = fx;
      }
      return { at: new Date().toISOString(), ...id, markerVerified: true, completedMigrations: rows.length, sourceFiles: Object.keys(files).length, sourceSha256: config.source.sha256 };
    });
    if (requireCorrespondence) {
      const p = config.correspondence; assert.ok(p?.nonce && p.verifiedAt, 'Real prior correspondence required');
      const cafe = await db.cafe.findUniqueOrThrow({ where: { id: p.cafeId }, select: { name: true, slug: true, branches: { where: { id: p.branchId }, select: { menuSlug: true } } } });
      assert.equal(cafe.name, p.nonce); assert.equal(cafe.branches.length, 1);
      const response = await fetch(config.baseUrl + '/menu/' + cafe.slug + '/' + cafe.branches[0].menuSlug, { cache: 'no-store', signal: AbortSignal.timeout(60000) });
      assert.equal(response.status, 200); assert.ok((await response.text()).includes(p.nonce), 'Preview does not serve this disposable database');
    }
    return { config, proof };
  } finally { await db.$disconnect(); }
}
