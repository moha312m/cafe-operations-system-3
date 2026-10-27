// OPS-002 — faster till: best sellers this hour, repeat last order, collect & serve.
//
//   • /api/pos/quick-picks ranks what THIS branch sold around this hour of
//     the day over the last 14 days. Cancelled orders and cancelled lines do
//     not count; when the hour is too quiet it falls back to the whole day.
//   • /api/customers/last-order returns the items of the customer's last
//     live order so the till can rebuild the cart at today's prices.
//   • "Collect & serve" is two ordinary requests (payment, then status), so
//     no payment or serving rule is bypassed; the till only offers it on a
//     READY order to someone allowed to change order status.

import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { db, teardownTaggedCafe } from "./helpers/db";
import { countCafe, type CountCafe } from "./helpers/count";
import { as, requireServer } from "./helpers/http";

let fx: CountCafe;
const HOUR = 3_600_000;
const ago = (ms: number) => new Date(Date.now() - ms);
const products: Record<string, string> = {};

type Picks = { window: "HOUR" | "ALL_DAY"; hour: number; products: { productId: string; quantity: number }[] };
type LastOrder = {
  order: null | {
    orderNumber: number;
    customerName: string | null;
    items: Array<{
      productId: string; variantId: string | null; productName: string; variantName: string | null;
      quantity: number; notes: string | null; addOnIds: string[];
    }>;
  };
};

async function sale(lines: Array<{ product: string; quantity: number; cancelled?: boolean; variantId?: string; addOnId?: string; notes?: string }>, opts: {
  createdAt?: Date;
  status?: "CONFIRMED" | "SERVED" | "CANCELLED" | "REJECTED";
  branchId?: string;
  customerId?: string;
} = {}) {
  const branchId = opts.branchId ?? fx.branchId;
  const last = await db.order.aggregate({ where: { branchId }, _max: { orderNumber: true } });
  return db.order.create({
    data: {
      cafeId: fx.cafeId, branchId,
      orderNumber: (last._max.orderNumber ?? 0) + 1,
      type: "TAKEAWAY", status: opts.status ?? "SERVED", source: "CASHIER_POS",
      customerName: fx.marker,
      customerId: opts.customerId,
      subtotal: 10, total: 10, paidAmount: 10, remainingAmount: 0, paymentStatus: "PAID",
      createdAt: opts.createdAt,
      createdById: fx.cashier.id,
      items: {
        create: lines.map((l) => ({
          productId: products[l.product],
          variantId: l.variantId,
          productName: `${fx.marker} ${l.product}`,
          unitPrice: 10, quantity: l.quantity, lineTotal: 10 * l.quantity,
          notes: l.notes,
          kitchenStatus: l.cancelled ? "CANCELLED" : "NEW",
          addOns: l.addOnId ? { create: [{ addOnId: l.addOnId, addOnName: "extra", price: 5 }] } : undefined,
        })),
      },
    },
  });
}

const picks = (email: string, query = "") => as<Picks>(email, `/api/pos/quick-picks${query}`);
const ids = (r: { body: Picks }) => r.body.products.map((p) => p.productId);

before(async () => {
  await requireServer();
  fx = await countCafe("OPS002");
  const category = await db.menuCategory.create({ data: { cafeId: fx.cafeId, name: `${fx.marker} drinks` } });
  for (const name of ["A", "B", "C", "D", "E", "F", "G", "H"]) {
    const p = await db.product.create({
      data: { cafeId: fx.cafeId, categoryId: category.id, name: `${fx.marker} ${name}`, basePrice: 10 },
    });
    products[name] = p.id;
  }
});

after(async () => {
  await teardownTaggedCafe(fx?.cafeId, [], { disconnect: true });
});

beforeEach(async () => {
  await db.order.deleteMany({ where: { cafeId: fx.cafeId } });
  await db.customer.deleteMany({ where: { cafeId: fx.cafeId } });
});

