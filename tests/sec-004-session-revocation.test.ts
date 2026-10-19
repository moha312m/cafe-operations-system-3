// SEC-004 (R-SEC-01/A14) — suspending an account must end its access now,
// not in twelve hours.
//
// The session cookie is a bearer token with a twelve-hour life, and the only
// thing that read `User.isActive` was the login route — which stops the next
// sign-in and does nothing about the session already open in a fired
// cashier's browser. Until this stage they kept collecting payments, closing
// shifts and accepting custody for the rest of the token's life.
//
// The check sits in `requireActiveSession` in `@/lib/api` rather than in
// `getSession`, because `src/proxy.ts` — the edge middleware — imports from
// `@/lib/auth` and Prisma cannot go into that bundle. Two routes are asked
// below on purpose: one guarded by `requireKey`, and one that reads the
// session directly, because a fix that covered only the first would leave
// the money-moving routes open.

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { db, teardownTaggedCafe } from "./helpers/db";
import { countCafe, COUNT_PASSWORD, type CountCafe } from "./helpers/count";
import { BASE, requireServer, login, as } from "./helpers/http";

let fx: CountCafe;

// `requireKey` guards this one; `requireActiveSession` guards the other.
const KEY_GUARDED = "/api/branches";
const SESSION_GUARDED = "/api/shifts";

before(async () => {
  await requireServer();
  fx = await countCafe("SEC004");
});

after(() => teardownTaggedCafe(fx.cafeId, [], { disconnect: true }));

const setUserActive = (id: string, isActive: boolean) =>
  db.user.update({ where: { id }, data: { isActive, archivedAt: null } });

describe("SEC-004 a suspended account loses API access at once", () => {
  test("an active user in an active cafe is served", async () => {
    const res = await as(fx.manager.email, KEY_GUARDED);
    assert.equal(res.status, 200, res.text);
  });

  test("deactivating the user refuses the NEXT request on the same cookie", async () => {
    // No new sign-in, no waiting for the token to expire: the same session
    // that worked a moment ago.
    await setUserActive(fx.manager.id, false);
    const res = await as(fx.manager.email, KEY_GUARDED);
    assert.equal(res.status, 403, res.text);
    assert.match(res.text, /الحساب موقوف/);

    await setUserActive(fx.manager.id, true);
    const back = await as(fx.manager.email, KEY_GUARDED);
    assert.equal(back.status, 200, "reactivating restores access — a suspension, not a ban");
  });

  test("the revocation also covers routes that read the session directly", async () => {
    // The coverage point. `/api/shifts` never went through `requireKey`, so
    // a fix placed only in the permission resolver would have missed it —
    // and the refund routes are in this same family.
    const before = await as(fx.cashier.email, SESSION_GUARDED);
    assert.notEqual(before.status, 401, before.text);

    await setUserActive(fx.cashier.id, false);
    const during = await as(fx.cashier.email, SESSION_GUARDED);
    assert.equal(during.status, 403, during.text);

    await setUserActive(fx.cashier.id, true);
  });

  test("archiving a user revokes access even while isActive is true", async () => {
    await db.user.update({
      where: { id: fx.waiter.id },
      data: { archivedAt: new Date() },
    });
    const res = await as(fx.waiter.email, KEY_GUARDED);
    assert.equal(res.status, 403, res.text);
    await db.user.update({ where: { id: fx.waiter.id }, data: { archivedAt: null } });
  });

  test("suspending the CAFE revokes every session inside it", async () => {
    await db.cafe.update({ where: { id: fx.cafeId }, data: { isActive: false } });
    const res = await as(fx.manager.email, KEY_GUARDED);
    assert.equal(res.status, 403, res.text);
    assert.match(res.text, /إيقاف حساب الكافيه/);
    await db.cafe.update({ where: { id: fx.cafeId }, data: { isActive: true } });
  });

  test("a deactivated user cannot sign back in either", async () => {
    await setUserActive(fx.cashier.id, false);
    await assert.rejects(() => login(fx.cashier.email, COUNT_PASSWORD));
    await setUserActive(fx.cashier.id, true);
    await login(fx.cashier.email, COUNT_PASSWORD);
  });

  test("the check is a live read, with no staleness window", async () => {
    // Deactivate and ask immediately, twice, with no delay between them: a
    // cached answer would let at least one through.
    await setUserActive(fx.storekeeper.id, false);
    const first = await as(fx.storekeeper.email, KEY_GUARDED);
    const second = await as(fx.storekeeper.email, KEY_GUARDED);
    assert.equal(first.status, 403);
    assert.equal(second.status, 403);
    await setUserActive(fx.storekeeper.id, true);
  });
});

