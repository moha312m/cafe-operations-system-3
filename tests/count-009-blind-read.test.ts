// COUNT-009 (T25) — the counter is not shown the target.
//
// Spec §5, and the same idea SHIFT-003 already proved for the cash drawer:
// somebody who is about to measure something must not be able to learn the
// answer first. The control is keyed on CUSTODY, not on role — a manager who
// is not counting keeps full visibility, and a manager who started the count
// does not.
//
// "Blind" has to mean blind at the response layer, not merely that the UI
// does not draw the number. So this suite asserts absence of the KEY rather
// than a null value, and scans the whole body recursively: the field that
// escapes in review is never the top-level one.
//
// Three things are withheld together, because withholding only the first
// would be theatre:
//
//   expectedQuantity  — the target itself
//   varianceQuantity  — counted − expected, so expected = counted − variance
//   costImpact        — |variance| × a cost the counter can read off the item
//
// And two things are never disclosed to anybody through this route:
// `currentStock`, which IS the theoretical figure under another name, and
// the ledger counters, which LEDGER-004 already keeps off the wire.
//
// The disclosure point is submission. After it, the reconciliation is
// history and everyone authorised may read it.

import { test, after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { db, teardownTaggedCafe } from "./helpers/db";
import { requireServer, as } from "./helpers/http";
import { countCafe, countItem, type CountCafe } from "./helpers/count";

let fx: CountCafe;
let other: CountCafe;
let itemId: string;
let secondItemId: string;

before(async () => {
  await requireServer();
  fx = await countCafe("COUNT009");
  other = await countCafe("COUNT009X");
  itemId = (await countItem(fx, "beans", { stock: 12, isCritical: true })).id;
  secondItemId = (await countItem(fx, "milk", { stock: 30, isCritical: true })).id;
});

after(() =>
  teardownTaggedCafe([fx?.cafeId, other?.cafeId].filter(Boolean) as string[], [], {
    disconnect: true,
  })
);

/** Every JSON path at which `key` appears anywhere in the body (LEDGER-004). */
function pathsTo(value: unknown, key: string, at = "$"): string[] {
  if (Array.isArray(value)) return value.flatMap((v, i) => pathsTo(v, key, `${at}[${i}]`));
  if (value && typeof value === "object") {
    const found: string[] = [];
    for (const [k, v] of Object.entries(value)) {
      if (k === key) found.push(`${at}.${k}`);
      found.push(...pathsTo(v, key, `${at}.${k}`));
    }
    return found;
  }
  return [];
}

type Session = {
  id: string;
  status: string;
  mode: string;
  blind?: boolean;
  lines: Record<string, unknown>[];
};

/**
 * A counted session written straight through Prisma.
 *
 * The capture API is T26's subject; what this suite needs is a session that
 * already HOLDS a target, so that a response lacking one is evidence of
 * redaction rather than of there being nothing to redact.
 */
async function countedSession(opts: {
  initiatedById: string;
  counterId: string;
  status?: "DRAFT" | "IN_PROGRESS" | "SUBMITTED" | "CONFIRMED";
  mode?: "BLIND" | "OPEN";
}) {
  await db.stockCountSession.deleteMany({ where: { cafeId: fx.cafeId } });
  const s = await db.stockCountSession.create({
    data: {
      cafeId: fx.cafeId,
      branchId: fx.branchId,
      type: "CRITICAL",
      scopeDerivation: "CRITICAL_ONLY",
      status: opts.status ?? "IN_PROGRESS",
      mode: opts.mode ?? "BLIND",
      initiatedById: opts.initiatedById,
      lines: {
        create: [
          {
            inventoryItemId: itemId,
            unit: "KG",
            expectedQuantity: "12",
            countedQuantity: "11.5",
            effectiveCountedQuantity: "11.5",
            varianceQuantity: "-0.5",
            costImpact: "225",
            costImpactAvailable: true,
            itemVersion: BigInt(3),
            expectedBasis: "LOCKED_ITEM_VERSION",
            countedAt: new Date(),
            counterId: opts.counterId,
            disposition: "COUNTED",
          },
          {
            inventoryItemId: secondItemId,
            unit: "KG",
            expectedQuantity: "30",
            disposition: "PENDING",
          },
        ],
      },
    },
    select: { id: true },
  });
  return s.id;
}

const read = (email: string, id: string) =>
  as<{ session?: Session; error?: string }>(email, `/api/stock-counts/${id}`);

describe("COUNT-009 blind count read model", () => {
  test("a non-counting manager sees the target, so its absence elsewhere means something", async () => {
    // The non-vacuity anchor for this whole suite. If the route simply never
    // returned an expected figure, every redaction assertion below would pass
    // for the wrong reason.
    const id = await countedSession({
      initiatedById: fx.cashier.id,
      counterId: fx.cashier.id,
    });
    const r = await read(fx.manager.email, id);
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(
      pathsTo(r.body, "expectedQuantity").length > 0,
      true,
      "oversight must not be blinded — only whoever is counting is"
    );
    const line = r.body.session!.lines.find((l) => l.inventoryItemId === itemId)!;
    assert.equal(Number(line.expectedQuantity), 12);
    assert.equal(Number(line.varianceQuantity), -0.5);
  });

  test("the counter's response has no expectedQuantity key at all", async () => {
    const id = await countedSession({
      initiatedById: fx.manager.id,
      counterId: fx.cashier.id,
    });
    const r = await read(fx.cashier.email, id);
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(
      pathsTo(r.body, "expectedQuantity"),
      [],
      "absent, not null — a null still says a figure exists and is being withheld"
    );
    // The observation itself stays: a counter must be able to see what they
    // wrote down.
    const line = r.body.session!.lines.find((l) => l.inventoryItemId === itemId)!;
    assert.equal(Number(line.countedQuantity), 11.5);
    assert.equal(r.body.session!.blind, true, "and the client is told it is blind");
  });

  test("variance and cost impact go with it, since expected is recoverable from them", async () => {
    const id = await countedSession({
      initiatedById: fx.manager.id,
      counterId: fx.cashier.id,
    });
    const r = await read(fx.cashier.email, id);
    assert.equal(r.status, 200, r.text);
    for (const key of ["varianceQuantity", "costImpact", "costImpactAvailable"]) {
      assert.deepEqual(
        pathsTo(r.body, key),
        [],
        `${key} makes the target trivially recoverable and must go with it`
      );
    }
  });

  test("the initiator is blinded too — starting a count does not mean supervising it", async () => {
    const id = await countedSession({
      initiatedById: fx.cashier.id,
      counterId: fx.manager.id,
    });
    const r = await read(fx.cashier.email, id);
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(pathsTo(r.body, "expectedQuantity"), []);
  });

  test("nobody is shown the theoretical stock or the ledger counters", async () => {
    const id = await countedSession({
      initiatedById: fx.cashier.id,
      counterId: fx.cashier.id,
    });
    for (const email of [fx.manager.email, fx.cashier.email]) {
      const r = await read(email, id);
      assert.equal(r.status, 200, r.text);
      assert.deepEqual(
        pathsTo(r.body, "currentStock"),
        [],
        "currentStock IS the theoretical figure under another name"
      );
      assert.deepEqual(pathsTo(r.body, "itemVersion"), [], "LEDGER-004");
      assert.deepEqual(pathsTo(r.body, "ledgerVersion"), [], "LEDGER-004");
    }
  });

  test("an OPEN-mode session discloses to the counter — blindness is the owner's choice", async () => {
    const id = await countedSession({
      initiatedById: fx.manager.id,
      counterId: fx.cashier.id,
      mode: "OPEN",
    });
    const r = await read(fx.cashier.email, id);
    assert.equal(r.status, 200, r.text);
    const line = r.body.session!.lines.find((l) => l.inventoryItemId === itemId)!;
    assert.equal(Number(line.expectedQuantity), 12);
    assert.equal(r.body.session!.blind, false);
  });

  test("after submission the counter sees expected and variance — that is the reveal", async () => {
    const id = await countedSession({
      initiatedById: fx.manager.id,
      counterId: fx.cashier.id,
      status: "SUBMITTED",
    });
    const r = await read(fx.cashier.email, id);
    assert.equal(r.status, 200, r.text);
    const line = r.body.session!.lines.find((l) => l.inventoryItemId === itemId)!;
    assert.equal(Number(line.expectedQuantity), 12);
    assert.equal(Number(line.varianceQuantity), -0.5);
  });

  test("a branch-pinned caller is refused another branch's session", async () => {
    await db.stockCountSession.deleteMany({ where: { cafeId: fx.cafeId } });
    const elsewhere = await db.stockCountSession.create({
      data: {
        cafeId: fx.cafeId,
        branchId: fx.otherBranchId,
        type: "FULL",
        scopeDerivation: "ALL_ELIGIBLE",
        initiatedById: fx.owner.id,
      },
      select: { id: true },
    });
    const r = await read(fx.manager.email, elsewhere.id);
    assert.equal(r.status, 403, `expected 403, got ${r.status}: ${r.text}`);
  });

  test("another café's session is not found, rather than forbidden", async () => {
    // A 403 would confirm the id exists. A tenant learns nothing about
    // another tenant's records, including that they are there.
    const id = await countedSession({
      initiatedById: fx.manager.id,
      counterId: fx.cashier.id,
    });
    const r = await read(other.owner.email, id);
    assert.equal(r.status, 404, `expected 404, got ${r.status}: ${r.text}`);
    assert.ok(!/expectedQuantity/.test(r.text), "and the refusal discloses nothing");
  });

  test("an unknown id is 404", async () => {
    const r = await read(fx.manager.email, "no-such-count-session-id");
    assert.equal(r.status, 404, r.text);
  });

  test("a caller without stock_count.view is refused", async () => {
    const id = await countedSession({
      initiatedById: fx.manager.id,
      counterId: fx.cashier.id,
    });
    const r = await read(fx.waiter.email, id);
    assert.equal(r.status, 403, `expected 403, got ${r.status}: ${r.text}`);
  });

  test("the path scanner can see through nesting, so the absences above can fail", () => {
    const shaped = { session: { lines: [{ expectedQuantity: 3 }] } };
    assert.deepEqual(pathsTo(shaped, "expectedQuantity"), ["$.session.lines[0].expectedQuantity"]);
    assert.deepEqual(pathsTo({ a: 1 }, "expectedQuantity"), []);
  });
});
