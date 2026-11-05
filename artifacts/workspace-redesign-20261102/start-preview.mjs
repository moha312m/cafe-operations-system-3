import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, openSync, closeSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const configFile = path.join(here, 'private-config.json');
const config = JSON.parse(readFileSync(configFile, 'utf8'));
process.env.NEXTCUP_WORKSPACE_CONFIG = configFile; process.env.DATABASE_URL = config.databaseUrl;
const { verifyWorkspace } = await import('./workspace-guard.mjs');
const { proof } = await verifyWorkspace();
const probe = net.createServer();
await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(3113, '127.0.0.1', resolve); });
await new Promise(resolve => probe.close(resolve));
const id = 'preview-' + Date.now() + '-' + randomUUID().slice(0,8);
const stdout = path.join(here, id + '.stdout.log'), stderr = path.join(here, id + '.stderr.log');
const recordFile = path.join(here, id + '.json');
const args = [path.join(config.root, 'node_modules/next/dist/bin/next'), 'dev', '--webpack', '--hostname', '127.0.0.1', '--port', '3113'];
const record = { state: 'PLANNED', at: new Date().toISOString(), runId: config.runId, executable: process.execPath, args, cwd: config.root, stdout, stderr, baseUrl: config.baseUrl, database: proof.name, oid: proof.oid, sourceSha256: config.source.sha256 };
writeFileSync(recordFile, JSON.stringify(record, null, 2), { flag: 'wx' });
const out = openSync(stdout, 'wx'), err = openSync(stderr, 'wx');
try {
  const child = spawn(process.execPath, args, { cwd: config.root, detached: true, windowsHide: true, stdio: ['ignore', out, err], env: { ...process.env, DATABASE_URL: config.databaseUrl, AUTH_SECRET: config.authSecret, NODE_ENV: 'development', NEXTCUP_INTEGRATION_VERIFY: '1', NODE_OPTIONS: '--max-old-space-size=8192', NEXT_TELEMETRY_DISABLED: '1', NEXT_FONT_GOOGLE_MOCKED_RESPONSES: 'C:/Dev/cafe-operations-system-3/artifacts/integration-all-approved-20261101/continuation-20261101/cached-font-responses.cjs' } });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  assert.ok(child.pid); record.pid = child.pid; record.state = 'SPAWNED_UNVERIFIED'; record.spawnedAt = new Date().toISOString();
  writeFileSync(recordFile, JSON.stringify(record, null, 2)); child.unref();
  console.log(JSON.stringify({ pid: record.pid, state: record.state, recordFile, url: config.baseUrl }));
} finally { closeSync(out); closeSync(err); }
