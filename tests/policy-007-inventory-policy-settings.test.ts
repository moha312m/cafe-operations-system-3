// POLICY-007 — who may change how hard the till enforces inventory.
//
// The mode decides whether a café can sell stock it does not have, and
// whether it can sell against a recipe nobody has written. That is business
// configuration, so it sits behind `settings.edit` — the café-configuration
// power that rides with cafe:manage and can be granted to a custom admin role.
//
// It is deliberately NOT a cashier permission. A till that could relax its own
// enforcement would not be an enforcement policy at all, it would be a prompt
// somebody clicks through on a busy evening. The same reasoning is why
// POLICY-006 proves the request body cannot choose the mode either: neither
// the person at the till nor the software in front of them gets a vote.

import { test, after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { db, teardownTaggedCafe } from "./helpers/db";
import { requireServer, as } from "./helpers/http";
import { countCafe, type CountCafe } from "./helpers/count";

let fx: CountCafe;
let other: CountCafe;

before(async () => {
  await requireServer();
  fx = await countCafe("POL007");
  other = await countCafe("POL007X");
});

after(() =>
  teardownTaggedCafe(
    [...(fx ? [fx.cafeId] : []), ...(other ? [other.cafeId] : [])],
    [], { disconnect: true }
  )
);

const PATH = "/api/cafe/inventory-policy";

const setMode = (email: string, mode: string) =>
  as<{ mode?: string; error?: string }>(email, PATH, {
    method: "PATCH",
    body: JSON.stringify({ mode }),
  });

const readMode = (email: string) =>
  as<{ mode?: string; error?: string }>(email, PATH);

describe("POLICY-007 changing the enforcement mode", () => {
  test("a new café reads STRICT", async () => {
    const r = await readMode(fx.owner.email);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.mode, "STRICT", "the safe end of the range is the default");
  });

  test("the owner can move through all three modes", async () => {
    for (const mode of ["ALLOW_NEGATIVE_STOCK", "OVERRIDE_ALL", "STRICT"]) {
      const r = await setMode(fx.owner.email, mode);
      assert.equal(r.status, 200, `${mode}: ${r.text}`);
      assert.equal(r.body.mode, mode);
      assert.equal((await readMode(fx.owner.email)).body.mode, mode, "and it persists");
    }
  });

  test("an admin holding settings.edit can change it", async () => {
    // Not a role check: the manager is granted the KEY. That is the whole
    // point of the custom-role model — the power travels with the permission,
    // so a café can delegate configuration without handing over ownership.
    const before = await setMode(fx.manager.email, "ALLOW_NEGATIVE_STOCK");
    assert.equal(before.status, 403, "a plain branch manager does not hold settings.edit");

    await db.userPermissionOverride.create({
      data: { userId: fx.manager.id, permissionKey: "settings.edit", allowed: true },
    });
    try {
      const r = await setMode(fx.manager.email, "ALLOW_NEGATIVE_STOCK");
      assert.equal(r.status, 200, `granted settings.edit should suffice: ${r.text}`);
      assert.equal(r.body.mode, "ALLOW_NEGATIVE_STOCK");
    } finally {
      await db.userPermissionOverride.deleteMany({
        where: { userId: fx.manager.id, permissionKey: "settings.edit" },
      });
      await setMode(fx.owner.email, "STRICT");
    }
  });

  test("a cashier cannot change it", async () => {
    const r = await setMode(fx.cashier.email, "OVERRIDE_ALL");
    assert.equal(r.status, 403, `a till must not relax its own enforcement: ${r.text}`);
    assert.equal(
      (await readMode(fx.owner.email)).body.mode, "STRICT",
      "and the refusal must leave the policy where it was"
    );
  });

  test("a waiter cannot change it either", async () => {
    const r = await setMode(fx.waiter.email, "OVERRIDE_ALL");
    assert.equal(r.status, 403, r.text);
  });

  test("a user of another café cannot change this café's mode", async () => {
    // The cafeId comes from the session and is never taken from the request,
    // so there is no addressing mechanism to abuse: the neighbour's owner can
    // only ever change their OWN café.
    await setMode(fx.owner.email, "STRICT");
    const r = await setMode(other.owner.email, "OVERRIDE_ALL");
    assert.equal(r.status, 200, "they may configure their own café");

    assert.equal(
      (await readMode(fx.owner.email)).body.mode, "STRICT",
      "this café must be untouched by the neighbour's change"
    );
    assert.equal((await readMode(other.owner.email)).body.mode, "OVERRIDE_ALL");
    await setMode(other.owner.email, "STRICT");
  });

  test("an unknown mode is rejected", async () => {
    const r = await setMode(fx.owner.email, "ALLOW_EVERYTHING");
    assert.ok(r.status >= 400 && r.status < 500, `expected a client error, got ${r.status}`);
    assert.equal((await readMode(fx.owner.email)).body.mode, "STRICT");
  });

  test("the change is audited with the previous and new value", async () => {
    await setMode(fx.owner.email, "STRICT");
    const before = await db.auditLog.count({
      where: { cafeId: fx.cafeId, action: "INVENTORY_ENFORCEMENT_MODE_CHANGED" },
    });

    const r = await setMode(fx.owner.email, "OVERRIDE_ALL");
    assert.equal(r.status, 200, r.text);

    const rows = await db.auditLog.findMany({
      where: { cafeId: fx.cafeId, action: "INVENTORY_ENFORCEMENT_MODE_CHANGED" },
      orderBy: { createdAt: "desc" },
    });
    assert.equal(rows.length, before + 1, "exactly one row per change");

    const d = rows[0].details as Record<string, unknown>;
    assert.equal(d.oldValue, "STRICT", "the record must say what it was");
    assert.equal(d.newValue, "OVERRIDE_ALL", "and what it became");
    assert.equal(rows[0].userId, fx.owner.id, "and who decided");
    assert.equal(rows[0].entity, "CafeSettings");
    assert.ok(rows[0].createdAt instanceof Date);

    await setMode(fx.owner.email, "STRICT");
  });

  test("reading the policy needs only the power to take an order", async () => {
    // The POS has to be able to explain a refusal, so reading is not gated
    // behind configuration rights. Reading is not changing.
    const r = await readMode(fx.cashier.email);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.mode, "STRICT");
  });
});
