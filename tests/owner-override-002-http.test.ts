// Owner override for discounts over HTTP: the POS order route and the invoice
// amendment route, with and without the code, and the audit rows they leave.
// Money is hand-derived from a 90.00 menu price (POS) and a 100.00 saved order
// (amendment), without tax or service.
import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { db, teardownTaggedCafe } from "./helpers/db";
import { countCafe, type CountCafe, COUNT_PASSWORD } from "./helpers/count";
import { as, requireServer } from "./helpers/http";

const CODE = "246810";
const FOREIGN_CODE = "135790";
const REFUSED = "Invalid owner override code or insufficient permissions";
const HEADER = "x-owner-override-code";

let fx: CountCafe;
let foreign: CountCafe;
let productId: string;
before(async () => {
  await requireServer();
  fx = await countCafe("OWNEROVR002");
  foreign = await countCafe("OWNEROVR002foreign");
  await db.cafeSettings.update({ where: { cafeId: fx.cafeId }, data: { inventoryEnforcementMode: "OVERRIDE_ALL" } });
  const category = await db.menuCategory.create({ data: { cafeId: fx.cafeId, name: "Override drinks" } });
  productId = (await db.product.create({ data: { cafeId: fx.cafeId, categoryId: category.id, name: "Override coffee", basePrice: 90 } })).id;
  for (const [cafe, code] of [[fx, CODE], [foreign, FOREIGN_CODE]] as const) {
    await db.ownerActionSettings.create({ data: { cafeId: cafe.cafeId, ownerId: cafe.owner.id } });
    const r = await as(cafe.owner.email, "/api/cafe/owner-action-settings", {
      method: "POST", body: JSON.stringify({ currentPassword: COUNT_PASSWORD, passcode: code }),
    });
    assert.equal(r.status, 200, r.text);
  }
});
after(() => teardownTaggedCafe([fx?.cafeId, foreign?.cafeId].filter(Boolean), [], { disconnect: true }));

function sale(email: string, code?: string, extra: Record<string, unknown> = {}, key?: string) {
  return as<{ order?: { id: string; total: string; discountAmount: string }; error?: string }>(email, "/api/orders", {
    method: "POST",
    headers: { ...(code ? { [HEADER]: code } : {}), ...(key ? { "Idempotency-Key": key } : {}) },
    body: JSON.stringify({ branchId: fx.branchId, type: "TAKEAWAY", collectionMode: "PENDING", discountAmount: 10, items: [{ productId, quantity: 1 }], ...extra }),
  });
}
async function discountKey(userId: string, allowed: boolean | null) {
  if (allowed === null) return db.userPermissionOverride.deleteMany({ where: { userId, permissionKey: "pos.apply_discount" } });
  await db.userPermissionOverride.upsert({ where: { userId_permissionKey: { userId, permissionKey: "pos.apply_discount" } },
    create: { userId, permissionKey: "pos.apply_discount", allowed }, update: { allowed } });
}
const orders = () => db.order.count({ where: { cafeId: fx.cafeId } });
const used = (where: Record<string, unknown> = {}) => db.auditLog.findMany({ where: { cafeId: fx.cafeId, action: "OWNER_OVERRIDE_USED", ...where }, orderBy: { createdAt: "asc" } });
async function assertNoCodeStored() {
  const rows = await db.auditLog.findMany({ where: { cafeId: fx.cafeId }, select: { details: true } });
  for (const row of rows) assert.doesNotMatch(JSON.stringify(row.details ?? null), new RegExp(`${CODE}|${FOREIGN_CODE}|passcodeHash`));
}

test("POS: without the discount key, no code keeps the existing refusal", async () => {
  await discountKey(fx.waiter.id, false);
  const count = await orders();
  const r = await sale(fx.waiter.email);
  assert.equal(r.status, 403, r.text);
  assert.notEqual(r.body.error, REFUSED, "no code: the original refusal, unchanged");
  assert.equal(await orders(), count);
  assert.equal(await db.auditLog.count({ where: { cafeId: fx.cafeId, userId: fx.waiter.id, action: "ORDER_DISCOUNT_REFUSED" } }), 1);
  assert.equal((await used()).length, 0);
});

