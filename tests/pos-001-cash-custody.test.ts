// POS-001 — cash custody must not depend on which role the actor holds.
//
// Invariant: any actor performing a transaction that moves money into the
// register must hold an active operational session (shift) for that branch.
// Authorization ("may this person collect?") and custody ("is there an open
// drawer to collect into?") are separate concerns; this file covers custody.

import { test, after, describe } from "node:test";
import assert from "node:assert/strict";
import { collectOrderPayment } from "@/lib/payments";
import { ApiError } from "@/lib/api";
import {
  db, fixture, sessionFor, openShift, makeOrder, cleanup, cleanupShift,
  clearOpenShifts,
} from "./helpers/db";

after(async () => { await db.$disconnect(); });

const ROLES = [
  ["owner@demo.com", "CAFE_OWNER"],
  ["manager@demo.com", "BRANCH_MANAGER"],
  ["cashier@demo.com", "CASHIER"],
] as const;

describe("POS-001 no active shift", () => {
  for (const [email, role] of ROLES) {
    test(`${role} cannot collect cash without an active shift`, async () => {
      const fx = await fixture();
      const session = await sessionFor(email);
      const marker = `PH1-POS001-noshift-${role}`;
      await cleanup(marker);
      // Precondition: this actor holds no custody at this branch.
      await clearOpenShifts(fx.branchId, session.id);
      const order = await makeOrder(fx, marker, session.id);

      try {
        await assert.rejects(
          () => collectOrderPayment({
            session,
            orderId: order.id,
            branchId: fx.branchId,
            splits: [{ method: "CASH", amount: fx.unitPrice }],
          }),
          (e: unknown) => e instanceof ApiError && e.status === 400,
          `${role} was allowed to collect with no open shift`
        );

        // The database must agree: no payment row, order still unpaid.
        const settled = await db.order.findUniqueOrThrow({
          where: { id: order.id },
          include: { payments: true },
        });
        assert.equal(settled.payments.length, 0, "a Payment row was written anyway");
        assert.equal(Number(settled.paidAmount), 0);
      } finally {
        await cleanup(marker);
      }
    });
  }
});

describe("POS-001 with an active shift", () => {
  for (const [email, role] of ROLES) {
    test(`${role} can collect cash and it is attributed to the shift`, async () => {
      const fx = await fixture();
      const session = await sessionFor(email);
      const marker = `PH1-POS001-shift-${role}`;
      await cleanup(marker);
      // Precondition: exactly one open shift, the one under test.
      await clearOpenShifts(fx.branchId, session.id);
      const shift = await openShift(fx, session.id, 100);
      const order = await makeOrder(fx, marker, session.id);

      try {
        const res = await collectOrderPayment({
          session,
          orderId: order.id,
          branchId: fx.branchId,
          splits: [{ method: "CASH", amount: fx.unitPrice }],
        });

        assert.equal(res.payments.length, 1);
        const pay = await db.payment.findUniqueOrThrow({ where: { id: res.payments[0].id } });
        assert.equal(pay.shiftId, shift.id, "payment was not attributed to the open shift");
      } finally {
        await cleanup(marker);
        await cleanupShift(shift.id);
      }
    });
  }
});
