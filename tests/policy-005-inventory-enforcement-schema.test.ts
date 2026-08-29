// POLICY-005 — one authoritative inventory-enforcement policy per café.
//
// `Cafe.allowNegativeStock` answered one question with a boolean: may stock go
// below zero? That was enough while there were two behaviours. There are three:
//
//   STRICT                 refuse a sale we cannot make
//   ALLOW_NEGATIVE_STOCK   a KNOWN shortage is the owner's call; the recipe
//                          must still be readable
//   OVERRIDE_ALL           sell anyway, and be honest that consumption is
//                          partly unknown
//
// A boolean cannot express the third, and the distinction it cannot express is
// the important one: negative stock is permission to go below a balance we can
// compute, while an unreadable recipe is an unknown draw on the shelf. Those
// are different risks and the owner should be able to accept one without the
// other.
//
// The policy belongs on CafeSettings, where every other operational policy of
// this kind already lives — serving policy, count policy, variance policy —
// rather than on Cafe, where the boolean was the odd one out.
//
// This suite pins the SHAPE. Behaviour is POLICY-006/007/008.
//
// The migration must preserve what each café already does. `false` becomes
// STRICT and `true` becomes ALLOW_NEGATIVE_STOCK; nothing is silently promoted
// to OVERRIDE_ALL, because no café has ever agreed to sell against a recipe
// nobody has written.

import { test, after, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { db, tag, teardownTaggedCafe } from "./helpers/db";

const created: string[] = [];
after(() => teardownTaggedCafe(created, [], { disconnect: true }));

/** A café this suite owns, with its settings row. */
async function taggedCafe(finding: string) {
  const marker = tag(finding);
  const cafe = await db.cafe.create({
    data: {
      name: `${marker} cafe`,
      slug: marker.toLowerCase(),
      settings: { create: {} },
      branches: { create: [{ name: `${marker} main` }] },
    },
    include: { settings: true },
  });
  created.push(cafe.id);
  return cafe;
}

describe("POLICY-005 the inventory enforcement policy has a home", () => {
  test("the enum offers exactly the three modes, and nothing else", async () => {
    const rows = await db.$queryRaw<{ label: string }[]>`
      SELECT e.enumlabel AS label
        FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
       WHERE t.typname = 'InventoryEnforcementMode'
       ORDER BY e.enumsortorder
    `;
    assert.deepEqual(
      rows.map((r) => r.label),
      ["STRICT", "ALLOW_NEGATIVE_STOCK", "OVERRIDE_ALL"],
      "a fourth mode is a business decision, not a column value somebody added"
    );
  });

  test("a NEW café defaults to STRICT", async () => {
    // The safe end of the range. A café that has expressed no opinion is not
    // opted in to selling stock it does not have, and certainly not to selling
    // against a recipe nobody has written.
    const cafe = await taggedCafe("POL005-default");
    assert.equal(cafe.settings?.inventoryEnforcementMode, "STRICT");
  });

  test("the mode is settable to each of the three values", async () => {
    const cafe = await taggedCafe("POL005-set");
    for (const mode of ["ALLOW_NEGATIVE_STOCK", "OVERRIDE_ALL", "STRICT"] as const) {
      const updated = await db.cafeSettings.update({
        where: { cafeId: cafe.id },
        data: { inventoryEnforcementMode: mode },
      });
      assert.equal(updated.inventoryEnforcementMode, mode);
    }
  });

  test("the migration maps the old boolean, and promotes nobody to OVERRIDE_ALL", () => {
    // Read as text rather than executed: the assertion is about what the
    // migration COMMITS TO, and that has to stay true for every café that
    // runs it later, not just for the one database this suite touches.
    const sql = readFileSync(
      "prisma/migrations/20260829100000_inventory_enforcement_mode/migration.sql",
      "utf8"
    );
    assert.match(sql, /allowNegativeStock"?\s*=\s*(true|TRUE)/,
      "the backfill must read the old boolean");
    assert.match(sql, /ALLOW_NEGATIVE_STOCK/,
      "true must become ALLOW_NEGATIVE_STOCK");
    assert.match(sql, /'STRICT'/, "false must become STRICT");
    assert.ok(
      !/UPDATE[\s\S]*=\s*'OVERRIDE_ALL'/.test(sql),
      "no existing café may be migrated into OVERRIDE_ALL — nobody has agreed to it"
    );
  });

  test("nothing in src/ still reads the deprecated boolean", () => {
    // The boolean survives this migration so the change is not destructive,
    // but it is no longer the truth. Two fields that could disagree is exactly
    // the contradictory state worth preventing, so the guard is that the
    // application reads only one of them. (LEDGER-002 pins its single writer
    // the same way — by reading the source tree.)
    // Comments are stripped first. A module that EXPLAINS what the boolean
    // used to do is documentation, not a second source of truth; the thing
    // worth catching is code that still reads it.
    const stripComments = (src: string) =>
      src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*/g, "");

    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = `${dir}/${entry.name}`;
        if (entry.isDirectory()) walk(p);
        else if (/\.tsx?$/.test(entry.name)) {
          if (stripComments(readFileSync(p, "utf8")).includes("allowNegativeStock")) {
            offenders.push(p);
          }
        }
      }
    };
    walk("src");
    assert.deepEqual(
      offenders, [],
      "CafeSettings.inventoryEnforcementMode is the only authoritative policy"
    );
  });
});
