import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';
import path from 'node:path';
const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const file = path.join(here, 'private-config.json'), config = JSON.parse(readFileSync(file, 'utf8'));
process.env.NEXTCUP_WORKSPACE_CONFIG = file; process.env.DATABASE_URL = config.databaseUrl; process.env.AUTH_SECRET = config.authSecret;
process.env.NEXTCUP_WORKSPACE_FIXTURES = path.join(here, 'private-fixtures.json');
const { verifyWorkspace } = await import('./workspace-guard.mjs');
const { config: verified } = await verifyWorkspace({ requireCorrespondence: true });
const fx = { ...verified.fixtures, branchPinnedCookie: verified.fixtures.reportBranchPinnedCookie };
const db = new PrismaClient({ datasourceUrl: config.databaseUrl });
const journal = data => appendFileSync(path.join(here, 'reversible-hooks.jsonl'), JSON.stringify({ at: new Date().toISOString(), runId: config.runId, ...data }) + '\n');
const permittedCafes = [fx.cafeId, fx.configuredAccounting.cafeId];
async function ownedUser(actor) { const u = await db.user.findUniqueOrThrow({ where: { id: actor.userId } }); assert.ok(permittedCafes.includes(u.cafeId)); const c = await db.cafe.findUniqueOrThrow({ where:{id:u.cafeId},select:{name:true} }); assert.ok(c.name.startsWith(config.runId)); return u; }
async function withDeniedPermission(actor, key, action) {
  await ownedUser(actor);
  const before = await db.userPermissionOverride.findUnique({ where: { userId_permissionKey: { userId: actor.userId, permissionKey: key } } });
  journal({ kind: 'permission-hook-planned', userId: actor.userId, key, previous: before, retainedBusinessRows: true });
  const row = await db.userPermissionOverride.upsert({ where: { userId_permissionKey: { userId: actor.userId, permissionKey: key } }, create: { userId: actor.userId, permissionKey: key, allowed: false }, update: { allowed: false } });
  try { await action(); } finally {
    if (before) await db.userPermissionOverride.update({ where: { id: before.id }, data: { allowed: before.allowed, updatedAt: before.updatedAt } });
    else await db.userPermissionOverride.delete({ where: { id: row.id } });
    const after = await db.userPermissionOverride.findUnique({ where: { userId_permissionKey: { userId: actor.userId, permissionKey: key } } }); assert.deepEqual(after, before);
    journal({ kind: 'permission-hook-restored', userId: actor.userId, key, exactStateRestored: true });
  }
}
async function withBranchAssignment(actor, branchId, action) {
  const before = await ownedUser(actor), branch = await db.branch.findUniqueOrThrow({ where: { id: branchId } }); assert.equal(branch.cafeId, before.cafeId);
  journal({ kind: 'assignment-hook-planned', userId: before.id, before: before.branchId, branchId });
  await db.user.update({ where: { id: before.id }, data: { branchId } });
  try { await action(); } finally {
    await db.user.update({ where: { id: before.id }, data: { branchId: before.branchId, updatedAt: before.updatedAt } });
    assert.equal((await db.user.findUniqueOrThrow({ where: { id: before.id } })).branchId, before.branchId);
    journal({ kind: 'assignment-hook-restored', userId: before.id, exactBranchRestored: true });
  }
}
async function request(route, options) {
  const r = await fetch(config.baseUrl + route, { method: options.method ?? 'GET', headers: { ...(options.cookie ? {Cookie:options.cookie} : {}), ...(options.body === undefined ? {} : {'Content-Type':'application/json'}) }, ...(options.body === undefined ? {} : {body:JSON.stringify(options.body)}), redirect:'manual', signal:AbortSignal.timeout(60000) });
  const text = await r.text(); let body; try {body=JSON.parse(text);}catch{body={nonJson:true};} return {status:r.status,body};
}
try {
  const {run} = await import('../../scripts/workspace-reports-runtime.ts');
  const result = await run({ db, baseUrl:config.baseUrl, fx, request, withDeniedPermission, withBranchAssignment });
  const out=path.join(here,'reports-runtime-'+Date.now()+'.json');writeFileSync(out,JSON.stringify({...result,runId:config.runId,sourceSha256:config.source.sha256},null,2),{flag:'wx'});
  console.log(JSON.stringify({status:result.status,totals:result.totals,out,cases:result.cases}));
  if(result.status!=='PASS')process.exitCode=1;
}finally{await db.$disconnect();const singleton=await import('../../src/lib/db.ts');await singleton.db.$disconnect();}
