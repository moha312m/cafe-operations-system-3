import assert from "node:assert/strict";
import { test } from "node:test";
import type { Prisma } from "@prisma/client";
import { isAvailableDeliveryCourier, listDeliveryCouriers } from "../src/lib/delivery-couriers";

const homeCourier = {
  id: "branch-courier", cafeId: "cafe", role: "WAITER",
  branchId: "main", temporaryBranchId: null, temporaryBranchUntil: null,
  temporaryBranchStartedAt: null, temporaryBranchCancelledAt: null,
  name: "Branch courier", phone: "01000000000", email: "not-for-the-roster",
};

const effectiveElsewhere = {
  ...homeCourier, id: "on-assignment", temporaryBranchId: "annex",
  temporaryBranchUntil: new Date("2099-01-01T00:00:00Z"),
};

test("the courier roster is scoped and returns only the card fields", async () => {
  const client = {
    user: { findMany: async ({ where }: { where: Prisma.UserWhereInput }) => {
      assert.deepEqual(where, {
        cafeId: "cafe", isDeliveryCourier: true, isActive: true, archivedAt: null,
        role: { notIn: ["CAFE_OWNER", "SUPER_ADMIN"] },
        OR: [{ branchId: "main" }, { temporaryBranchId: "main" }],
      });
      return [homeCourier, effectiveElsewhere];
    } },
    shift: { findFirst: async () => null },
    custodyPeriod: { findFirst: async () => null },
  } as unknown as Prisma.TransactionClient;
  assert.deepEqual(await listDeliveryCouriers(client, "cafe", "main"), [
    { id: homeCourier.id, name: homeCourier.name, phone: homeCourier.phone },
  ]);
});

test("checkout rejects missing, disabled, and effectively cross-branch couriers", async () => {
  for (const [existsInScope, staff, expected] of [
    [false, null, false], [true, null, false],
    [true, effectiveElsewhere, false], [true, homeCourier, true],
  ] as const) {
    const calls: string[] = [];
    const tx = {
      $queryRaw: async (query: TemplateStringsArray, ...values: unknown[]) => {
        assert.match(query.join("?"), /FOR SHARE/);
        assert.deepEqual(values, ["branch-courier", "cafe", "main", "main"]);
        calls.push("lock");
        return existsInScope ? [{ id: "branch-courier" }] : [];
      },
      user: { findFirst: async ({ where }: { where: Prisma.UserWhereInput }) => {
        assert.equal(where.id, "branch-courier");
        assert.equal(where.isDeliveryCourier, true);
        assert.equal(where.isActive, true);
        assert.equal(where.archivedAt, null);
        calls.push("validate");
        return staff;
      } },
      shift: { findFirst: async () => null },
      custodyPeriod: { findFirst: async () => null },
    } as unknown as Prisma.TransactionClient;
    assert.equal(await isAvailableDeliveryCourier(tx, "cafe", "main", "branch-courier"), expected);
    assert.deepEqual(calls, existsInScope ? ["lock", "validate"] : ["lock"]);
  }
});
