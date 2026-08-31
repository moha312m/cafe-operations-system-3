import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { db, tag, teardownTaggedCafe } from "./helpers/db";
import { handoverEnablementPreflight, resolveBranchHandoverConfig, updateBranchHandoverConfig } from "@/lib/handover-config";

const MARKER = tag("CONFIG001");
const cafeIds: string[] = [];
let cafeId: string;
let branchId: string;
let actorId: string;

before(async () => {
  const cafe = await db.cafe.create({
    data: {
      name: `${MARKER} cafe`,
      slug: `${MARKER}-cafe`.toLowerCase(),
      settings: { create: { stockCountPolicy: "NO_SHIFT_COUNT", handoverCountType: "FULL" } },
      branches: { create: { name: `${MARKER} branch` } },
    },
    include: { branches: true },
  });
  cafeIds.push(cafe.id);
  cafeId = cafe.id;
  branchId = cafe.branches[0].id;
  const actor = await db.user.create({ data: { email: `${MARKER}@example.invalid`, name: MARKER, passwordHash: "test", role: "CAFE_OWNER", cafeId } });
  actorId = actor.id;
});

after(() => teardownTaggedCafe(cafeIds, [], { disconnect: true }));

describe("CONFIG-001 handover configuration service", () => {
  test("a NO_SHIFT_COUNT branch resolves as disabled from its cafe policy", async () => {
    const config = await resolveBranchHandoverConfig(cafeId, branchId);

    assert.equal(config.enabled, false);
    assert.equal(config.source.enabled, "CAFE");
    assert.deepEqual(config.selectedItemIds, []);
    assert.equal(config.configError, null);
  });

  test("enabling SELECTED marks exactly the requested active branch item critical", async () => {
    const selected = await db.inventoryItem.create({ data: { cafeId, branchId, name: `${MARKER} selected`, unit: "KG" } });
    const ordinary = await db.inventoryItem.create({ data: { cafeId, branchId, name: `${MARKER} ordinary`, unit: "KG" } });
    const config = await updateBranchHandoverConfig({ cafeId, branchId, actorId, patch: { enabled: true, mode: "SELECTED", selectedItemIds: [selected.id] } });
    assert.equal(config.enabled, true);
    assert.equal(config.mode, "SELECTED");
    assert.deepEqual(config.selectedItemIds, [selected.id]);
    assert.equal((await db.inventoryItem.findUniqueOrThrow({ where: { id: ordinary.id } })).isCritical, false);
    assert.equal((await db.inventoryItem.findUniqueOrThrow({ where: { id: selected.id } })).isCritical, true);
  });

  test("preflight reports CYCLE without rewriting the configured policy", async () => {
    await db.branch.update({ where: { id: branchId }, data: { stockCountPolicyOverride: "CYCLE", handoverCountTypeOverride: "FULL" } });
    const [error] = await handoverEnablementPreflight(cafeId, branchId);
    assert.equal(error.code, "CYCLE_POLICY_UNSUPPORTED");
    assert.equal((await db.branch.findUniqueOrThrow({ where: { id: branchId } })).stockCountPolicyOverride, "CYCLE");
    await db.branch.update({ where: { id: branchId }, data: { stockCountPolicyOverride: "NO_SHIFT_COUNT" } });
  });

  test("an enabled FULL branch cannot switch to empty SELECTED mode", async () => {
    await updateBranchHandoverConfig({ cafeId, branchId, actorId, patch: { enabled: true, mode: "FULL" } });
    await db.inventoryItem.updateMany({ where: { cafeId, branchId }, data: { isCritical: false } });
    await assert.rejects(
      updateBranchHandoverConfig({ cafeId, branchId, actorId, patch: { mode: "SELECTED" } }),
      /SELECTED handover mode has no selected active items/,
    );
    assert.equal((await resolveBranchHandoverConfig(cafeId, branchId)).mode, "FULL");
  });

  test("a DAILY periodic override clears a prior WEEKLY weekday", async () => {
    await updateBranchHandoverConfig({ cafeId, branchId, actorId, patch: { schedule: "WEEKLY", weekday: 1 } });
    const config = await updateBranchHandoverConfig({ cafeId, branchId, actorId, patch: { schedule: "DAILY_LAST_HANDOVER" } });
    assert.deepEqual(config.periodic, { schedule: "DAILY_LAST_HANDOVER", weekday: null });
  });

  test("writes HYBRID/FULL overrides without changing cafe defaults", async () => {
    const cafeBefore = await db.cafeSettings.findUniqueOrThrow({ where: { cafeId } });
    await updateBranchHandoverConfig({ cafeId, branchId, actorId, patch: { enabled: true, mode: "FULL" } });
    const branch = await db.branch.findUniqueOrThrow({ where: { id: branchId } });
    const cafeAfter = await db.cafeSettings.findUniqueOrThrow({ where: { cafeId } });
    assert.equal(branch.stockCountPolicyOverride, "HYBRID");
    assert.equal(branch.handoverCountTypeOverride, "FULL");
    assert.equal(cafeAfter.stockCountPolicy, cafeBefore.stockCountPolicy);
    assert.equal(cafeAfter.handoverCountType, cafeBefore.handoverCountType);
  });

  test("SELECTED replaces the active critical set without touching other branches or cafes", async () => {
    const keep = await db.inventoryItem.create({ data: { cafeId, branchId, name: `${MARKER} keep`, unit: "KG", isCritical: true } });
    const remove = await db.inventoryItem.create({ data: { cafeId, branchId, name: `${MARKER} remove`, unit: "KG", isCritical: true } });
    const sibling = await db.branch.create({ data: { cafeId, name: `${MARKER} sibling` } });
    const siblingItem = await db.inventoryItem.create({ data: { cafeId, branchId: sibling.id, name: `${MARKER} sibling item`, unit: "KG", isCritical: true } });
    const otherCafe = await db.cafe.create({ data: { name: `${MARKER} other`, slug: `${MARKER}-other`.toLowerCase(), settings: { create: {} }, branches: { create: { name: "other" } } }, include: { branches: true } });
    cafeIds.push(otherCafe.id);
    const otherItem = await db.inventoryItem.create({ data: { cafeId: otherCafe.id, branchId: otherCafe.branches[0].id, name: `${MARKER} other item`, unit: "KG", isCritical: true } });
    const config = await updateBranchHandoverConfig({ cafeId, branchId, actorId, patch: { mode: "SELECTED", selectedItemIds: [keep.id] } });
    assert.equal((await db.branch.findUniqueOrThrow({ where: { id: branchId } })).handoverCountTypeOverride, "CRITICAL");
    assert.deepEqual(config.selectedItemIds, [keep.id]);
    assert.equal((await db.inventoryItem.findUniqueOrThrow({ where: { id: keep.id } })).isCritical, true);
    assert.equal((await db.inventoryItem.findUniqueOrThrow({ where: { id: remove.id } })).isCritical, false);
    assert.equal((await db.inventoryItem.findUniqueOrThrow({ where: { id: siblingItem.id } })).isCritical, true);
    assert.equal((await db.inventoryItem.findUniqueOrThrow({ where: { id: otherItem.id } })).isCritical, true);
  });

  test("rejects every invalid selected id and leaves branch, items, and audit unchanged", async () => {
    const active = await db.inventoryItem.create({ data: { cafeId, branchId, name: `${MARKER} active`, unit: "KG" } });
    const archived = await db.inventoryItem.create({ data: { cafeId, branchId, name: `${MARKER} archived`, unit: "KG", archivedAt: new Date() } });
    const inactive = await db.inventoryItem.create({ data: { cafeId, branchId, name: `${MARKER} inactive`, unit: "KG", isActive: false } });
    const sibling = await db.branch.create({ data: { cafeId, name: `${MARKER} foreign branch` } });
    const crossBranch = await db.inventoryItem.create({ data: { cafeId, branchId: sibling.id, name: `${MARKER} cross branch`, unit: "KG" } });
    const beforeBranch = await db.branch.findUniqueOrThrow({ where: { id: branchId } });
    const auditBefore = await db.auditLog.count({ where: { cafeId, action: "HANDOVER_CONFIG_UPDATED" } });
    for (const id of [archived.id, inactive.id, crossBranch.id, "missing-item-id"]) {
      await assert.rejects(updateBranchHandoverConfig({ cafeId, branchId, actorId, patch: { selectedItemIds: [id] } }), /VALIDATION:.*missing, archived, inactive, or outside this branch/);
    }
    await assert.rejects(updateBranchHandoverConfig({ cafeId, branchId, actorId, patch: { selectedItemIds: [active.id, active.id] } }), /duplicate id/);
    const afterBranch = await db.branch.findUniqueOrThrow({ where: { id: branchId } });
    assert.equal(afterBranch.stockCountPolicyOverride, beforeBranch.stockCountPolicyOverride);
    assert.equal((await db.inventoryItem.findUniqueOrThrow({ where: { id: active.id } })).isCritical, false);
    assert.equal(await db.auditLog.count({ where: { cafeId, action: "HANDOVER_CONFIG_UPDATED" } }), auditBefore);
  });

  test("uses final effective state for empty SELECTED validation while disabled SELECTED remains readable", async () => {
    await updateBranchHandoverConfig({ cafeId, branchId, actorId, patch: { enabled: false, mode: "SELECTED", selectedItemIds: [] } });
    const disabled = await resolveBranchHandoverConfig(cafeId, branchId);
    assert.equal(disabled.enabled, false);
    assert.equal(disabled.configError?.code, "SELECTED_WITH_NO_ITEMS");
    await assert.rejects(updateBranchHandoverConfig({ cafeId, branchId, actorId, patch: { enabled: true } }), /SELECTED_WITH_NO_ITEMS/);
    assert.equal((await db.branch.findUniqueOrThrow({ where: { id: branchId } })).stockCountPolicyOverride, "NO_SHIFT_COUNT");
  });

  test("CYCLE is read without conversion, rejects enabled-only, and explicitly converts to supported modes", async () => {
    const chosen = await db.inventoryItem.create({ data: { cafeId, branchId, name: `${MARKER} cycle selected`, unit: "KG" } });
    await db.branch.update({ where: { id: branchId }, data: { stockCountPolicyOverride: "CYCLE", handoverCountTypeOverride: "FULL" } });
    assert.equal((await resolveBranchHandoverConfig(cafeId, branchId)).configError?.code, "CYCLE_POLICY_UNSUPPORTED");
    await assert.rejects(updateBranchHandoverConfig({ cafeId, branchId, actorId, patch: { enabled: true } }), /CYCLE_POLICY_UNSUPPORTED/);
    assert.equal((await db.branch.findUniqueOrThrow({ where: { id: branchId } })).stockCountPolicyOverride, "CYCLE");
    assert.equal((await updateBranchHandoverConfig({ cafeId, branchId, actorId, patch: { enabled: true, mode: "FULL" } })).mode, "FULL");
    const selected = await updateBranchHandoverConfig({ cafeId, branchId, actorId, patch: { mode: "SELECTED", selectedItemIds: [chosen.id] } });
    assert.equal(selected.mode, "SELECTED");
    assert.equal((await db.branch.findUniqueOrThrow({ where: { id: branchId } })).stockCountPolicyOverride, "HYBRID");
  });

  test("merges the periodic override pair and restores cafe provenance when cleared", async () => {
    await db.cafeSettings.update({ where: { cafeId }, data: { periodicFullCountSchedule: "WEEKLY", periodicFullCountWeekday: 4 } });
    await updateBranchHandoverConfig({ cafeId, branchId, actorId, patch: { schedule: "WEEKLY", weekday: 2 } });
    assert.deepEqual((await updateBranchHandoverConfig({ cafeId, branchId, actorId, patch: { weekday: 3 } })).periodic, { schedule: "WEEKLY", weekday: 3 });
    await assert.rejects(updateBranchHandoverConfig({ cafeId, branchId, actorId, patch: { schedule: "DAILY_LAST_HANDOVER", weekday: 3 } }), /weekday is only valid/);
    const inherited = await updateBranchHandoverConfig({ cafeId, branchId, actorId, patch: { schedule: null } });
    assert.deepEqual(inherited.periodic, { schedule: "WEEKLY", weekday: 4 });
    assert.equal(inherited.source.schedule, "CAFE");
    assert.equal(inherited.source.weekday, "CAFE");
  });

  test("writes one transactional Branch audit event for an idempotent valid patch", async () => {
    const before = await db.auditLog.count({ where: { cafeId, entityId: branchId, action: "HANDOVER_CONFIG_UPDATED" } });
    await updateBranchHandoverConfig({ cafeId, branchId, actorId, patch: { enabled: true, mode: "FULL" } });
    const audit = await db.auditLog.findFirstOrThrow({ where: { cafeId, entityId: branchId, action: "HANDOVER_CONFIG_UPDATED" }, orderBy: { createdAt: "desc" } });
    assert.equal(await db.auditLog.count({ where: { cafeId, entityId: branchId, action: "HANDOVER_CONFIG_UPDATED" } }), before + 1);
    assert.equal(audit.entity, "Branch");
    assert.ok(audit.details && typeof audit.details === "object");
  });
});
