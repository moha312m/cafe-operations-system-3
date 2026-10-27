import assert from "node:assert/strict";
import test from "node:test";
import { assertResaleHandoff, readResaleHandoff } from "../scripts/resale-acceptance-guard.mjs";

const now = Date.UTC(2026, 9, 12, 1);
function proof() {
  return { issue: "OWNER-UAT-RESALE-001", nativeHost: { hostPid: 42, status: "OWNER HOST VERIFIED", at: new Date(now).toISOString(), jobMembership: { pid: 42, available: true, inJob: false } }, lifecycle: { provenAfterDispatch: true, verifiedAt: new Date(now).toISOString() }, runtimeExpiresAt: new Date(now + 3600_000).toISOString(), clone: { host: "127.0.0.1", port: 5434, database: "cafe_ops_test", systemIdentifier: "7693368256609479860", markerSha256: "a".repeat(64) }, build: { manifestPath: "fixture-only", id: "fixture-only" }, application: { port: 3104, cloneConnectionVerified: true }, mainDatabaseAccess: false };
}
const env = { DATABASE_URL: "postgresql://offline:offline@127.0.0.1:5434/cafe_ops_test", TEST_BASE_URL: "http://127.0.0.1:3104", NODE_ENV: "test" };
test("offline fence accepts only a complete synthetic contract; this proves no live host", () => { assert.equal(assertResaleHandoff(proof(), env, now).issue, "OWNER-UAT-RESALE-001"); });
test("offline absent handoff refuses before filesystem/database/runtime work", () => { assert.throws(() => readResaleHandoff({}), /BLOCKED: provider handoff/); });
for (const target of ["postgresql://offline:offline@127.0.0.1:5433/cafe_ops", "postgresql://offline:offline@127.0.0.1:5434/cafe_ops_test_other", "postgresql://offline:offline@localhost:5434/cafe_ops_test"]) {
  test("offline exact clone fence rejects an ineligible target", () => assert.throws(() => assertResaleHandoff(proof(), { ...env, DATABASE_URL: target }, now)));
}
test("offline job membership, unavailable native proof and expired lifecycle refuse", () => {
  for (const change of [p => { p.nativeHost.jobMembership.inJob = true; }, p => { p.nativeHost.jobMembership.available = false; }, p => { p.lifecycle.verifiedAt = new Date(now - 31 * 60_000).toISOString(); }, p => { p.runtimeExpiresAt = new Date(now - 1).toISOString(); }]) { const p = proof(); change(p); assert.throws(() => assertResaleHandoff(p, env, now)); }
});
test("offline app identity and production mode cannot be substituted", () => {
  const p = proof(); p.application.cloneConnectionVerified = false; assert.throws(() => assertResaleHandoff(p, env, now));
  assert.throws(() => assertResaleHandoff(proof(), { ...env, TEST_BASE_URL: "http://127.0.0.1:3000" }, now));
  assert.throws(() => assertResaleHandoff(proof(), { ...env, NODE_ENV: "production" }, now));
});
test("offline native evidence must identify the same fresh self-probed host", () => {
  const valid = proof(); valid.nativeHost.hostPid = 42; valid.nativeHost.jobMembership.pid = 42;
  for (const change of [p => { p.nativeHost.hostPid = "42"; }, p => { p.nativeHost.jobMembership.pid = 43; }, p => { p.nativeHost.at = new Date(now - 31 * 60_000).toISOString(); }]) {
    const p = structuredClone(valid); change(p); assert.throws(() => assertResaleHandoff(p, env, now));
  }
});
