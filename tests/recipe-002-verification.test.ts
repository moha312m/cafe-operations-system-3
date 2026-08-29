// RECIPE-002 — a recipe is trusted only when the system AND a person say so.
//
// Structural validation can tell you an ingredient exists, a quantity is
// positive and a unit converts. It cannot tell you that 18 g is what this
// café actually puts in the cup. Only somebody who works there knows that, so
// VERIFIED needs both halves: validation that passes, and a confirmation from
// a user authorised to give it.
//
// Neither half is optional. A tidy-looking recipe nobody has confirmed is
// still a proposal, and a confirmation sitting on a recipe that has since been
// edited is describing something that no longer exists — so a material edit
// retires the confirmation rather than carrying it forward.
//
// Who may confirm is a capability, never a job title. A one-person café where
// the owner edits and confirms is a legitimate setup, not a control to design
// around; a large café can still split the two across people.

import { test, after, before, describe } from "node:test";
import assert from "node:assert/strict";
import {
  resolveAddOnRecipe, theoreticalConsumption,
  sellableGate, isEligibleForVarianceCosting, recipeFingerprint, RecipeIssue,
} from "@/lib/recipes";
import { db, fixture, testIngredients, cleanupIngredients } from "./helpers/db";
import { requireServer, login, as } from "./helpers/http";

const OWNER = "owner@demo.com", MANAGER = "manager@demo.com", BARISTA = "kitchen@demo.com";

after(async () => { await db.$disconnect(); });
before(async () => {
  await requireServer();
  await login(OWNER, "owner1234");
  await login(MANAGER, "manager123");
  await login(BARISTA, "kitchen123");
});

async function scaffold(tag: string) {
  const fx = await fixture();
  const cat = await db.menuCategory.findFirstOrThrow({ where: { cafeId: fx.cafeId } });
  // Ingredients the test owns, so verification is exercised against quantities
  // it declared rather than against whatever the café happens to stock.
  const { beans, milk } = await testIngredients(fx, tag);
  const product = await db.product.create({
    data: {
      cafeId: fx.cafeId, categoryId: cat.id, name: `${tag} drink`, basePrice: 50,
      variants: { create: [{ name: "Small", price: 40 }, { name: "Large", price: 70 }] },
    },
    include: { variants: { orderBy: { price: "asc" } } },
  });
  const addOn = await db.addOn.create({
    data: { cafeId: fx.cafeId, name: `${tag} extra shot`, price: 10 },
  });
  return { fx, product, small: product.variants[0], large: product.variants[1], beans, milk, addOn };
}
type Ctx = Awaited<ReturnType<typeof scaffold>>;
async function teardown(c: Ctx) {
  await db.recipe.deleteMany({ where: { OR: [{ productId: c.product.id }, { addOnId: c.addOn.id }] } });
  await db.product.delete({ where: { id: c.product.id } });
  await db.addOn.delete({ where: { id: c.addOn.id } });
  await cleanupIngredients({ beans: c.beans, milk: c.milk });
}

/** A recipe plus a confirmation that matches it — i.e. genuinely VERIFIED. */
async function confirmedRecipe(
  c: Ctx,
  scope: { variantId?: string; addOnId?: string },
  items: { inventoryItemId: string; quantity: number; unit: "GRAM" | "ML" }[],
  byUserId: string
) {
  const r = await db.recipe.create({
    data: {
      cafeId: c.fx.cafeId,
      productId: scope.addOnId ? null : c.product.id,
      variantId: scope.variantId ?? null,
      addOnId: scope.addOnId ?? null,
      items: { create: items },
    },
    include: { items: true },
  });
  return db.recipe.update({
    where: { id: r.id },
    data: {
      verifiedById: byUserId,
      verifiedAt: new Date(),
      verifiedFingerprint: recipeFingerprint(r.items),
    },
  });
}

