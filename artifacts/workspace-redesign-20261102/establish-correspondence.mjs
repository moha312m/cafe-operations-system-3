import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import path from 'node:path';
const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const file = path.join(here, 'private-config.json');
const config = JSON.parse(readFileSync(file, 'utf8'));
process.env.NEXTCUP_WORKSPACE_CONFIG = file; process.env.DATABASE_URL = config.databaseUrl;
const { verifyWorkspace } = await import('./workspace-guard.mjs');
await verifyWorkspace();
assert.ok(!existsSync(path.join(here, 'correspondence.json')), 'Preserve prior proof; do not duplicate probe');
const db = new PrismaClient({ datasourceUrl: config.databaseUrl });
try {
  const nonce = config.runId + '-PROBE-' + randomUUID(), slug = nonce.toLowerCase();
  appendFileSync(path.join(here, 'retained-fixtures.jsonl'), JSON.stringify({ at: new Date().toISOString(), kind: 'probe-planned', nonce, retained: true }) + '\n');
  const cafe = await db.cafe.create({ data: { name: nonce, slug, currency: 'EGP', branches: { create: { name: nonce, menuSlug: 'probe' } } }, include: { branches: true } });
  const proof = { nonce, cafeId: cafe.id, branchId: cafe.branches[0].id, retained: true };
  appendFileSync(path.join(here, 'retained-fixtures.jsonl'), JSON.stringify({ at: new Date().toISOString(), kind: 'probe-created', ...proof }) + '\n');
  const response = await fetch(config.baseUrl + '/menu/' + slug + '/probe', { cache: 'no-store', signal: AbortSignal.timeout(60000) });
  assert.equal(response.status, 200); assert.ok((await response.text()).includes(nonce));
  proof.verifiedAt = new Date().toISOString();
  writeFileSync(path.join(here, 'private-config-before-correspondence.json'), readFileSync(file), { flag: 'wx' });
  config.correspondence = proof; writeFileSync(file, JSON.stringify(config, null, 2));
  writeFileSync(path.join(here, 'correspondence.json'), JSON.stringify({ runId: config.runId, baseUrl: config.baseUrl, database: config.database.name, oid: config.database.oid, source: config.source, ...proof }, null, 2), { flag: 'wx' });
  await verifyWorkspace({ requireCorrespondence: true });
  console.log('Real disposable SQL/HTTP nonce correspondence passed on localhost:3113; probe retained.');
} finally { await db.$disconnect(); }
