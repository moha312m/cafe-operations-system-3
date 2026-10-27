// Revoked signed cookies must leave the protected-page/login redirect cycle.
import { after, afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { db, teardownTaggedCafe } from "./helpers/db";
import { countCafe, COUNT_PASSWORD, type CountCafe } from "./helpers/count";
import { BASE, requireServer } from "./helpers/http";

let fx: CountCafe | null = null;
function fixture(): CountCafe { assert.ok(fx, "owned fixture setup must complete"); return fx; }
beforeEach(async () => { fx = null; await requireServer(); fx = await countCafe("STAFF003"); });
afterEach(async () => { const owned = fx; fx = null; if (owned) await teardownTaggedCafe(owned.cafeId); });
after(async () => { await db.$disconnect(); });

async function ownerCookie() {
 const result = await fetch(BASE + "/api/auth/login", { method: "POST", redirect: "manual",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email: fixture().owner.email, password: COUNT_PASSWORD }),
 });
 assert.equal(result.status, 200, await result.text());
 const cookie = result.headers.getSetCookie().find((value) => value.startsWith("cafeops_session="));
 assert.ok(cookie, "real login must issue the fixture session cookie");
 return cookie.split(";")[0];
}

function expiresSession(header: string): boolean {
 if (!header.startsWith("cafeops_session=;")) return false;
 const age = /max-age=(-?\d+)/i.exec(header);
 const expires = /expires=([^;]+)/i.exec(header);
 return !!((age && Number(age[1]) <= 0) || (expires && new Date(expires[1]).getTime() <= Date.now()));
}

async function followPages(path: string, initialCookie: string) {
 let url = new URL(path, BASE);
 let cookie = initialCookie;
 const hops: Array<{ path: string; status: number }> = [];
 let expiredCookieSeen = false;
 for (let i = 0; i < 8; i++) {
  assert.equal(url.origin, new URL(BASE).origin, "redirects must remain on the guarded test server");
  const result = await fetch(url, { redirect: "manual", headers: { cookie } });
  hops.push({ path: url.pathname, status: result.status });
  for (const header of result.headers.getSetCookie()) {
   if (!header.startsWith("cafeops_session=")) continue;
   if (expiresSession(header)) expiredCookieSeen = true;
   const pair = header.split(";")[0];
   cookie = pair === "cafeops_session=" ? "" : pair;
  }
  const location = result.headers.get("location");
  await result.text();
  if (result.status >= 300 && result.status < 400 && location) {
   url = new URL(location, url);
   continue;
  }
  return { ended: true, status: result.status, path: url.pathname, cookie, expiredCookieSeen, hops };
 }
 return { ended: false, status: hops[hops.length-1].status, path: url.pathname, cookie, expiredCookieSeen, hops };
}

async function assertRecoveryAndActiveControl(cookie: string, restore: () => Promise<unknown>) {
 const revoked = await followPages("/staff", cookie);
 assert.equal(revoked.ended, true, "revoked session must reach login within eight manual redirects: " + JSON.stringify(revoked.hops));
 assert.equal(revoked.path, "/login");
 assert.equal(revoked.status, 200);
 assert.equal(revoked.expiredCookieSeen, true, "recovery must expire the rejected signed cookie in a Route Handler");
 await restore();
 const active = await followPages("/api/auth/recover", cookie);
 assert.equal(active.ended, true, JSON.stringify(active.hops));
 assert.equal(active.status, 200);
 assert.equal(active.path, "/dashboard");
 assert.equal(active.expiredCookieSeen, false, "active recovery must retain the signed session");
 assert.equal(active.cookie === cookie, true, "active recovery must preserve the existing cookie");
}

// Redirecting to /login while retaining the valid JWT would bounce back to dashboard forever.
test("deactivated account's same-cookie protected page reaches login and expires the cookie", async () => {
 const cookie = await ownerCookie();
 await db.user.update({ where: { id: fixture().owner.id }, data: { isActive: false } });
 await assertRecoveryAndActiveControl(cookie, () => db.user.update({ where: { id: fixture().owner.id }, data: { isActive: true } }));
});

test("suspended cafe's same-cookie protected page reaches login and expires the cookie", async () => {
 const cookie = await ownerCookie();
 await db.cafe.update({ where: { id: fixture().cafeId }, data: { isActive: false } });
 await assertRecoveryAndActiveControl(cookie, () => db.cafe.update({ where: { id: fixture().cafeId }, data: { isActive: true } }));
});