async function capturedManagerCookie() {
  const response = await fetch(BASE + "/api/auth/login", { method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: fx.manager.email, password: COUNT_PASSWORD }) });
  assert.equal(response.status, 200, await response.text());
  const header = response.headers.getSetCookie().find(value => value.startsWith("cafeops_session="));
  assert.ok(header, "owned login must issue a session");
  return header.split(";")[0];
}

test("logout rejects the exact captured cookie at auth/me and branch mutation; second session survives", async () => {
  const first = await capturedManagerCookie(), second = await capturedManagerCookie();
  assert.ok(first !== second, "independent logins must issue distinct tokens");
  const logout = await fetch(BASE + "/api/auth/logout", { method: "POST", headers: { cookie: first } });
  assert.equal(logout.status, 200, await logout.text());
  assert.ok(logout.headers.getSetCookie().some(header => header.startsWith("cafeops_session=;") &&
    (/max-age=0/i.test(header) || /expires=Thu, 01 Jan 1970/i.test(header))), "logout must expire the cookie");
  const before = await db.branch.findUniqueOrThrow({ where: { id: fx.branchId } });
  const me = await fetch(BASE + "/api/auth/me", { headers: { cookie: first } });
  assert.equal(me.status, 401, await me.text());
  const denied = await fetch(BASE + "/api/branches/" + fx.branchId, { method: "PATCH",
    headers: { cookie: first, "Content-Type": "application/json" }, body: JSON.stringify({ phone: "SEC004-denied" }) });
  assert.equal(denied.status, 401, await denied.text());
  assert.deepEqual(await db.branch.findUniqueOrThrow({ where: { id: fx.branchId } }), before);
  const other = await fetch(BASE + "/api/auth/me", { headers: { cookie: second } });
  assert.equal(other.status, 200, await other.text());
  const fresh = await capturedManagerCookie();
  assert.equal((await fetch(BASE + "/api/auth/me", { headers: { cookie: fresh } })).status, 200);
});

test("removing branches.manage denies the existing session's PATCH and POST while viewing remains authorized", async () => {
  const cookie = await capturedManagerCookie();
  await db.userPermissionOverride.create({ data: { userId: fx.manager.id, permissionKey: "branches.manage", allowed: false } });
  try {
    const before = await db.branch.findMany({ where: { cafeId: fx.cafeId }, orderBy: { id: "asc" } });
    const mutation = await fetch(BASE + "/api/branches/" + fx.branchId, { method: "PATCH",
      headers: { cookie, "Content-Type": "application/json" }, body: JSON.stringify({ phone: "SEC004-denied" }) });
    assert.equal(mutation.status, 403, await mutation.text());
    const create = await fetch(BASE + "/api/branches", { method: "POST",
      headers: { cookie, "Content-Type": "application/json" }, body: JSON.stringify({ name: "SEC004-denied" }) });
    assert.equal(create.status, 403, await create.text());
    assert.deepEqual(await db.branch.findMany({ where: { cafeId: fx.cafeId }, orderBy: { id: "asc" } }), before);
    const view = await fetch(BASE + "/api/branches", { headers: { cookie } });
    assert.equal(view.status, 200, await view.text());
  } finally {
    await db.userPermissionOverride.deleteMany({ where: { userId: fx.manager.id, permissionKey: "branches.manage" } });
  }
});
