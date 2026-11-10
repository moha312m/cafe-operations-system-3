import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { aggregatePrepItems, type OrderWithItems } from "../src/components/kds/kds-prep-summary";

describe("KDS All-Day Prep Summary Aggregation", () => {
  test("aggregates identical items across multiple CONFIRMED and PREPARING orders", () => {
    const orders: OrderWithItems[] = [
      {
        id: "ord-1",
        orderNumber: 101,
        status: "CONFIRMED",
        items: [
          { id: "it-1", productName: "فلات وايت", variantName: null, quantity: 2 },
          { id: "it-2", productName: "كرواسون زبدة", variantName: null, quantity: 1 },
        ],
      },
      {
        id: "ord-2",
        orderNumber: 102,
        status: "PREPARING",
        items: [
          { id: "it-3", productName: "فلات وايت", variantName: null, quantity: 1 },
          { id: "it-4", productName: "سبانش لاتيه", variantName: "بارد", quantity: 3 },
        ],
      },
      {
        id: "ord-3",
        orderNumber: 103,
        status: "READY", // should be ignored (already prepared)
        items: [
          { id: "it-5", productName: "فلات وايت", variantName: null, quantity: 5 },
        ],
      },
      {
        id: "ord-4",
        orderNumber: 104,
        status: "CONFIRMED",
        items: [
          { id: "it-6", productName: "كرواسون زبدة", variantName: null, quantity: 2 },
        ],
      },
    ];

    const summary = aggregatePrepItems(orders);

    assert.equal(summary.length, 3, "should aggregate into 3 distinct items");

    // 1. فلات وايت: 2 from ord-1 (new) + 1 from ord-2 (prep) = 3 total
    const flatWhite = summary.find((s) => s.name === "فلات وايت");
    assert.ok(flatWhite, "flat white should exist");
    assert.equal(flatWhite.totalQuantity, 3);
    assert.equal(flatWhite.inNewCount, 2);
    assert.equal(flatWhite.inPrepCount, 1);
    assert.deepEqual(flatWhite.orderNumbers, [101, 102]);

    // 2. كرواسون زبدة: 1 from ord-1 + 2 from ord-4 = 3 total
    const croissant = summary.find((s) => s.name === "كرواسون زبدة");
    assert.ok(croissant, "croissant should exist");
    assert.equal(croissant.totalQuantity, 3);
    assert.equal(croissant.inNewCount, 3);
    assert.equal(croissant.inPrepCount, 0);
    assert.deepEqual(croissant.orderNumbers, [101, 104]);

    // 3. سبانش لاتيه (بارد): 3 from ord-2
    const spanishLatte = summary.find((s) => s.name === "سبانش لاتيه" && s.variantName === "بارد");
    assert.ok(spanishLatte, "spanish latte iced should exist");
    assert.equal(spanishLatte.totalQuantity, 3);
    assert.equal(spanishLatte.inPrepCount, 3);
    assert.deepEqual(spanishLatte.orderNumbers, [102]);
  });

  test("returns empty array when there are no active orders or all are READY/SERVED", () => {
    const orders: OrderWithItems[] = [
      {
        id: "ord-1",
        orderNumber: 201,
        status: "READY",
        items: [{ id: "it-1", productName: "أمريكانو", variantName: null, quantity: 1 }],
      },
      {
        id: "ord-2",
        orderNumber: 202,
        status: "SERVED",
        items: [{ id: "it-2", productName: "كابتشينو", variantName: null, quantity: 2 }],
      },
    ];

    const summary = aggregatePrepItems(orders);
    assert.equal(summary.length, 0, "should return empty array");
  });
});
