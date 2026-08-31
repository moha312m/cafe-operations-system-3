import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { db, fixture } from "./helpers/db";
import { as, login, requireServer } from "./helpers/http";

const OWNER = "owner@demo.com";
const CASHIER = "cashier@demo.com";
const ADMIN = "admin@cafeops.dev";
let cafeId: string;
let branchId: string;
let original: Awaited<ReturnType<typeof db.branch.findUniqueOrThrow>>;

before(async () => {
  await requireServer();
  await login(OWNER, "owner1234");
  await login(CASHIER, "cashier123");
  await login(ADMIN, "admin1234");
  ({ cafeId, branchId } = await fixture());
  original = await db.branch.findUniqueOrThrow({ where: { id: branchId } });
});

after(async () => {
  await db.branch.update({ where: { id: branchId }, data: {
    stockCountPolicyOverride: original.stockCountPolicyOverride,
    handoverCountTypeOverride: original.handoverCountTypeOverride,
    periodicFullCountScheduleOverride: original.periodicFullCountScheduleOverride,
    periodicFullCountWeekdayOverride: original.periodicFullCountWeekdayOverride,
  } });
  await db.$disconnect();
});

describe("CONFIG-002 handover configuration API", () => {
  test("GET rejects an unauthenticated caller before reading branch configuration", async () => {
    const response = await fetch("http://localhost:3100/api/branches/not-a-branch/handover-config");

    assert.equal(response.status, 401);
  });

  test("GET returns effective configuration and field provenance to a permitted cafe reader", async () => {
    const response = await as<{ config: { enabled: boolean; source: { enabled: string; schedule: string } } }>(OWNER, `/api/branches/${branchId}/handover-config`);
    assert.equal(response.status, 200);
    assert.equal(typeof response.body.config.enabled, "boolean");
    assert.ok(["CAFE", "BRANCH"].includes(response.body.config.source.enabled));
    assert.ok(["CAFE", "BRANCH"].includes(response.body.config.source.schedule));
  });

  test("PATCH requires stock_count.configure and an authenticated user", async () => {
    const anonymous = await fetch(`http://localhost:3100/api/branches/${branchId}/handover-config`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: "{}" });
    assert.equal(anonymous.status, 401);
    const denied = await as(CASHIER, `/api/branches/${branchId}/handover-config`, { method: "PATCH", body: "{}" });
    assert.equal(denied.status, 403);
  });

  test("non-super-admin cafeId cannot redirect tenant access and cross-cafe branches are rejected", async () => {
    const ignored = await as<{ config: { source: unknown } }>(OWNER, `/api/branches/${branchId}/handover-config?cafeId=another-cafe`);
    assert.equal(ignored.status, 200);
    const other = await db.cafe.create({ data: { name: "CONFIG002 other", slug: `config002-other-${Date.now()}`, settings: { create: {} }, branches: { create: { name: "other" } } }, include: { branches: true } });
    try {
      const denied = await as(OWNER, `/api/branches/${other.branches[0].id}/handover-config`);
      assert.equal(denied.status, 403);
    } finally {
      await db.cafe.delete({ where: { id: other.id } });
    }
  });

  test("SUPER_ADMIN requires explicit cafeId and succeeds with a valid context for GET and PATCH", async () => {
    assert.equal((await as(ADMIN, `/api/branches/${branchId}/handover-config`)).status, 400);
    assert.equal((await as(ADMIN, `/api/branches/${branchId}/handover-config?cafeId=${cafeId}`)).status, 200);
    assert.equal((await as(ADMIN, `/api/branches/${branchId}/handover-config?cafeId=${cafeId}`, { method: "PATCH", body: JSON.stringify({ enabled: false, mode: "FULL" }) })).status, 200);
  });

  test("strict PATCH validation rejects malformed configuration before writing", async () => {
    const before = await db.branch.findUniqueOrThrow({ where: { id: branchId } });
    for (const body of [
      { unexpected: true }, { mode: "BAD" }, { schedule: "BAD" }, { weekday: 7 }, { weekday: -1 }, { schedule: "WEEKLY" },
    ]) {
      const result = await as(OWNER, `/api/branches/${branchId}/handover-config`, { method: "PATCH", body: JSON.stringify(body) });
      assert.equal(result.status, 400);
    }
    const after = await db.branch.findUniqueOrThrow({ where: { id: branchId } });
    assert.equal(after.stockCountPolicyOverride, before.stockCountPolicyOverride);
  });

  test("PATCH re-resolves periodic state, clears stale weekday, and exposes a safe configuration code", async () => {
    assert.equal((await as(OWNER, `/api/branches/${branchId}/handover-config`, { method: "PATCH", body: JSON.stringify({ schedule: "WEEKLY", weekday: 2 }) })).status, 200);
    const daily = await as<{ config: { periodic: { schedule: string; weekday: number | null } } }>(OWNER, `/api/branches/${branchId}/handover-config`, { method: "PATCH", body: JSON.stringify({ schedule: "DAILY_LAST_HANDOVER" }) });
    assert.equal(daily.status, 200);
    assert.deepEqual(daily.body.config.periodic, { schedule: "DAILY_LAST_HANDOVER", weekday: null });
    await db.branch.update({ where: { id: branchId }, data: { stockCountPolicyOverride: "CYCLE", handoverCountTypeOverride: "FULL" } });
    const refused = await as(OWNER, `/api/branches/${branchId}/handover-config`, { method: "PATCH", body: JSON.stringify({ enabled: true }) });
    assert.equal(refused.status, 400);
    assert.match(refused.text, /CYCLE_POLICY_UNSUPPORTED/);
    const converted = await as<{ config: { mode: string } }>(OWNER, `/api/branches/${branchId}/handover-config`, { method: "PATCH", body: JSON.stringify({ enabled: true, mode: "FULL" }) });
    assert.equal(converted.status, 200);
    assert.equal(converted.body.config.mode, "FULL");
  });

  test("selection failures produce no partial state and successful logical PATCH produces one audit event", async () => {
    const archived = await db.inventoryItem.create({ data: { cafeId, branchId, name: `CONFIG002 archived ${Date.now()}`, unit: "KG", archivedAt: new Date() } });
    const branchBefore = await db.branch.findUniqueOrThrow({ where: { id: branchId } });
    const auditBefore = await db.auditLog.count({ where: { cafeId, entityId: branchId, action: "HANDOVER_CONFIG_UPDATED" } });
    const failed = await as(OWNER, `/api/branches/${branchId}/handover-config`, { method: "PATCH", body: JSON.stringify({ enabled: true, mode: "SELECTED", selectedItemIds: [archived.id] }) });
    assert.equal(failed.status, 400);
    assert.equal((await db.branch.findUniqueOrThrow({ where: { id: branchId } })).stockCountPolicyOverride, branchBefore.stockCountPolicyOverride);
    assert.equal(await db.auditLog.count({ where: { cafeId, entityId: branchId, action: "HANDOVER_CONFIG_UPDATED" } }), auditBefore);
    const ok = await as(OWNER, `/api/branches/${branchId}/handover-config`, { method: "PATCH", body: JSON.stringify({ enabled: true, mode: "FULL" }) });
    assert.equal(ok.status, 200);
    assert.equal(await db.auditLog.count({ where: { cafeId, entityId: branchId, action: "HANDOVER_CONFIG_UPDATED" } }), auditBefore + 1);
  });
});
