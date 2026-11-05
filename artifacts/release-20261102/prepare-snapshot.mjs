import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, symlinkSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const root = process.cwd();
assert.equal(root.toLowerCase().replaceAll('\\', '/'), 'c:/users/acer/.codex/worktrees/nextcup-workspace-redesign/cafe-operations-system-3');
const out = path.join(root, 'artifacts/release-20261102');
const changes = JSON.parse(readFileSync(path.join(root, 'artifacts/workspace-redesign-20261102/final-changed-files.json'), 'utf8').replace(/^\uFEFF/, ''));
assert.equal(changes.length, 43);
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const tracked = git('ls-files', '-z').split('\0').filter(Boolean);
assert.equal(git('diff', '--cached', '--name-only'), '');
const extras = ['docs/superpowers/plans/2026-11-02-railway-release.md'];
const files = [...new Set([...tracked, ...changes, ...extras])].sort();
for (const file of files) {
  assert.ok(!path.isAbsolute(file) && !file.split('/').includes('..'));
  assert.ok(!/^(artifacts|\.next|node_modules)\//.test(file));
  assert.ok(!/(^|\/)(private[^/]*|\.env(?!\.example$))/.test(file));
}
const candidate = path.join(os.tmpdir(), 'nextcup-release-' + randomUUID().slice(0, 12));
assert.ok(!existsSync(candidate)); mkdirSync(candidate);
const pins = {};
for (const file of files) {
  const source = path.join(root, file), destination = path.join(candidate, file);
  mkdirSync(path.dirname(destination), { recursive: true }); copyFileSync(source, destination);
  pins[file] = createHash('sha256').update(readFileSync(source)).digest('hex');
}
symlinkSync(path.join(root, 'node_modules'), path.join(candidate, 'node_modules'), 'junction');
const receipt = { at: new Date().toISOString(), root, candidate, base: git('rev-parse', 'HEAD'), files: pins, changedPaths: changes, extraPaths: extras, excludesRuntimeArtifacts: true, hasEnvFile: existsSync(path.join(candidate, '.env')), dependencies: 'existing node_modules junction; no install or client regeneration' };
assert.equal(receipt.hasEnvFile, false);
writeFileSync(path.join(out, 'snapshot.json'), JSON.stringify(receipt, null, 2), { flag: 'wx' });
console.log(JSON.stringify({ candidate, files: files.length, changedCodePaths: changes.length, hasEnvFile: false }));