describe("RECIPE-002 verification and eligibility", () => {
  // ── V + W: both halves are required ──
  test("V: a structurally sound but unconfirmed recipe is not VERIFIED", async () => {
    const c = await scaffold("R2V");
    try {
      await db.recipe.create({
        data: {
          cafeId: c.fx.cafeId, productId: c.product.id, variantId: c.small.id,
          items: { create: [{ inventoryItemId: c.beans.id, quantity: 18, unit: "GRAM" }] },
        },
      });
      const g = await sellableGate(c.product.id, c.small.id);
      assert.equal(g.structurallyValid, true, "nothing is wrong with the numbers");
      assert.equal(g.confirmed, false);
      assert.equal(g.status, "INCOMPLETE", "but nobody has said this is the real recipe");
      assert.ok(g.issues.includes(RecipeIssue.NOT_CONFIRMED));
    } finally { await teardown(c); }
  });

  test("W+Y+Z: a confirmed sound recipe is VERIFIED and records who said so", async () => {
    const c = await scaffold("R2W");
    const owner = await db.user.findFirstOrThrow({ where: { email: OWNER } });
    try {
      await confirmedRecipe(c, { variantId: c.small.id },
        [{ inventoryItemId: c.beans.id, quantity: 18, unit: "GRAM" }], owner.id);
      const g = await sellableGate(c.product.id, c.small.id);
      assert.equal(g.status, "VERIFIED");
      assert.equal(g.verifiedById, owner.id, "the actual user, not a job title");
      assert.ok(g.verifiedAt instanceof Date);
    } finally { await teardown(c); }
  });

  // ── X: an edit retires the confirmation ──
  test("X: changing a quantity invalidates the earlier confirmation", async () => {
    const c = await scaffold("R2X");
    const owner = await db.user.findFirstOrThrow({ where: { email: OWNER } });
    try {
      const r = await confirmedRecipe(c, { variantId: c.small.id },
        [{ inventoryItemId: c.beans.id, quantity: 18, unit: "GRAM" }], owner.id);
      assert.equal((await sellableGate(c.product.id, c.small.id)).status, "VERIFIED");

      // Someone changes the dose. The old sign-off described 18 g.
      await db.recipeItem.updateMany({ where: { recipeId: r.id }, data: { quantity: 25 } });

      const after = await sellableGate(c.product.id, c.small.id);
      assert.equal(after.status, "INCOMPLETE", "the confirmation no longer describes this recipe");
      assert.ok(after.issues.includes(RecipeIssue.STALE_CONFIRMATION));
      assert.notEqual(after.verifiedAt, null, "the old confirmation is retained for audit, just not honoured");
    } finally { await teardown(c); }
  });

  test("a confirmation is also retired when the default is re-scoped to all variants", async () => {
    const c = await scaffold("R2SCOPE");
    const owner = await db.user.findFirstOrThrow({ where: { email: OWNER } });
    try {
      const r = await confirmedRecipe(c, {},
        [{ inventoryItemId: c.beans.id, quantity: 18, unit: "GRAM" }], owner.id);
      // Declaring it covers every size is a material change: it now claims
      // something about drinks it was never confirmed against.
      await db.recipe.update({ where: { id: r.id }, data: { appliesToAllVariants: true } });
      const g = await sellableGate(c.product.id, c.large.id);
      assert.notEqual(g.status, "VERIFIED");
      assert.ok(g.issues.includes(RecipeIssue.STALE_CONFIRMATION));
    } finally { await teardown(c); }
  });

  // ── NOT_APPLICABLE is a decision, never an absence ──
  test("C+D: a missing recipe is INCOMPLETE; NOT_APPLICABLE must be chosen", async () => {
    const c = await scaffold("R2NA");
    try {
      const missing = await sellableGate(c.product.id, c.small.id);
      assert.equal(missing.status, "INCOMPLETE");
      assert.notEqual(missing.status, "NOT_APPLICABLE", "absence is not a decision");

      await db.recipe.create({
        data: {
          cafeId: c.fx.cafeId, productId: c.product.id, variantId: c.small.id,
          notApplicable: true, notApplicableReason: "bottled water — nothing to prepare",
        },
      });
      const declared = await sellableGate(c.product.id, c.small.id);
      assert.equal(declared.status, "NOT_APPLICABLE");
    } finally { await teardown(c); }
  });

  // ── J + K + L + M: add-ons ──
  test("J+L: an add-on adds its ingredients, merging with the base", async () => {
    const c = await scaffold("R2J");
    const owner = await db.user.findFirstOrThrow({ where: { email: OWNER } });
    try {
      await confirmedRecipe(c, { variantId: c.small.id }, [
        { inventoryItemId: c.beans.id, quantity: 18, unit: "GRAM" },
        { inventoryItemId: c.milk.id, quantity: 150, unit: "ML" },
      ], owner.id);
      // The extra shot is more of the same beans.
      await confirmedRecipe(c, { addOnId: c.addOn.id },
        [{ inventoryItemId: c.beans.id, quantity: 9, unit: "GRAM" }], owner.id);

      const t = await theoreticalConsumption({
        productId: c.product.id, variantId: c.small.id, addOnIds: [c.addOn.id], quantity: 1,
      });
      const beans = t.lines.find((l) => l.inventoryItemId === c.beans.id)!;
      assert.equal(beans.quantityInStockUnit, 0.027, "18 g + 9 g = 27 g = 0.027 kg, one line not two");
      assert.equal(t.lines.length, 2, "beans merged; milk separate");
      assert.equal(t.complete, true);
    } finally { await teardown(c); }
  });

  test("M+AG: an add-on with no recipe blocks variance eligibility", async () => {
    const c = await scaffold("R2M");
    const owner = await db.user.findFirstOrThrow({ where: { email: OWNER } });
    try {
      await confirmedRecipe(c, { variantId: c.small.id },
        [{ inventoryItemId: c.beans.id, quantity: 18, unit: "GRAM" }], owner.id);
      // The drink itself is fully verified...
      assert.equal((await sellableGate(c.product.id, c.small.id)).status, "VERIFIED");

      // ...but nobody has said what the extra shot costs in beans.
      const e = await isEligibleForVarianceCosting({
        productId: c.product.id, variantId: c.small.id, addOnIds: [c.addOn.id],
      });
      assert.equal(e.eligible, false, "the consumption is not fully known, so no money may rest on it");
      assert.ok(e.issues.includes(RecipeIssue.MISSING_ADDON_RECIPE));

      const a = await resolveAddOnRecipe(c.addOn.id);
      assert.equal(a.source, "NONE");
    } finally { await teardown(c); }
  });

  // ── AE + AF + AH: eligibility ──
  test("AE+AF+AH: only a verified configuration may carry variance", async () => {
    const c = await scaffold("R2AE");
    const owner = await db.user.findFirstOrThrow({ where: { email: OWNER } });
    try {
      await confirmedRecipe(c, { variantId: c.small.id },
        [{ inventoryItemId: c.beans.id, quantity: 18, unit: "GRAM" }], owner.id);

      const ok = await isEligibleForVarianceCosting({ productId: c.product.id, variantId: c.small.id });
      assert.equal(ok.eligible, true, "AE: verified");

      const bad = await isEligibleForVarianceCosting({ productId: c.product.id, variantId: c.large.id });
      assert.equal(bad.eligible, false, "AF: the large was never configured");

      // AH: "nothing to measure" is not "measured and correct".
      await db.recipe.create({
        data: {
          cafeId: c.fx.cafeId, productId: c.product.id, variantId: c.large.id,
          notApplicable: true, notApplicableReason: "no ingredients",
        },
      });
      const na = await isEligibleForVarianceCosting({ productId: c.product.id, variantId: c.large.id });
      assert.equal(na.eligible, false, "AH: not applicable is not eligible for ingredient variance");
    } finally { await teardown(c); }
  });

  // ── AA + AB + AC + AD: capability, not job title ──
  test("AA+AB: a barista cannot edit or confirm a recipe by default", async () => {
    const c = await scaffold("R2AA");
    try {
      const r = await db.recipe.create({
        data: {
          cafeId: c.fx.cafeId, productId: c.product.id, variantId: c.small.id,
          items: { create: [{ inventoryItemId: c.beans.id, quantity: 18, unit: "GRAM" }] },
        },
      });
      const edit = await as(BARISTA, `/api/recipes/${r.id}`, {
        method: "PUT",
        body: JSON.stringify({ items: [{ inventoryItemId: c.beans.id, quantity: 99, unit: "GRAM" }] }),
      });
      assert.equal(edit.status, 403, `barista must not edit, got ${edit.status}`);

      const verify = await as(BARISTA, `/api/recipes/${r.id}/verify`, { method: "POST", body: "{}" });
      assert.equal(verify.status, 403, `barista must not confirm, got ${verify.status}`);

      const still = await db.recipe.findUniqueOrThrow({ where: { id: r.id }, include: { items: true } });
      assert.equal(Number(still.items[0].quantity), 18, "the refused edit wrote nothing");
      assert.equal(still.verifiedAt, null);
    } finally { await teardown(c); }
  });

  test("AC+Z: an authorised user may both edit and confirm — one-person cafés are normal", async () => {
    const c = await scaffold("R2AC");
    try {
      const r = await db.recipe.create({
        data: {
          cafeId: c.fx.cafeId, productId: c.product.id, variantId: c.small.id,
          items: { create: [{ inventoryItemId: c.beans.id, quantity: 18, unit: "GRAM" }] },
        },
      });
      const edit = await as(OWNER, `/api/recipes/${r.id}`, {
        method: "PUT",
        body: JSON.stringify({ items: [{ inventoryItemId: c.beans.id, quantity: 20, unit: "GRAM" }] }),
      });
      assert.ok(edit.status < 300, `owner may edit: ${edit.text.slice(0, 140)}`);

      // Same person confirms. No separation of duties is imposed.
      const verify = await as(OWNER, `/api/recipes/${r.id}/verify`, { method: "POST", body: "{}" });
      assert.ok(verify.status < 300, `same user may confirm: ${verify.text.slice(0, 140)}`);

      const g = await sellableGate(c.product.id, c.small.id);
      assert.equal(g.status, "VERIFIED");
      const owner = await db.user.findFirstOrThrow({ where: { email: OWNER } });
      assert.equal(g.verifiedById, owner.id);
    } finally { await teardown(c); }
  });

  test("confirming a structurally broken recipe is refused", async () => {
    const c = await scaffold("R2BROKEN");
    try {
      const r = await db.recipe.create({
        data: {
          cafeId: c.fx.cafeId, productId: c.product.id, variantId: c.small.id,
          // beans are a mass; millilitres of them mean nothing.
          items: { create: [{ inventoryItemId: c.beans.id, quantity: 18, unit: "ML" }] },
        },
      });
      const verify = await as(OWNER, `/api/recipes/${r.id}/verify`, { method: "POST", body: "{}" });
      assert.ok(verify.status >= 400, "a signature cannot repair an invalid recipe");
      const still = await db.recipe.findUniqueOrThrow({ where: { id: r.id } });
      assert.equal(still.verifiedAt, null);
    } finally { await teardown(c); }
  });

  test("AD: another café's recipe is not reachable", async () => {
    const other = await db.cafe.create({
      data: { name: "R2AD other", slug: `r2ad-${Date.now()}` },
    });
    try {
      const cat = await db.menuCategory.create({ data: { cafeId: other.id, name: "c" } });
      const p = await db.product.create({
        data: { cafeId: other.id, categoryId: cat.id, name: "theirs", basePrice: 10 },
      });
      const r = await db.recipe.create({ data: { cafeId: other.id, productId: p.id } });
      const res = await as(OWNER, `/api/recipes/${r.id}/verify`, { method: "POST", body: "{}" });
      assert.equal(res.status, 403, `cross-tenant must be refused, got ${res.status}`);
    } finally {
      await db.cafe.delete({ where: { id: other.id } });
    }
  });
});
