// A café the count suites own outright, with accounts that can actually log in.
//
// Phase I is HTTP, so its suites cannot use the schema suites' pattern of a
// tagged café full of `passwordHash: "no-login-path"` users: the thing under
// test is what the SERVER hands a signed-in counter, and that requires a real
// session cookie. So the users here carry real bcrypt hashes of a password
// written down in this file — no secret is introduced that the repository
// does not already contain, and the accounts live only as long as the suite.
//
// Roles are chosen for what they prove rather than for realism:
//
//   manager    — BRANCH_MANAGER: every stock-count key, confirm included
//   cashier    — CASHIER: view/start/submit only; no recount, no confirm
//   storekeeper— INVENTORY_MANAGER: recount, but NOT confirm — the role that
//                proves recounting and signing off are different powers
//   waiter     — WAITER: no stock-count key at all, so a 403 is about the key
//                rather than about the café or the branch
//   owner      — CAFE_OWNER, pinned to no branch, so it must name one
//
// Two branches, because "cross-branch access is rejected" is not testable
// against a café that has one.

import bcrypt from "bcryptjs";
import { db, tag } from "./db";
import { login } from "./http";

/** Written down on purpose: these accounts exist only inside a test run. */
export const COUNT_PASSWORD = "count-fixture-1234";

export type CountActor = { id: string; email: string; name: string };

export type CountCafe = {
  marker: string;
  cafeId: string;
  branchId: string;
  /** A second branch of the same café, for cross-branch refusals. */
  otherBranchId: string;
  manager: CountActor;
  cashier: CountActor;
  storekeeper: CountActor;
  waiter: CountActor;
  owner: CountActor;
};

async function actor(
  marker: string,
  suffix: string,
  role: "BRANCH_MANAGER" | "CASHIER" | "WAITER" | "CAFE_OWNER" | "INVENTORY_MANAGER",
  cafeId: string,
  branchId: string | null,
  passwordHash: string
): Promise<CountActor> {
  const email = `${marker.toLowerCase()}-${suffix}@example.invalid`;
  const u = await db.user.create({
    data: { email, name: `${marker}-${suffix}`, passwordHash, role, cafeId, branchId },
    select: { id: true, email: true, name: true },
  });
  return u;
}

/**
 * Create the café, its two branches and its five accounts, and sign them all
 * in so `as(email, …)` works for any of them.
 */
export async function countCafe(finding: string): Promise<CountCafe> {
  const marker = tag(finding);
  const cafe = await db.cafe.create({
    data: {
      name: `${marker} cafe`,
      slug: marker.toLowerCase(),
      settings: { create: {} },
      branches: { create: [{ name: `${marker} main` }, { name: `${marker} annex` }] },
    },
    include: { branches: { orderBy: { name: "asc" } } },
  });

  const cafeId = cafe.id;
  const branchId = cafe.branches.find((b) => b.name.endsWith("main"))!.id;
  const otherBranchId = cafe.branches.find((b) => b.name.endsWith("annex"))!.id;

  const hash = await bcrypt.hash(COUNT_PASSWORD, 10);
  const manager = await actor(marker, "manager", "BRANCH_MANAGER", cafeId, branchId, hash);
  const cashier = await actor(marker, "cashier", "CASHIER", cafeId, branchId, hash);
  const storekeeper = await actor(
    marker, "store", "INVENTORY_MANAGER", cafeId, branchId, hash
  );
  const waiter = await actor(marker, "waiter", "WAITER", cafeId, branchId, hash);
  const owner = await actor(marker, "owner", "CAFE_OWNER", cafeId, null, hash);

  for (const a of [manager, cashier, storekeeper, waiter, owner]) {
    await login(a.email, COUNT_PASSWORD);
  }

  return {
    marker, cafeId, branchId, otherBranchId,
    manager, cashier, storekeeper, waiter, owner,
  };
}

/**
 * An ingredient this suite owns.
 *
 * `currentStock` is written straight onto the row rather than through
 * `applyStockMutation`, which is legitimate here and nowhere in `src/`: the
 * single-writer rule (LEDGER-002) is about RUNTIME mutation, and this is a
 * fixture establishing an opening balance before anything runs. The suites
 * that care about the count point move stock through the real writer.
 */
export async function countItem(
  fx: Pick<CountCafe, "cafeId" | "branchId" | "marker">,
  name: string,
  opts: {
    stock?: number;
    isCritical?: boolean;
    isActive?: boolean;
    archived?: boolean;
    costPerUnit?: number;
    branchId?: string;
  } = {}
) {
  return db.inventoryItem.create({
    data: {
      cafeId: fx.cafeId,
      branchId: opts.branchId ?? fx.branchId,
      name: `${fx.marker} ${name}`,
      unit: "KG",
      costPerUnit: opts.costPerUnit ?? 450,
      currentStock: String(opts.stock ?? 0),
      isCritical: opts.isCritical ?? false,
      isActive: opts.isActive ?? true,
      archivedAt: opts.archived ? new Date() : null,
    },
  });
}

/** A STOCK reason code, which corrections and variance acceptance require. */
export async function stockReasonCode(cafeId: string, code: string, label: string) {
  return db.reasonCode.create({
    data: { cafeId, domain: "STOCK", code, label },
  });
}
