import assert from "node:assert/strict";
import test from "node:test";
import { branchRegisterPreferences, registerOrderType, pickupAtCashier } from "../src/lib/branch-register-preferences";

test("branch settings accept only the supported new-sale defaults", () => {
  assert.deepEqual(branchRegisterPreferences.parse({ posDefaultOrderType: "TAKEAWAY", pickupAtCashier: true }), {
    posDefaultOrderType: "TAKEAWAY",
    pickupAtCashier: true,
  });
  assert.deepEqual(branchRegisterPreferences.parse({}), {});
  assert.equal(branchRegisterPreferences.safeParse({ posDefaultOrderType: "DELIVERY" }).success, false);
  assert.equal(branchRegisterPreferences.safeParse({ pickupAtCashier: "false" }).success, false);
});

test("new sales use the branch default and explicit choices survive it", () => {
  assert.equal(registerOrderType(null, undefined), "DINE_IN");
  assert.equal(registerOrderType(null, "TAKEAWAY"), "TAKEAWAY");
  assert.equal(registerOrderType("DINE_IN", "TAKEAWAY"), "DINE_IN");
  assert.equal(registerOrderType("DELIVERY", "DINE_IN"), "DELIVERY");
});

test("only takeaway orders at an opted-in branch get the cashier instruction", () => {
  assert.equal(pickupAtCashier(true, "TAKEAWAY"), true);
  assert.equal(pickupAtCashier(true, "DINE_IN"), false);
  assert.equal(pickupAtCashier(true, "DELIVERY"), false);
  assert.equal(pickupAtCashier(false, "TAKEAWAY"), false);
});
