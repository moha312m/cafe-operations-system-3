// POS-CONC-005 (R-POS-02B2b) — one open drawer per cashier.
//
// `POST /api/shifts` has always held this rule: it looks for the cashier's
// OPEN shift and, finding one, answers `alreadyOpen` instead of opening a
// second drawer. But it was held by a read, and a read takes no lock under
// READ COMMITTED — the default here, and the only isolation level this
// repository configures. One cashier signing in on two devices passed that
// check twice and ended up holding two drawers in their own name, and the
// close then reconciled against half the shift.
//
// Two constraints fire here and their ORDER is the whole difficulty. Both
// callers read the same `_max.shiftNumber`, so `Shift_branchId_shiftNumber_key`
// complains FIRST and the cashier index never gets a look in. So the sequence
// needs what the order number got in R-POS-02B1 — hold the branch row so
// allocation serialises, retry as the backstop — and only once the loser has
// a number of its own does it reach `Shift_one_open_per_branch_cashier` (M25),
// which is the conflict that means "your shift is already open".
//
// That distinction matters for what the cashier sees. A lost race on the
// shift NUMBER is contention and should be retried. A lost race on the
// CASHIER is a fact, and the honest answer is the one the sequential re-open
// path already gives: here is your shift, it was already open.

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { Prisma } from "@prisma/client";
import { isUniqueConflict, retryOnUniqueConflict, ApiError } from "@/lib/api";
import { requireServer, login, as } from "./helpers/http";
import { db, fixture, sessionFor, clearOpenShifts, type Fixture } from "./helpers/db";

const CASHIER = "cashier@demo.com";

let fx: Fixture;

type ShiftResponse = {
  shift?: { id: string; shiftNumber: number };
  alreadyOpen?: boolean;
  error?: string;
};

function openShiftOverHttp(openingCashAmount = 100) {
  return as<ShiftResponse>(CASHIER, "/api/shifts", {
    method: "POST",
    body: JSON.stringify({ branchId: fx.branchId, openingCashAmount }),
  });
}

before(async () => {
  await requireServer();
  await login(CASHIER, "cashier123");
  fx = await fixture();
});

after(async () => {
  await db.$disconnect();
});