test("POS: a wrong code, or another cafe's owner code, is refused and recorded as a failed attempt", async () => {
  const count = await orders();
  for (const code of ["999999", FOREIGN_CODE]) {
    const r = await sale(fx.waiter.email, code);
    assert.equal(r.status, 403, r.text);
    assert.equal(r.body.error, REFUSED);
    assert.doesNotMatch(r.text, new RegExp(code));
  }
  assert.equal(await orders(), count);
  assert.equal(await db.ownerPasscodeAttempt.count({ where: { cafeId: fx.cafeId, requesterId: fx.waiter.id, success: false } }), 2);
  assert.equal(await db.auditLog.count({ where: { cafeId: fx.cafeId, userId: fx.waiter.id, action: "OWNER_OVERRIDE_FAILED" } }), 2);
  assert.equal(await db.ownerPasscodeAttempt.count({ where: { cafeId: foreign.cafeId } }), 0, "the foreign cafe's credential is never consulted");
  assert.equal((await used()).length, 0);
});

test("POS: the owner code allows the discount, once, with an OWNER_OVERRIDE_USED audit row", async () => {
  const key = crypto.randomUUID();
  const r = await sale(fx.waiter.email, CODE, {}, key);
  assert.equal(r.status, 201, r.text);
  assert.equal(Number(r.body.order!.total), 80);
  assert.doesNotMatch(r.text, new RegExp(CODE));
  const replay = await sale(fx.waiter.email, CODE, {}, key);
  assert.equal(replay.status, 201, replay.text);
  assert.equal(replay.body.order!.id, r.body.order!.id);

  const rows = await used({ entityId: r.body.order!.id });
  assert.equal(rows.length, 1, "a replay does not record a second override");
  const details = rows[0].details as Record<string, unknown>;
  assert.equal(rows[0].userId, fx.waiter.id);
  assert.equal(details.userId, fx.waiter.id);
  assert.equal(details.invoiceId, r.body.order!.id);
  assert.ok(!Number.isNaN(Date.parse(String(details.timestamp))));
  assert.equal(details.ownerId, fx.owner.id);
  assert.equal(details.operation, "ORDER_CREATE");
  assert.deepEqual(details.reasons, ["DISCOUNT_PERMISSION", "DISCOUNT_LIMIT"]);
  assert.equal(details.discountAmount, "10.00");
  assert.equal(details.subtotal, "90.00");
  assert.equal(await db.auditLog.count({ where: { entityId: r.body.order!.id, action: "ORDER_DISCOUNT_APPLIED" } }), 1, "existing audit kept");
  assert.equal(await db.ownerPasscodeAttempt.count({ where: { cafeId: fx.cafeId, requesterId: fx.waiter.id, success: true } }), 1);
  await assertNoCodeStored();
});

test("POS: with the key but over the user's limit, the code replaces the limit refusal only", async () => {
  await discountKey(fx.waiter.id, true);
  await db.salesDiscountLimit.upsert({ where: { userId: fx.waiter.id },
    create: { userId: fx.waiter.id, cafeId: fx.cafeId, maxPercent: 50, maxAmount: 5, updatedById: fx.owner.id }, update: { maxPercent: 50, maxAmount: 5 } });
  const count = await orders();
  const refused = await sale(fx.waiter.email);
  assert.equal(refused.status, 403, refused.text);
  assert.notEqual(refused.body.error, REFUSED);
  assert.equal(await orders(), count);
  const within = await sale(fx.waiter.email, CODE, { discountAmount: 5 });
  assert.equal(within.status, 201, within.text);
  assert.equal((await used({ entityId: within.body.order!.id })).length, 0, "a code that was not needed is not recorded as used");
  const r = await sale(fx.waiter.email, CODE);
  assert.equal(r.status, 201, r.text);
  const rows = await used({ entityId: r.body.order!.id });
  assert.deepEqual((rows[0].details as { reasons: string[] }).reasons, ["DISCOUNT_LIMIT"]);
  await db.salesDiscountLimit.delete({ where: { userId: fx.waiter.id } });
  await discountKey(fx.waiter.id, false);
});

test("POS: a manager's discount needs no code and records no override", async () => {
  const r = await sale(fx.manager.email);
  assert.equal(r.status, 201, r.text);
  assert.equal((await used({ entityId: r.body.order!.id })).length, 0);
});

