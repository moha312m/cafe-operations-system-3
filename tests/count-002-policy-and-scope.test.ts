// COUNT-002 — the server decides what is in scope, and admits what it cannot do.
//
// Two separate refusals live here, and both matter for the same reason:
// a count that can be steered is not evidence.
//
// SCOPE. `resolveCountScope` takes no item list — not "ignores one", takes
// none, by signature. If the caller named the items, a custodian could leave
// the short one out and the count would come back clean by construction. The
// server derives scope from the owner's own configuration: FULL is every
// eligible item at the branch, CRITICAL is the subset the owner marked.
//
// CYCLE. Spec §3 lists cycle counting among the configurable policies, so the
// enum keeps it and the resolver reports it faithfully. But no cycle engine
// exists, so both entry points that would ACT on it refuse, by name. The
// alternative — quietly running a FULL count and labelling it a cycle — would
// let an owner believe cycle counting was happening when nothing was, which
// is worse than the feature being missing.

import { test, after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { db, tag } from "./helpers/db";
import {
  resolveStockCountPolicy,
  countRequiredForHandover,
  resolveCountScope,
  UnsupportedCountPolicyError,
} from "@/lib/stock-count-policy";

const MARKER = tag("COUNT002");
let cafeId: string;
let branchA: string;
let branchB: string;
const itemIds: Record<string, string> = {};

/**
 * A café of this suite's own, with two branches.
 *
 * Scope is a per-branch question and the demo café's item list is shared
 * data this suite must not shape. Owning the tenant is what lets the
 * "never crosses branches" assertion mean something.
 */
before(async () => {
  const cafe = await db.cafe.create({
    data: {
      name: `${MARKER} cafe`,
      slug: MARKER.toLowerCase(),
      settings: { create: {} },
      branches: { create: [{ name: `${MARKER} A` }, { name: `${MARKER} B` }] },
    },
    include: { branches: { orderBy: { name: "asc" } } },
  });
  cafeId = cafe.id;
  branchA = cafe.branches[0].id;
  branchB = cafe.branches[1].id;

  const make = async (
    key: string, branchId: string,
    extra: { isCritical?: boolean; isActive?: boolean; archivedAt?: Date } = {}
  ) => {
    const item = await db.inventoryItem.create({
      data: {
        cafeId, branchId, name: `${MARKER} ${key}`, unit: "KG",
        costPerUnit: 10, currentStock: 1, ...extra,
      },
    });
    itemIds[key] = item.id;
  };

  await make("a-critical", branchA, { isCritical: true });
  await make("a-ordinary", branchA);
  await make("a-archived", branchA, { isCritical: true, archivedAt: new Date() });
  await make("a-inactive", branchA, { isCritical: true, isActive: false });
  await make("b-critical", branchB, { isCritical: true });
});

after(async () => {
  await db.inventoryItem.deleteMany({ where: { cafeId } });
  await db.cafe.deleteMany({ where: { id: cafeId } });
  await db.$disconnect();
});

/** Set the café's policy columns for one assertion. */
async function setCafe(data: Record<string, unknown>) {
  await db.cafeSettings.update({ where: { cafeId }, data });
}

/** Set (or clear) a branch override. */
async function setBranch(branchId: string, data: Record<string, unknown>) {
  await db.branch.update({ where: { id: branchId }, data });
}

describe("COUNT-002 policy resolution and server-derived scope", () => {
  test("with every override NULL, the branch inherits and says so", async () => {
    await setCafe({
      stockCountPolicy: "HYBRID", handoverCountType: "CRITICAL",
      periodicCountType: "FULL", stockCountMode: "BLIND",
    });
    await setBranch(branchA, {
      stockCountPolicyOverride: null, handoverCountTypeOverride: null,
      periodicCountTypeOverride: null, stockCountModeOverride: null,
    });

    const r = await resolveStockCountPolicy(cafeId, branchA);
    assert.equal(r.policy, "HYBRID");
    assert.equal(r.handoverCountType, "CRITICAL");
    assert.equal(r.periodicCountType, "FULL");
    assert.equal(r.mode, "BLIND");
    assert.deepEqual(r.source, {
      policy: "CAFE", handoverCountType: "CAFE",
      periodicCountType: "CAFE", mode: "CAFE",
    });
  });

  test("one override wins for its own field only, and reports BRANCH", async () => {
    // The reason `source` exists: an owner looking at a branch that behaves
    // unexpectedly needs to know whether the branch was configured or is
    // merely inheriting, and those are indistinguishable from the value.
    await setBranch(branchA, { stockCountModeOverride: "OPEN" });
    try {
      const r = await resolveStockCountPolicy(cafeId, branchA);
      assert.equal(r.mode, "OPEN");
      assert.equal(r.source.mode, "BRANCH");
      assert.equal(r.policy, "HYBRID", "the other fields still inherit");
      assert.equal(r.source.policy, "CAFE");
    } finally {
      await setBranch(branchA, { stockCountModeOverride: null });
    }
  });

  test("HYBRID selects the handover count type, and is never a count type itself", async () => {
    await setCafe({ stockCountPolicy: "HYBRID", handoverCountType: "CRITICAL" });
    const r = await resolveStockCountPolicy(cafeId, branchA);
    assert.deepEqual(countRequiredForHandover(r), { required: true, type: "CRITICAL" });

    await setCafe({ handoverCountType: "FULL" });
    const full = await resolveStockCountPolicy(cafeId, branchA);
    assert.deepEqual(
      countRequiredForHandover(full), { required: true, type: "FULL" },
      "HYBRID follows handoverCountType rather than meaning anything on its own"
    );
    await setCafe({ handoverCountType: "CRITICAL" });
  });

  test("NO_SHIFT_COUNT requires nothing, and names no type", async () => {
    await setCafe({ stockCountPolicy: "NO_SHIFT_COUNT" });
    const r = await resolveStockCountPolicy(cafeId, branchA);
    assert.deepEqual(countRequiredForHandover(r), { required: false, type: null });
    await setCafe({ stockCountPolicy: "HYBRID" });
  });

  test("CYCLE resolves faithfully but refuses to act, from both entry points", async () => {
    await setCafe({ stockCountPolicy: "CYCLE" });
    try {
      const r = await resolveStockCountPolicy(cafeId, branchA);
      assert.equal(r.policy, "CYCLE", "the configured intent is reported, not rewritten");

      assert.throws(
        () => countRequiredForHandover(r),
        (e: Error) => e instanceof UnsupportedCountPolicyError && /CYCLE/.test(e.message),
        "the refusal must name CYCLE so the owner knows what was refused"
      );
      await assert.rejects(
        () => resolveCountScope({ cafeId, branchId: branchA, type: "FULL" as never, policy: r }),
        (e: Error) => e instanceof UnsupportedCountPolicyError && /CYCLE/.test(e.message)
      );
    } finally {
      await setCafe({ stockCountPolicy: "HYBRID" });
    }
  });

  test("FULL scope is every eligible item, excluding archived and inactive", async () => {
    const r = await resolveCountScope({ cafeId, branchId: branchA, type: "FULL" });
    assert.equal(r.derivation, "ALL_ELIGIBLE");
    assert.deepEqual(
      [...r.inventoryItemIds].sort(),
      [itemIds["a-critical"], itemIds["a-ordinary"]].sort(),
      "an archived or deactivated ingredient is not on the shelf to be counted"
    );
  });

  test("CRITICAL scope is only what the owner marked critical", async () => {
    const r = await resolveCountScope({ cafeId, branchId: branchA, type: "CRITICAL" });
    assert.equal(r.derivation, "CRITICAL_ONLY");
    assert.deepEqual(r.inventoryItemIds, [itemIds["a-critical"]]);
  });

  test("a branch with no critical items returns an empty scope, not an error", async () => {
    // Refusing to start a count on an empty scope is T24's decision, made
    // where there is a user to tell. This function reports the fact.
    await db.inventoryItem.update({
      where: { id: itemIds["b-critical"] }, data: { isCritical: false },
    });
    try {
      const r = await resolveCountScope({ cafeId, branchId: branchB, type: "CRITICAL" });
      assert.deepEqual(r.inventoryItemIds, []);
      assert.equal(r.derivation, "CRITICAL_ONLY");
    } finally {
      await db.inventoryItem.update({
        where: { id: itemIds["b-critical"] }, data: { isCritical: true },
      });
    }
  });

  test("scope never crosses a branch boundary", async () => {
    const a = await resolveCountScope({ cafeId, branchId: branchA, type: "CRITICAL" });
    const b = await resolveCountScope({ cafeId, branchId: branchB, type: "CRITICAL" });
    assert.deepEqual(a.inventoryItemIds, [itemIds["a-critical"]]);
    assert.deepEqual(b.inventoryItemIds, [itemIds["b-critical"]]);
    assert.equal(
      a.inventoryItemIds.includes(itemIds["b-critical"]), false,
      "one branch's shelf is not another's"
    );
  });

  test("resolveCountScope takes no item list, by signature", () => {
    // The structural guarantee, asserted rather than described. Read from the
    // TypeScript source because the compiled function erases its parameter
    // types — at runtime it is just `(args)`, which would prove nothing.
    const src = readFileSync("src/lib/stock-count-policy.ts", "utf8");
    const start = src.indexOf("export async function resolveCountScope");
    assert.ok(start > 0, "resolveCountScope must be exported from this module");
    const signature = src.slice(start, src.indexOf("): Promise<", start));

    for (const forbidden of ["inventoryItemIds", "itemIds", "items", "scopeItems"]) {
      assert.equal(
        signature.includes(forbidden), false,
        `resolveCountScope must not accept ${forbidden}: scope is the server's to derive`
      );
    }
    assert.ok(
      /cafeId/.test(signature) && /branchId/.test(signature) && /type/.test(signature),
      "it derives scope from tenant, branch and type alone"
    );
  });

  test("an item list smuggled into the argument object cannot narrow the scope", () => {
    // Behavioural backstop to the signature check: even if a caller forges
    // the extra property, the result is whatever the server derived — the
    // custodian's short item cannot be dropped from the count.
    const smuggled = {
      cafeId, branchId: branchA, type: "FULL" as const,
      inventoryItemIds: [itemIds["a-ordinary"]],
      items: [itemIds["a-ordinary"]],
    };
    return resolveCountScope(smuggled).then((r) => {
      assert.deepEqual(
        [...r.inventoryItemIds].sort(),
        [itemIds["a-critical"], itemIds["a-ordinary"]].sort(),
        "the forged list is not consulted"
      );
    });
  });
});
