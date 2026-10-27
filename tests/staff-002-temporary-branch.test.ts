// Real HTTP and owned tenant fixtures: ignoring temporary PATCH fields must fail these contracts.
import { after, afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { db, teardownTaggedCafe } from "./helpers/db";
import { countCafe, type CountCafe } from "./helpers/count";
import { as, requireServer } from "./helpers/http";

let fx: CountCafe | null = null;
function fixture(): CountCafe { assert.ok(fx, "owned fixture setup must complete"); return fx; }
beforeEach(async () => { fx = null; await requireServer(); fx = await countCafe("STAFF002"); });
afterEach(async () => { const owned = fx; fx = null; if (owned) await teardownTaggedCafe(owned.cafeId); });
after(async () => { await db.$disconnect(); });
type Identity = { branchId: string; homeBranchId: string; temporaryBranchStatus: string | null };
const me = async () => {
 const result = await as<{ user: Identity }>(fixture().cashier.email, "/api/auth/me");
 assert.equal(result.status, 200, result.text);
 return result;
};
const edit = (body: object, email = fixture().owner.email, id = fixture().cashier.id) => as(email, "/api/users/" + id, { method: "PATCH", body: JSON.stringify(body) });
const assign = () => edit({ temporaryBranchId: fixture().otherBranchId, temporaryBranchUntil: new Date(Date.now() + 3600000).toISOString() });
async function drawer(branchId: string) {
 return db.shift.create({ data: { cafeId: fixture().cafeId, branchId, cashierId: fixture().cashier.id, shiftNumber: 1 } });
}
async function custody(branchId: string, responsibleShiftId?: string) {
 return db.custodyPeriod.create({ data: { cafeId: fixture().cafeId, branchId, scope: "STOCK", holderType: "USER", responsibleShiftId,
  ...(responsibleShiftId ? {} : { participants: { create: { userId: fixture().cashier.id, role: "PRIMARY" } } }) } });
}
// Prisma writes naive UTC timestamps; raw timestamptz casts use the database's
// Africa/Cairo timezone and would move this expiry three hours into the future.
async function expire() {
 const until = new Date(Date.now() - 60000);
 const user = await db.user.update({ where: { id: fixture().cashier.id }, data: { temporaryBranchUntil: until } });
 assert.equal(user.temporaryBranchUntil?.getTime(), until.getTime(), "expiry fixture must store the intended instant");
}

test("owner temporary assignment changes the same cookie's next request while home remains permanent", async () => {
 assert.equal((await me()).body.user.branchId, fixture().branchId);
 const set = await assign(); assert.equal(set.status, 200, set.text);
 const identity = await me(); assert.equal(identity.status, 200, identity.text);
 assert.equal(identity.body.user.branchId, fixture().otherBranchId);
 assert.equal(identity.body.user.homeBranchId, fixture().branchId);
 assert.equal(identity.body.user.temporaryBranchStatus, "ACTIVE");
 assert.equal((await db.user.findUniqueOrThrow({ where: { id: fixture().cashier.id } })).branchId, fixture().branchId);
 const forged = await as(fixture().cashier.email, "/api/shifts", { method: "POST", body: JSON.stringify({ branchId: fixture().branchId }) });
 assert.equal(forged.status, 403, forged.text);
 const page = await as(fixture().cashier.email, "/current-shift");
 assert.equal(page.status, 200, page.text.slice(0,200));
 assert.ok(page.text.includes(fixture().marker + " annex"), "SSR must use the same effective branch as auth/me");
 assert.equal(await db.auditLog.count({ where: { cafeId: fixture().cafeId, entityId: fixture().cashier.id, action: "STAFF_TEMPORARY_BRANCH_SET" } }), 1);
});

test("existing open drawer defers the move until responsibility is settled", async () => {
 const shift = await drawer(fixture().branchId);
 assert.equal((await assign()).status, 200);
 let identity = await me(); assert.equal(identity.body.user.temporaryBranchStatus, "PENDING");
 assert.equal(identity.body.user.branchId, fixture().branchId);
 await db.shift.update({ where: { id: shift.id }, data: { status: "CLOSED", closedAt: new Date() } });
 identity = await me(); assert.equal(identity.body.user.branchId, fixture().otherBranchId);
 assert.equal(identity.body.user.temporaryBranchStatus, "ACTIVE");
});

test("open user custody defers the move even without an open drawer", async () => {
 const held = await custody(fixture().branchId);
 assert.equal((await assign()).status, 200);
 assert.equal((await me()).body.user.temporaryBranchStatus, "PENDING");
 assert.equal((await me()).body.user.branchId, fixture().branchId);
 await db.custodyPeriod.update({ where: { id: held.id }, data: { status: "CLOSED", endedAt: new Date() } });
 assert.equal((await me()).body.user.branchId, fixture().otherBranchId);
});

test("expiry returns home on the same cookie after a temporary drawer closes", async () => {
 assert.equal((await assign()).status, 200);
 assert.equal((await me()).body.user.branchId, fixture().otherBranchId);
 const shift = await drawer(fixture().otherBranchId); await expire();
 let identity = await me(); assert.equal(identity.body.user.branchId, fixture().otherBranchId);
 assert.equal(identity.body.user.temporaryBranchStatus, "EXPIRED_FINISHING");
 await db.shift.update({ where: { id: shift.id }, data: { status: "CLOSED", closedAt: new Date() } });
 identity = await me(); assert.equal(identity.body.user.branchId, fixture().branchId);
 assert.equal(identity.body.user.temporaryBranchStatus, null);
});

test("expired assignment stays in the temporary branch while a closed drawer owns open user custody", async () => {
 assert.equal((await assign()).status, 200);
 assert.equal((await me()).body.user.branchId, fixture().otherBranchId);
 const shift = await drawer(fixture().otherBranchId);
 const held = await custody(fixture().otherBranchId, shift.id);
 await db.shift.update({ where: { id: shift.id }, data: { status: "CLOSED", closedAt: new Date() } });
 await expire();
 assert.equal((await me()).body.user.temporaryBranchStatus, "EXPIRED_FINISHING");
 assert.equal((await me()).body.user.branchId, fixture().otherBranchId);
 await db.custodyPeriod.update({ where: { id: held.id }, data: { status: "CLOSED", endedAt: new Date() } });
 assert.equal((await me()).body.user.branchId, fixture().branchId);
});

test("cancel retains the temporary branch until open custody is settled", async () => {
 assert.equal((await assign()).status, 200);
 assert.equal((await me()).body.user.branchId, fixture().otherBranchId);
 const held = await custody(fixture().otherBranchId);
 const cancelled = await edit({ temporaryBranchId: null }); assert.equal(cancelled.status, 200, cancelled.text);
 assert.equal((await me()).body.user.branchId, fixture().otherBranchId);
 assert.equal((await me()).body.user.temporaryBranchStatus, "CANCELLED_FINISHING");
 await db.custodyPeriod.update({ where: { id: held.id }, data: { status: "TRANSFERRED", endedAt: new Date() } });
 assert.equal((await me()).body.user.branchId, fixture().branchId);
 assert.equal(await db.auditLog.count({ where: { cafeId: fixture().cafeId, entityId: fixture().cashier.id, action: "STAFF_TEMPORARY_BRANCH_CANCELLED" } }), 1);
});

test("branch manager cannot set or cancel a temporary assignment", async () => {
 const denied = await edit({ temporaryBranchId: fixture().otherBranchId, temporaryBranchUntil: new Date(Date.now()+3600000).toISOString() }, fixture().manager.email);
 assert.equal(denied.status, 403, denied.text);
 assert.equal((await me()).body.user.branchId, fixture().branchId);
 assert.equal((await assign()).status, 200);
 const cancel = await edit({ temporaryBranchId: null }, fixture().manager.email); assert.equal(cancel.status, 403, cancel.text);
 assert.equal((await me()).body.user.branchId, fixture().otherBranchId);
});

test("temporary branch must be active and expiry must be in the future", async () => {
 const expired = await edit({ temporaryBranchId: fixture().otherBranchId, temporaryBranchUntil: new Date(Date.now()-1000).toISOString() });
 assert.equal(expired.status, 400, expired.text);
 await db.branch.update({ where: { id: fixture().otherBranchId }, data: { isActive: false } });
 const inactive = await assign(); assert.equal(inactive.status, 400, inactive.text);
 assert.equal((await me()).body.user.branchId, fixture().branchId);
});

test("owner cannot temporarily assign a peer owner or staff without a home branch", async () => {
 const owner = await edit({ temporaryBranchId: fixture().otherBranchId, temporaryBranchUntil: new Date(Date.now()+3600000).toISOString() }, fixture().owner.email, fixture().owner.id);
 assert.equal(owner.status, 400, owner.text);
 await db.user.update({ where: { id: fixture().cashier.id }, data: { branchId: null } });
 const unassigned = await assign(); assert.equal(unassigned.status, 400, unassigned.text);
});

// Missing tenant validation would let an owner move staff into somebody else's cafe.
test("foreign-cafe temporary branches are refused", async () => {
 const foreign = await countCafe("STAFF002FOREIGN");
 try {
  const result = await edit({ temporaryBranchId: foreign.branchId, temporaryBranchUntil: new Date(Date.now()+3600000).toISOString() });
  assert.equal(result.status, 400, result.text);
  assert.equal((await me()).body.user.branchId, fixture().branchId);
  assert.equal(await db.auditLog.count({ where: { cafeId: fixture().cafeId, entityId: fixture().cashier.id, action: "STAFF_TEMPORARY_BRANCH_SET" } }), 0);
 } finally { await teardownTaggedCafe(foreign.cafeId); }
});

// Treating historical participants as current responsibility would strand settled staff.
test("a participant who already left custody does not defer a temporary assignment", async () => {
 const held = await custody(fixture().branchId);
 await db.custodyParticipant.updateMany({ where: { custodyPeriodId: held.id, userId: fixture().cashier.id }, data: { leftAt: new Date() } });
 assert.equal((await assign()).status, 200);
 const identity = await me(); assert.equal(identity.body.user.branchId, fixture().otherBranchId);
 assert.equal(identity.body.user.temporaryBranchStatus, "ACTIVE");
});

test("an expired pending assignment never starts after the home drawer closes", async () => {
 const shift = await drawer(fixture().branchId);
 assert.equal((await assign()).status, 200);
 assert.equal((await me()).body.user.temporaryBranchStatus, "PENDING");
 await expire();
 assert.equal((await me()).body.user.branchId, fixture().branchId);
 await db.shift.update({ where: { id: shift.id }, data: { status: "CLOSED", closedAt: new Date() } });
 const identity = await me(); assert.equal(identity.body.user.branchId, fixture().branchId);
 assert.equal(identity.body.user.temporaryBranchStatus, null);
});

test("cancelling a pending move leaves the home drawer accessible", async () => {
 const shift = await drawer(fixture().branchId);
 assert.equal((await assign()).status, 200);
 assert.equal((await me()).body.user.temporaryBranchStatus, "PENDING");
 assert.equal((await edit({ temporaryBranchId: null })).status, 200);
 const identity = await me(); assert.equal(identity.body.user.branchId, fixture().branchId);
 assert.equal(identity.body.user.temporaryBranchStatus, null);
 assert.equal((await db.shift.findUniqueOrThrow({ where: { id: shift.id } })).status, "OPEN");
});

// Opening the staff overview must not perform a pending movement as a side effect.
test("the owner overview shows pending assignment without mutating its transition metadata", async () => {
 const shift = await drawer(fixture().branchId);
 assert.equal((await assign()).status, 200);
 const before = await db.$queryRaw<Array<{ temporaryBranchStartedAt: Date | null; updatedAt: Date }>>`SELECT "temporaryBranchStartedAt", "updatedAt" FROM "User" WHERE "id" = ${fixture().cashier.id}`;
 const list = await as<{ users: Array<{ id: string; branchId: string; effectiveBranchId: string; temporaryBranchStatus: string }> }>(fixture().owner.email, "/api/users");
 assert.equal(list.status, 200, list.text);
 const row = list.body.users.find((u) => u.id === fixture().cashier.id)!;
 assert.equal(row.branchId, fixture().branchId); assert.equal(row.effectiveBranchId, fixture().branchId);
 assert.equal(row.temporaryBranchStatus, "PENDING");
 const after = await db.$queryRaw<Array<{ temporaryBranchStartedAt: Date | null; updatedAt: Date }>>`SELECT "temporaryBranchStartedAt", "updatedAt" FROM "User" WHERE "id" = ${fixture().cashier.id}`;
 assert.deepEqual(after, before);
 await db.shift.update({ where: { id: shift.id }, data: { status: "CLOSED", closedAt: new Date() } });
 const ready = await as<{ users: Array<{ id: string; temporaryBranchStatus: string }> }>(fixture().owner.email, "/api/users");
 assert.equal(ready.body.users.find((u) => u.id === fixture().cashier.id)!.temporaryBranchStatus, "ACTIVE");
 const readOnly = await db.$queryRaw<Array<{ temporaryBranchStartedAt: Date | null; updatedAt: Date }>>`SELECT "temporaryBranchStartedAt", "updatedAt" FROM "User" WHERE "id" = ${fixture().cashier.id}`;
 assert.deepEqual(readOnly, before);
});

test("the permanent home cannot be removed while temporary responsibilities remain", async () => {
 assert.equal((await assign()).status, 200);
 assert.equal((await me()).body.user.branchId, fixture().otherBranchId);
 await custody(fixture().otherBranchId);
 const result = await edit({ branchId: fixture().otherBranchId }); assert.equal(result.status, 409, result.text);
 assert.equal((await db.user.findUniqueOrThrow({ where: { id: fixture().cashier.id } })).branchId, fixture().branchId);
 assert.equal((await me()).body.user.branchId, fixture().otherBranchId);
});

// Extending the existing branch changes no custodian or branch and must not wait for settlement.
test("owner can extend a held active assignment in the same branch without resetting its start", async () => {
 assert.equal((await assign()).status, 200);
 assert.equal((await me()).body.user.branchId, fixture().otherBranchId);
 await custody(fixture().otherBranchId);
 const before = await db.user.findUniqueOrThrow({ where: { id: fixture().cashier.id } });
 const until = new Date(Date.now() + 7200000).toISOString();
 const result = await edit({ temporaryBranchId: fixture().otherBranchId, temporaryBranchUntil: until });
 assert.equal(result.status, 200, result.text);
 const after = await db.user.findUniqueOrThrow({ where: { id: fixture().cashier.id } });
 assert.equal(after.temporaryBranchStartedAt?.getTime(), before.temporaryBranchStartedAt?.getTime());
 assert.equal(after.temporaryBranchUntil?.toISOString(), until);
 assert.equal((await me()).body.user.branchId, fixture().otherBranchId);
 const events = await db.auditLog.findMany({ where: { cafeId: fixture().cafeId, entityId: fixture().cashier.id, action: "STAFF_TEMPORARY_BRANCH_SET" }, orderBy: { createdAt: "asc" } });
 assert.equal(events.length, 2); assert.equal(events[1].userId, fixture().owner.id);
 assert.equal((events[1].details as { until: string }).until, until);
});

// Test utility failure seam: the real login rejects a disabled owned account;
// a failed factory must erase only the cafe it just created and rethrow that login error.
test("countCafe cleans its own partially built tenant when actual login fails", async () => {
 let partial: CountCafe | null = null;
 const create = countCafe as (finding: string, options: { beforeLogin: (created: CountCafe) => Promise<void> }) => Promise<CountCafe>;
 try {
  await assert.rejects(create("STAFF002SETUPFAIL", { beforeLogin: async (created) => {
   partial = created;
   await db.user.update({ where: { id: created.manager.id }, data: { isActive: false } });
  } }).then((created) => { partial = created; return created; }), /login .* failed: 403/);
  assert.ok(partial, "factory must identify the exact owned tenant before login");
  const failed = partial as CountCafe;
  assert.equal(await db.cafe.count({ where: { id: failed.cafeId } }), 0);
  assert.equal(await db.user.count({ where: { cafeId: failed.cafeId } }), 0);
  assert.equal(await db.cafe.count({ where: { id: fixture().cafeId } }), 1, "unrelated owned fixture must survive failed factory cleanup");
 } finally {
  if (partial && await db.cafe.count({ where: { id: (partial as CountCafe).cafeId } })) await teardownTaggedCafe((partial as CountCafe).cafeId);
 }
});

// Reading role before the locked branch resolver can combine old authority
// with a newly committed branch. Real Postgres lock observation fixes the ordering.
test("same-cookie auth returns role and branch from one locked account snapshot", async () => {
 const owned = fixture();
 let releaseGate!: () => void;
 let signalReady!: (pid: number) => void;
 let failReady!: (error: unknown) => void;
 const released = new Promise<void>((resolve) => { releaseGate = resolve; });
 const ready = new Promise<number>((resolve, reject) => { signalReady = resolve; failReady = reject; });
 const gate = db.$transaction(async (tx) => {
  await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${owned.cashier.id} FOR NO KEY UPDATE`;
  await tx.user.update({ where: { id: owned.cashier.id }, data: { role: "BARISTA", branchId: owned.otherBranchId } });
  const pid = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
  signalReady(pid[0].pid);
  await released;
 }, { timeout: 30000 });
 void gate.catch(failReady);
 let request: Promise<{ status: number; text: string; body: { user: { role: string; branchId: string } } }> | null = null;
 try {
  const gatePid = await ready;
  request = as<{ user: { role: string; branchId: string } }>(owned.cashier.email, "/api/auth/me");
  void request.catch(() => {});
  const deadline = Date.now() + 20000;
  let blocked = false;
  while (Date.now() < deadline) {
   const waiting = await db.$queryRaw<Array<{ pid: number }>>`SELECT pid FROM pg_stat_activity
    WHERE datname = current_database() AND ${gatePid} = ANY(pg_blocking_pids(pid))
      AND query LIKE '%"User"%' AND query LIKE '%FOR NO KEY UPDATE%'`;
   if (waiting.length) { blocked = true; break; }
   await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(blocked, true, "auth request must reach the gated User lock before account edit commits");
  releaseGate();
  await gate;
  const result = await request;
  assert.equal(result.status, 200, result.text);
  assert.equal(result.body.user.role, "BARISTA", "auth must not retain the earlier CASHIER authority");
  assert.equal(result.body.user.branchId, owned.otherBranchId);
 } finally {
  releaseGate();
  await gate.catch(() => {});
  if (request) await request.catch(() => {});
 }
});