describe("OPS-002 quick picks", () => {
  test("ranks this branch's sales around this hour, ignoring cancelled, old and other-branch sales", async () => {
    await sale([{ product: "A", quantity: 5 }, { product: "B", quantity: 3 }]);
    await sale([{ product: "C", quantity: 2 }, { product: "F", quantity: 30, cancelled: true }]);
    await sale([{ product: "D", quantity: 20 }], { createdAt: ago(12 * HOUR) });
    await sale([{ product: "E", quantity: 50 }], { status: "CANCELLED" });
    await sale([{ product: "G", quantity: 40 }], { branchId: fx.otherBranchId });
    await sale([{ product: "H", quantity: 100 }], { createdAt: ago(15 * 24 * HOUR) });

    const r = await picks(fx.cashier.email);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.window, "HOUR");
    assert.deepEqual(ids(r), [products.A, products.B, products.C],
      "12h-ago, cancelled order, cancelled line, other branch and >14 days are all excluded");
    assert.deepEqual(r.body.products.map((p) => p.quantity), [5, 3, 2]);
  });

  test("a quiet hour falls back to the whole lookback", async () => {
    await sale([{ product: "A", quantity: 1 }]);
    await sale([{ product: "D", quantity: 20 }], { createdAt: ago(12 * HOUR) });
    const r = await picks(fx.cashier.email);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.window, "ALL_DAY");
    assert.deepEqual(ids(r), [products.D, products.A]);
  });

  test("branch-pinned staff cannot read another branch; reading writes nothing", async () => {
    const cross = await picks(fx.cashier.email, `?branchId=${fx.otherBranchId}`);
    assert.equal(cross.status, 403);
    await sale([{ product: "G", quantity: 4 }], { branchId: fx.otherBranchId });
    const owner = await picks(fx.owner.email, `?branchId=${fx.otherBranchId}`);
    assert.equal(owner.status, 200, owner.text);
    assert.deepEqual(ids(owner), [products.G]);
    const before_ = await db.order.count({ where: { cafeId: fx.cafeId } });
    await picks(fx.manager.email);
    assert.equal(await db.order.count({ where: { cafeId: fx.cafeId } }), before_);
  });
});

describe("OPS-002 repeat last order", () => {
  test("returns the items of the customer's last live order, skipping cancelled orders and lines", async () => {
    const customer = await db.customer.create({
      data: { cafeId: fx.cafeId, name: "Mona", phone: "01012345678", normalizedPhone: "01012345678" },
    });
    const variant = await db.productVariant.create({ data: { productId: products.A, name: "Large", price: 15 } });
    const addOn = await db.addOn.create({ data: { cafeId: fx.cafeId, name: `${fx.marker} shot`, price: 5 } });
    await sale([{ product: "H", quantity: 9 }], { customerId: customer.id, createdAt: ago(3 * HOUR) });
    await sale(
      [
        { product: "A", quantity: 2, variantId: variant.id, addOnId: addOn.id, notes: "no sugar" },
        { product: "B", quantity: 1 },
        { product: "C", quantity: 4, cancelled: true },
      ],
      { customerId: customer.id, createdAt: ago(2 * HOUR) }
    );
    await sale([{ product: "E", quantity: 1 }], { customerId: customer.id, status: "CANCELLED", createdAt: ago(1 * HOUR) });

    const r = await as<LastOrder>(fx.cashier.email, "/api/customers/last-order?phone=%2B201012345678");
    assert.equal(r.status, 200, r.text);
    assert.ok(r.body.order, "the live order 2h ago is the last one");
    assert.equal(r.body.order!.customerName, "Mona");
    const items = r.body.order!.items;
    assert.equal(items.length, 2, "the cancelled line is left out");
    const a = items.find((i) => i.productId === products.A)!;
    assert.equal(a.quantity, 2);
    assert.equal(a.variantId, variant.id);
    assert.deepEqual(a.addOnIds, [addOn.id]);
    assert.equal(a.notes, "no sugar");
    assert.ok(items.some((i) => i.productId === products.B && i.quantity === 1));
    assert.ok(!("unitPrice" in a), "prices are not reused");
  });

  test("unknown customer gives null; a malformed phone is refused", async () => {
    const none = await as<LastOrder>(fx.cashier.email, "/api/customers/last-order?phone=01099999999");
    assert.equal(none.status, 200, none.text);
    assert.equal(none.body.order, null);
    const bad = await as(fx.cashier.email, "/api/customers/last-order?phone=123");
    assert.equal(bad.status, 400);
  });
});

describe("OPS-002 till UI wiring", () => {
  const panel = readFileSync("src/components/pos/collect-payment-panel.tsx", "utf8");
  const pos = readFileSync("src/app/(app)/pos/page.tsx", "utf8");
  const quick = readFileSync("src/components/pos/quick-actions.tsx", "utf8");

  test("collect & serve: only for READY orders and users who may change status, through the status route", () => {
    assert.match(panel, /target\.status === "READY" && canServe/);
    assert.match(panel, /can\("orders:update-status"\)/);
    assert.match(panel, /data-testid="collect-and-serve"/);
    assert.match(panel, /\/api\/orders\/\$\{target\.orderId\}\/status/);
    assert.match(panel, /اتحصّل بس متقدمش/, "a serve refusal after collecting is reported, not hidden");
  });

  test("quick picks and repeat-last-order are wired into the till", () => {
    assert.match(pos, /<QuickActions/);
    assert.match(pos, /onRepeat=\{repeatOrder\}/);
    assert.match(pos, /مش متاح دلوقتي/, "items no longer offered are named, not silently dropped");
    assert.match(quick, /\/api\/pos\/quick-picks\?branchId=/);
    assert.match(quick, /\/api\/customers\/last-order\?phone=/);
  });
});
