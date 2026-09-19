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
import { requireServer, login, as } from "./helpers/http";

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
