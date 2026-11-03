import { test } from "node:test";
import assert from "node:assert/strict";
import { purchaseFormPreview, purchaseLine, purchaseTotals, purchaseSubtotal } from "@/lib/purchase-arithmetic";

const line = (quantity: string, unitCost: string, inventoryItemId = "item") => ({ inventoryItemId, quantity, unitCost });
const create = (lines: ReturnType<typeof line>[], discount = "", tax = "", mode: "UNPAID" | "PARTIAL" | "PAID" = "UNPAID", amount = "") =>
  purchaseFormPreview({ lines, discount, tax, payment: { mode, amount } });

test("form preview shows the writers' own line total and totals", () => {
  const p = create([line("0.5", "2.01")], "0.11", "0.25", "PARTIAL", "0.40");
  assert.equal(p.valid, true);
  assert.equal(p.lines[0].totalCost, purchaseLine(0.5, 2.01).totalCost);
  assert.equal(p.lines[0].totalCost, 1.01);
  assert.deepEqual(p.summary, purchaseTotals(purchaseSubtotal([{ totalCost: 1.01 }]), 0.11, 0.25, 0.4, true));
  assert.deepEqual(p.summary, { subtotal: 1.01, discount: 0.11, tax: 0.25, total: 1.15, paid: 0.4, remaining: 0.75 });
  assert.equal(p.paymentAmount, 0.4);
});

test("blank, over-precise and out-of-range inputs are attributed to their own field", () => {
  assert.match(create([line("2", "")]).lines[0].errors.unitCost ?? "", /أدخل تكلفة الوحدة/);
  assert.equal(create([line("2", "")]).lines[0].errors.quantity, undefined);
  assert.match(create([line("2", "1.005")]).lines[0].errors.unitCost ?? "", /منزلتين/);
  const blankQuantity = create([line("", "1")]).lines[0].errors;
  assert.match(blankQuantity.quantity ?? "", /أدخل الكمية/);
  assert.doesNotMatch(blankQuantity.quantity ?? "", /الصفر/);
  assert.ok(create([line("0", "1")]).lines[0].errors.quantity);
  assert.equal(create([line("1", "1", "")]).lines[0].errors.item !== undefined, true);
  assert.equal(create([line("2", "1.005")]).valid, false);
  assert.equal(create([line("2", "1.005")]).summary, null);
});

test("explicit zero cost is accepted", () => {
  const p = create([line("2", "0")]);
  assert.equal(p.valid, true);
  assert.equal(p.summary?.total, 0);
});

test("discount above the invoice is a discount error; bad charges name their field", () => {
  const p = create([line("1", "1")], "5");
  assert.ok(p.errors.discount);
  assert.equal(p.valid, false);
  assert.ok(create([line("1", "1")], "-1").errors.discount);
  assert.ok(create([line("1", "1")], "", "abc").errors.tax);
});

test("initial payment follows the creation rules: clamp to total, refuse zero", () => {
  const over = create([line("1", "1.01")], "", "", "PARTIAL", "100");
  assert.equal(over.valid, true);
  assert.equal(over.clamped, true);
  assert.equal(over.summary?.paid, 1.01);
  assert.equal(over.summary?.remaining, 0);
  assert.ok(create([line("1", "1")], "", "", "PARTIAL", "").errors.payment);
  assert.ok(create([line("1", "1")], "", "", "PARTIAL", "0").errors.payment);
  assert.ok(create([line("1", "0")], "", "", "PAID").errors.payment); // nothing to pay on a zero invoice
  const paid = create([line("1", "1.01")], "", "", "PAID");
  assert.deepEqual([paid.summary?.paid, paid.summary?.remaining, paid.paymentAmount], [1.01, 0, 1.01]);
});

test("editing keeps recorded payments, even above a lowered total", () => {
  const p = purchaseFormPreview({ lines: [line("1", "1")], discount: "", tax: "", payment: { recorded: 0.4 } });
  assert.deepEqual(p.summary, { subtotal: 1, discount: 0, tax: 0, total: 1, paid: 0.4, remaining: 0.6 });
  const lowered = purchaseFormPreview({ lines: [line("1", "0.3")], discount: "", tax: "", payment: { recorded: 0.4 } });
  assert.equal(lowered.valid, true);
  assert.deepEqual([lowered.summary?.total, lowered.summary?.paid, lowered.summary?.remaining], [0.3, 0.4, 0]);
});

test("an empty form is invalid with a message, not a thrown error", () => {
  const p = purchaseFormPreview({ lines: [], discount: "", tax: "", payment: { mode: "UNPAID", amount: "" } });
  assert.equal(p.valid, false);
  assert.ok(p.errors.summary);
});

// ── Draft editor: an item the ordinary picker no longer offers ─────────────────
import { retainedLineItem, type PickerItem } from "@/lib/purchases";

const archived: PickerItem = { id: "archived", name: "خامة مؤرشفة", unit: "KG" };
const live: PickerItem = { id: "live", name: "خامة متاحة", unit: "KG" };

test("an archived line item stays visible for its own line without joining the picker", () => {
  const retained = { archived };
  assert.deepEqual(retainedLineItem([live], "archived", retained), archived);
  assert.equal(retainedLineItem([live], "live", retained), null); // available items need no extra option
  assert.equal(retainedLineItem([live], "", retained), null); // an empty line offers nothing
  assert.equal(retainedLineItem([live], "other", retained), null); // other items are never added
  assert.equal(retainedLineItem([], "archived", retained), archived); // still shown while the list is loading or failed
  assert.equal(retainedLineItem([live, archived], "archived", retained), null); // once offered normally, no duplicate
});

test("keeping the archived item preserves identity and every financial value on an unrelated edit", () => {
  // The editor loads the stored strings and the item id unchanged; notes are not part of the preview.
  const lines = [{ inventoryItemId: "archived", quantity: "2", unitCost: "1.5" }];
  const p = purchaseFormPreview({ lines, discount: "", tax: "", payment: { recorded: 1 } });
  assert.equal(p.valid, true);
  assert.deepEqual(p.summary, { subtotal: 3, discount: 0, tax: 0, total: 3, paid: 1, remaining: 2 });
  assert.deepEqual(p.lines[0].errors, {});
});
