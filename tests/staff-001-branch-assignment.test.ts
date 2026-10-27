// Staff assignment is authoritative even when a twelve-hour cookie predates an edit.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { db, teardownTaggedCafe } from "./helpers/db";
import { countCafe, COUNT_PASSWORD, type CountCafe } from "./helpers/count";
import { as, login, requireServer } from "./helpers/http";

let fx: CountCafe;
before(async () => { await requireServer(); fx = await countCafe("STAFF001"); });
after(async () => { if (fx) await teardownTaggedCafe(fx.cafeId, [], { disconnect: true }); });
const edit = (id: string, body: object) => as(fx.owner.email, "/api/users/" + id, { method: "PATCH", body: JSON.stringify(body) });
const open = (email: string, body: object = {}) => as<{ shift: { id: string; branchId: string } }>(email, "/api/shifts", { method: "POST", body: JSON.stringify(body) });

// Removing the create guard would mint staff who can choose any branch.
test("creating staff requires the owner's explicit branch assignment", async () => {
 const email = fx.marker.toLowerCase() + "-new@example.invalid";
 const input = { name: "Assigned cashier", email, password: COUNT_PASSWORD, role: "CASHIER" };
 const missing = await as(fx.owner.email, "/api/users", { method: "POST", body: JSON.stringify(input) });
 assert.equal(missing.status, 400, missing.text);
 assert.equal(await db.user.count({where:{email}}), 0);
 const created = await as<{user:{branchId:string}}>(fx.owner.email, "/api/users", {method:"POST",body:JSON.stringify({...input,branchId:fx.otherBranchId})});
 assert.equal(created.status, 201, created.text);
 assert.equal(created.body.user.branchId, fx.otherBranchId);
});

test("editing cannot remove a staff member's branch", async () => {
 try {
  const r = await edit(fx.cashier.id, {branchId:null});
  assert.equal(r.status, 400, r.text);
  assert.equal((await db.user.findUniqueOrThrow({where:{id:fx.cashier.id}})).branchId, fx.branchId);
 } finally { await db.user.update({where:{id:fx.cashier.id},data:{branchId:fx.branchId}}); }
});

test("changing an unassigned owner account into staff requires a branch", async () => {
 const other = await db.user.create({data:{cafeId:fx.cafeId,email:fx.marker.toLowerCase()+"-other-owner@example.invalid",name:"Other owner",role:"CAFE_OWNER",passwordHash:"no-login-path"}});
 // Own profile role changes are disallowed; the owner role cannot manage peers.
 // Use the existing fixture owner as a platform-managed target through a real platform session.
 const platform = await db.user.create({data:{email:fx.marker.toLowerCase()+"-platform@example.invalid",name:"Platform",role:"SUPER_ADMIN",passwordHash:(await db.user.findUniqueOrThrow({where:{id:fx.owner.id}})).passwordHash}});
 try {
  await login(platform.email, COUNT_PASSWORD);
  const r = await as(platform.email, "/api/users/"+other.id, {method:"PATCH",body:JSON.stringify({role:"CASHIER"})});
  assert.equal(r.status, 400, r.text);
  assert.equal((await db.user.findUniqueOrThrow({where:{id:other.id}})).role,"CAFE_OWNER");
 } finally { await db.auditLog.deleteMany({where:{userId:platform.id}}); await db.user.delete({where:{id:platform.id}}); }
});

// A cookie-only branch resolver continues accepting the old branch after transfer.
test("a transfer updates auth/me on the same login session", async () => {
 try {
  const moved = await edit(fx.cashier.id,{branchId:fx.otherBranchId});
  assert.equal(moved.status,200,moved.text);
  const me = await as<{user:{branchId:string}}>(fx.cashier.email,"/api/auth/me");
  assert.equal(me.status,200,me.text);
  assert.equal(me.body.user.branchId,fx.otherBranchId);
 } finally { await db.user.update({where:{id:fx.cashier.id},data:{branchId:fx.branchId}}); }
});

test("a transferred employee cannot open a shift in the previous branch", async () => {
 try {
  assert.equal((await edit(fx.cashier.id,{branchId:fx.otherBranchId})).status,200);
  const r = await open(fx.cashier.email,{branchId:fx.branchId});
  assert.equal(r.status,403,r.text);
  assert.equal(await db.shift.count({where:{cashierId:fx.cashier.id,branchId:fx.branchId}}),0);
 } finally { await db.user.update({where:{id:fx.cashier.id},data:{branchId:fx.branchId}}); }
});

test("opening without a branch uses the latest assignment, not the cookie", async () => {
 try {
  assert.equal((await edit(fx.cashier.id,{branchId:fx.otherBranchId})).status,200);
  const r = await open(fx.cashier.email);
  assert.equal(r.status,201,r.text);
  assert.equal(r.body.shift.branchId,fx.otherBranchId);
  const stored = await db.shift.findUniqueOrThrow({where:{id:r.body.shift.id}});
  assert.equal(stored.branchId,fx.otherBranchId);
 } finally { await db.user.update({where:{id:fx.cashier.id},data:{branchId:fx.branchId}}); }
});

test("forged cross-branch shift requests are rejected", async () => {
 const r = await open(fx.manager.email,{branchId:fx.otherBranchId});
 assert.equal(r.status,403,r.text);
 assert.equal(await db.shift.count({where:{cashierId:fx.manager.id}}),0);
});

test("legacy staff without an assignment cannot choose a branch to open a shift", async () => {
 await db.user.update({where:{id:fx.manager.id},data:{branchId:null}});
 try {
  await login(fx.manager.email,COUNT_PASSWORD);
  const r = await open(fx.manager.email,{branchId:fx.branchId});
  assert.equal(r.status,403,r.text);
  assert.equal(await db.shift.count({where:{cashierId:fx.manager.id}}),0);
 } finally { await db.user.update({where:{id:fx.manager.id},data:{branchId:fx.branchId}}); await login(fx.manager.email,COUNT_PASSWORD); }
});

test("the owner retains branch choice", async () => {
 for (const branchId of [fx.branchId,fx.otherBranchId]) {
  const r = await open(fx.owner.email,{branchId});
  assert.equal(r.status,201,r.text);
  assert.equal(r.body.shift.branchId,branchId);
 }
});

test("a branch manager cannot transfer staff to a different branch", async () => {
 const r = await as(fx.manager.email,"/api/users/"+fx.cashier.id,{method:"PATCH",body:JSON.stringify({branchId:fx.otherBranchId})});
 assert.equal(r.status,403,r.text);
 assert.equal((await db.user.findUniqueOrThrow({where:{id:fx.cashier.id}})).branchId,fx.branchId);
});

// The current-shift page must not spin forever or choose a fallback branch for unassigned staff.
test("unassigned staff see an assignment warning on the current-shift page", async () => {
 await db.user.update({where:{id:fx.manager.id},data:{branchId:null}});
 try {
  const r = await as(fx.manager.email,"/current-shift");
  assert.equal(r.status,200,r.text.slice(0,200));
  assert.ok(r.text.includes("حسابك غير معيّن على فرع"),"expected an assignment warning rather than branch fallback controls");
 } finally { await db.user.update({where:{id:fx.manager.id},data:{branchId:fx.branchId}}); }
});