describe("POS-CONC-005 a cashier holds one drawer", () => {
  test("two devices at once: one drawer, and the loser is told it is already open", async () => {
    const cashier = await sessionFor(CASHIER);
    await clearOpenShifts(fx.branchId, cashier.id);

    try {
      const results = await Promise.all([openShiftOverHttp(), openShiftOverHttp()]);
      const detail = results
        .map((r) => `${r.status} ${r.body.error ?? (r.body.alreadyOpen ? "alreadyOpen" : "created")}`)
        .join(" | ");

      assert.equal(results.filter((r) => r.status >= 500).length, 0, `server error: ${detail}`);
      assert.equal(
        results.filter((r) => r.status === 409).length,
        0,
        `a raw conflict reached the cashier instead of an answer: ${detail}`
      );
      assert.equal(
        results.filter((r) => r.status === 200 || r.status === 201).length,
        2,
        `both devices must get an answer: ${detail}`
      );

      const open = await db.shift.findMany({
        where: { branchId: fx.branchId, cashierId: cashier.id, status: "OPEN" },
        select: { id: true },
      });
      assert.equal(open.length, 1, `exactly one OPEN drawer, found ${open.length}: ${detail}`);

      // Both devices must be looking at the SAME drawer, or the cashier has
      // two screens disagreeing about where the money is.
      for (const r of results) {
        assert.equal(r.body.shift?.id, open[0].id, `every caller must be pointed at it: ${detail}`);
      }
      assert.equal(
        results.filter((r) => r.body.alreadyOpen === true).length,
        1,
        `exactly one caller opened it and one was told it was already open: ${detail}`
      );
    } finally {
      await clearOpenShifts(fx.branchId, cashier.id);
    }
  });

  test("four devices at once: still one drawer, still no crash", async () => {
    // Two callers can collide on the shift number once. Four collide
    // repeatedly, which is what distinguishes a real fix from a lucky one.
    const cashier = await sessionFor(CASHIER);
    await clearOpenShifts(fx.branchId, cashier.id);

    try {
      const results = await Promise.all(Array.from({ length: 4 }, () => openShiftOverHttp()));
      const detail = results.map((r) => `${r.status}`).join(" | ");

      assert.equal(results.filter((r) => r.status >= 500).length, 0, `server error: ${detail}`);
      assert.equal(results.filter((r) => r.status === 409).length, 0, `raw conflict: ${detail}`);

      const open = await db.shift.count({
        where: { branchId: fx.branchId, cashierId: cashier.id, status: "OPEN" },
      });
      assert.equal(open, 1, `exactly one OPEN drawer, found ${open}: ${detail}`);
    } finally {
      await clearOpenShifts(fx.branchId, cashier.id);
    }
  });

  test("the sequential re-open answer is unchanged", async () => {
    // The pre-existing behaviour the race loser is mapped onto. If this
    // changes, the mapping above is pointing at the wrong thing.
    const cashier = await sessionFor(CASHIER);
    await clearOpenShifts(fx.branchId, cashier.id);

    try {
      const first = await openShiftOverHttp();
      const second = await openShiftOverHttp();

      assert.equal(first.status, 201, "opening a shift creates it");
      assert.equal(second.status, 200, "re-opening reports the existing one");
      assert.equal(second.body.alreadyOpen, true);
      assert.equal(second.body.shift?.id, first.body.shift?.id, "and it is the same shift");

      const count = await db.shift.count({
        where: { branchId: fx.branchId, cashierId: cashier.id, status: "OPEN" },
      });
      assert.equal(count, 1);
    } finally {
      await clearOpenShifts(fx.branchId, cashier.id);
    }
  });

  test("a closed shift does not block the cashier's next one", async () => {
    // The index is partial for a reason: a cashier works many shifts.
    const cashier = await sessionFor(CASHIER);
    await clearOpenShifts(fx.branchId, cashier.id);

    try {
      const first = await openShiftOverHttp();
      assert.equal(first.status, 201);
      await db.shift.update({
        where: { id: first.body.shift!.id },
        data: { status: "CLOSED", closedAt: new Date() },
      });

      const second = await openShiftOverHttp();
      assert.equal(second.status, 201, "a new drawer must open after the previous one closed");
      assert.notEqual(second.body.shift?.id, first.body.shift?.id, "and it is a new shift");
      assert.notEqual(
        second.body.shift?.shiftNumber,
        first.body.shift?.shiftNumber,
        "with its own number"
      );
    } finally {
      await clearOpenShifts(fx.branchId, cashier.id);
    }
  });
});

describe("POS-CONC-005 the two conflicts are told apart", () => {
  // Unit-level, because the ORDER in which the two indexes fire is the
  // subtlety this repair turns on, and a race cannot demonstrate it reliably.
  function conflict(target: string[]) {
    return new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
      code: "P2002",
      clientVersion: Prisma.prismaVersion.client,
      meta: { target },
    });
  }

  test("a shiftNumber collision is contention: retried, then reported as a conflict", async () => {
    let calls = 0;
    const result = await retryOnUniqueConflict(
      async () => {
        calls += 1;
        if (calls === 1) throw conflict(["branchId", "shiftNumber"]);
        return "opened";
      },
      { field: "shiftNumber", message: "conflict" }
    );
    assert.equal(result, "opened");
    assert.equal(calls, 2, "the losing attempt must be run again with a fresh number");

    let forever = 0;
    await assert.rejects(
      () =>
        retryOnUniqueConflict(
          async () => {
            forever += 1;
            throw conflict(["branchId", "shiftNumber"]);
          },
          { field: "shiftNumber", message: "في شيفت تاني اتفتح في نفس اللحظة" }
        ),
      (e: Error) => e instanceof ApiError && (e as ApiError).status === 409
    );
    assert.equal(forever, 3, "bounded: three attempts, then stop");
  });

  test("a cashierId collision is NOT retried — it is a fact, not contention", async () => {
    // Retrying it would re-run a transaction destined to fail every time.
    // It has to escape the retry so the route can answer `alreadyOpen`.
    let calls = 0;
    await assert.rejects(
      () =>
        retryOnUniqueConflict(
          async () => {
            calls += 1;
            throw conflict(["branchId", "cashierId"]);
          },
          { field: "shiftNumber", message: "conflict" }
        ),
      (e: Error) => e.message.includes("Unique constraint")
    );
    assert.equal(calls, 1, "raised at once, untouched, for the route to translate");
    assert.ok(isUniqueConflict(conflict(["branchId", "cashierId"]), "cashierId"));
    assert.ok(!isUniqueConflict(conflict(["branchId", "shiftNumber"]), "cashierId"));
  });
});