test("Amendment: a cashier without the discount key edits an invoice discount only with the code", async () => {
  await discountKey(fx.cashier.id, false);
  const shift = await db.shift.create({ data: { cafeId: fx.cafeId, branchId: fx.branchId, cashierId: fx.cashier.id, shiftNumber: 9001, openingCashAmount: 0 } });
  const order = await db.order.create({ data: {
    cafeId: fx.cafeId, branchId: fx.branchId, orderNumber: 99001, type: "TAKEAWAY", status: "SERVED", subtotal: 100, total: 100,
    paidAmount: 0, remainingAmount: 100, paymentStatus: "UNPAID", createdById: fx.cashier.id, saleShiftId: shift.id,
    taxRateSnapshot: 0, serviceRateSnapshot: 0, inventoryEnforcementMode: "OVERRIDE_ALL",
    items: { create: { productName: "Tea", unitPrice: 100, quantity: 1, lineTotal: 100, kitchenStatus: "SERVED" } },
  }, include: { items: true } });
  const input = { baseRevision: 0, reason: "Owner approved discount", invoiceDiscount: { type: "PERCENT", value: "10" },
    items: [{ id: order.items[0].id, quantity: 1, discount: { type: "NONE", value: "0" } }] };
  const call = (action: "preview" | "stage", code?: string, requestKey?: string) => as<{ proposed?: { discountAmount: string; ownerOverride?: { reasons: string[] } }; amendment?: { id: string; status: string; approvalRequired: boolean }; error?: string }>(
    fx.cashier.email, `/api/sales/${order.id}`, { method: "POST", headers: code ? { [HEADER]: code } : {}, body: JSON.stringify({ action, input, ...(requestKey ? { requestKey } : {}) }) });

  const noCode = await call("preview");
  assert.equal(noCode.status, 403, noCode.text);
  assert.notEqual(noCode.body.error, REFUSED);
  const wrong = await call("stage", "999998", crypto.randomUUID());
  assert.equal(wrong.status, 403, wrong.text);
  assert.equal(wrong.body.error, REFUSED);
  assert.equal(await db.orderAmendment.count({ where: { orderId: order.id } }), 0);

  const preview = await call("preview", CODE);
  assert.equal(preview.status, 200, preview.text);
  assert.equal(preview.body.proposed!.discountAmount, "10.00");
  assert.equal((await used({ entityId: order.id })).length, 0, "a preview records no override");

  const staged = await call("stage", CODE, crypto.randomUUID());
  assert.equal(staged.status, 200, staged.text);
  assert.equal(staged.body.amendment!.status, "READY", "the code replaces the manager approval for the discount limit");
  assert.equal(staged.body.amendment!.approvalRequired, false);
  const amendment = await db.orderAmendment.findUniqueOrThrow({ where: { id: staged.body.amendment!.id } });
  assert.doesNotMatch(JSON.stringify(amendment), new RegExp(CODE));
  const rows = await used({ entityId: order.id });
  assert.equal(rows.length, 1);
  const details = rows[0].details as Record<string, unknown>;
  assert.equal(details.userId, fx.cashier.id);
  assert.equal(details.invoiceId, order.id);
  assert.equal(details.amendmentId, amendment.id);
  assert.equal(details.operation, "ORDER_AMENDMENT");
  assert.deepEqual(details.reasons, ["DISCOUNT_PERMISSION", "DISCOUNT_LIMIT"]);
  assert.equal(details.discountAmount, "10.00");

  const commit = await as(fx.cashier.email, `/api/sales/amendments/${amendment.id}`, { method: "POST", body: JSON.stringify({ action: "commit" }) });
  assert.equal(commit.status, 200, commit.text);
  const fresh = await db.order.findUniqueOrThrow({ where: { id: order.id } });
  assert.equal(fresh.total.toString(), "90");
  assert.equal(fresh.revision, 1);
  assert.equal(await db.auditLog.count({ where: { entityId: order.id, action: "AMENDMENT_STAGED" } }), 1, "existing amendment audit kept");
  await assertNoCodeStored();
});

test("POS: repeated wrong codes lock the override, even for the right code", async () => {
  const failures = () => db.ownerPasscodeAttempt.count({ where: { cafeId: fx.cafeId, requesterId: fx.waiter.id, success: false } });
  while (await failures() < 5) assert.equal((await sale(fx.waiter.email, "111111")).status, 403);
  const count = await orders();
  const locked = await sale(fx.waiter.email, CODE);
  assert.equal(locked.status, 429, locked.text);
  assert.equal(await orders(), count);
  assert.equal(await failures(), 5, "a locked attempt is not compared and not counted");
  await assertNoCodeStored();
});
