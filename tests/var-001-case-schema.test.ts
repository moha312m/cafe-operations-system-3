// VAR-001 — point a case at what caused it, with keys the database can check.
//
// A variance case is one investigation domain with four different kinds of
// evidence behind it, and the temptation in that shape is always the same:
// a `sourceType` string next to a `sourceId` string, pointing at whichever
// table the string names. That design cannot be constrained. Nothing stops
// an id that matches no row, or a type that disagrees with the id it sits
// beside, and the database has no way to refuse either.
//
// So the sources are separate, explicitly-typed columns with real foreign
// keys, and a CHECK counts them: exactly one arm must apply. CASH is the
// fourth arm and has no column of its own, because its evidence is the shift
// close — the source of truth T16 established — reached through `shiftId`.
// Adding a cash source column here would have been the second cash record
// all over again.
//
// Each source column is `@unique`, so one counted line, one settlement or
// one opening exception can raise exactly one case. That is what makes an
// engine retry idempotent rather than merely unlikely to duplicate.
//
// Two things this suite pins that are easy to lose later:
//
//   • `financialImpact` NULL is not zero. A shortage nobody can price is not
//     a shortage that cost nothing, and the pair of columns keeps "unknown"
//     from reading as "harmless".
//
//   • A case is a record that something needs looking at. It moves no stock
//     and it makes nobody liable for anything. Both are asserted here, since
//     both are the kind of thing a later convenience could quietly add.

import { test, after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { db, tag, teardownTaggedCafe } from "./helpers/db";

const MARKER = tag("VAR001");
let cafeId: string;
let branchId: string;
let openerId: string;
let resolverId: string;
let staffId: string;
let shiftId: string;
let otherShiftId: string;
let custodyPeriodId: string;
let itemId: string;
let lineId: string;
let otherLineId: string;
let cardReconId: string;
let walletReconId: string;
let openingExceptionId: string;
let otherExceptionId: string;
let reasonCodeId: string;

before(async () => {
  const cafe = await db.cafe.create({
    data: {
      name: `${MARKER} cafe`, slug: MARKER.toLowerCase(),
      settings: { create: {} },
      branches: { create: [{ name: `${MARKER} main` }] },
    },
    include: { branches: true },
  });
  cafeId = cafe.id;
  branchId = cafe.branches[0].id;

  const mk = async (suffix: string, role: "CASHIER" | "BRANCH_MANAGER") =>
    (await db.user.create({
      data: {
        email: `${MARKER}-${suffix}@example.invalid`, name: `${MARKER}-${suffix}`,
        passwordHash: "no-login-path", role, cafeId, branchId,
      },
    })).id;
  openerId = await mk("opener", "BRANCH_MANAGER");
  resolverId = await mk("resolver", "BRANCH_MANAGER");
  staffId = await mk("staff", "CASHIER");

  const shift = async (n: number) =>
    (await db.shift.create({
      data: {
        cafeId, branchId, cashierId: staffId, shiftNumber: n,
        openingCashAmount: 0, expectedCashAmount: 0,
        actualCashAmount: "487.00", cashDifference: "-13.00",
      },
    })).id;
  shiftId = await shift(1);
  otherShiftId = await shift(2);

  custodyPeriodId = (await db.custodyPeriod.create({
    data: {
      cafeId, branchId, scope: "STOCK",
      participants: { create: [{ userId: staffId, role: "PRIMARY" }] },
    },
  })).id;

  itemId = (await db.inventoryItem.create({
    data: {
      cafeId, branchId, name: `${MARKER} beans`, unit: "KG",
      costPerUnit: 450, currentStock: "12.000",
    },
  })).id;
  const otherItemId = (await db.inventoryItem.create({
    data: {
      cafeId, branchId, name: `${MARKER} milk`, unit: "LITER",
      costPerUnit: 38, currentStock: "30.000",
    },
  })).id;

  const sessionId = (await db.stockCountSession.create({
    data: {
      cafeId, branchId, type: "FULL", scopeDerivation: "ALL_ELIGIBLE",
      initiatedById: openerId,
    },
  })).id;
  const line = async (inventoryItemId: string, unit: "KG" | "LITER") =>
    (await db.stockCountLine.create({
      data: {
        sessionId, inventoryItemId, unit,
        expectedQuantity: "12.000", countedQuantity: "11.500",
        effectiveCountedQuantity: "11.500", varianceQuantity: "-0.500",
      },
    })).id;
  lineId = await line(itemId, "KG");
  otherLineId = await line(otherItemId, "LITER");

  cardReconId = (await db.tenderReconciliation.create({
    data: {
      cafeId, branchId, shiftId, method: "CARD",
      expectedAmount: "1250.00", actualAmount: "1237.50", varianceAmount: "-12.50",
    },
  })).id;
  walletReconId = (await db.tenderReconciliation.create({
    data: {
      cafeId, branchId, shiftId, method: "WALLET",
      expectedAmount: "300.00", actualAmount: "295.00", varianceAmount: "-5.00",
    },
  })).id;

  reasonCodeId = (await db.reasonCode.create({
    data: { cafeId, domain: "HANDOVER", code: `${MARKER}-OPEN`, label: "فرق عند الفتح" },
  })).id;
  const exception = async (kind: "CASH_MISMATCH" | "STOCK_MISMATCH") =>
    (await db.openingException.create({
      data: {
        cafeId, branchId, kind, shiftId,
        reasonCodeId, authorizedById: openerId,
        proposedAmount: "500.00", actualAmount: "487.00", varianceAmount: "-13.00",
      },
    })).id;
  openingExceptionId = await exception("CASH_MISMATCH");
  otherExceptionId = await exception("STOCK_MISMATCH");
});

after(() => teardownTaggedCafe(cafeId, [], { disconnect: true }));

const clearCases = async () => {
  await db.shift.updateMany({ where: { cafeId }, data: { cashVarianceCaseId: null } });
  await db.varianceCase.deleteMany({ where: { cafeId } });
};

describe("VAR-001 variance case schema", () => {
  test("a STOCK case resolves its counted line through the relation", async () => {
    await clearCases();
    const c = await db.varianceCase.create({
      data: {
        cafeId, branchId, type: "STOCK", stockCountLineId: lineId,
        custodyPeriodId, quantityVariance: "-0.500", openedById: openerId,
      },
    });

    assert.equal(c.status, "OPEN", "a case starts open");
    assert.equal(c.blocking, false, "and does not stop the shop by default");
    assert.equal(c.confidence, "UNVERIFIABLE", "nothing has judged the evidence yet");
    assert.equal(c.resolvedAt, null);
    assert.equal(c.assignedResponsibilityUserId, null, "and blames nobody");

    const loaded = await db.varianceCase.findUniqueOrThrow({
      where: { id: c.id },
      include: { stockCountLine: true, custodyPeriod: true, openedBy: true, cafe: true, branch: true },
    });
    assert.equal(loaded.stockCountLine?.id, lineId, "a real key, not a string that names a table");
    assert.equal(loaded.custodyPeriod?.id, custodyPeriodId, "responsibility follows custody");
    assert.equal(loaded.openedBy.id, openerId);
    assert.equal(loaded.tenderReconciliationId, null, "and no other arm is set");
    assert.equal(loaded.openingExceptionId, null);
  });

  test("a CASH case is sourced by its shift, with no source column at all", async () => {
    // T16's rule carried forward: the shift close is where cash is
    // reconciled, so a cash case reaches its evidence through `shiftId`
    // rather than through a fifth column that would be a second record.
    await clearCases();
    const c = await db.varianceCase.create({
      data: {
        cafeId, branchId, type: "CASH", shiftId,
        amountVariance: "-13.00", openedById: openerId,
      },
    });

    assert.equal(c.stockCountLineId, null);
    assert.equal(c.tenderReconciliationId, null);
    assert.equal(c.openingExceptionId, null, "cash needs no source column");

    const loaded = await db.varianceCase.findUniqueOrThrow({
      where: { id: c.id }, include: { shift: true },
    });
    assert.equal(loaded.shift?.id, shiftId);
    assert.equal(
      Number(loaded.shift?.cashDifference), -13,
      "and the shift still holds the figure the case is about"
    );
  });

  test("a CARD settlement is a valid tender source", async () => {
    await clearCases();
    const c = await db.varianceCase.create({
      data: {
        cafeId, branchId, type: "TENDER", tenderReconciliationId: cardReconId,
        shiftId, amountVariance: "-12.50", openedById: openerId,
      },
      include: { tenderReconciliation: true },
    });
    assert.equal(c.tenderReconciliation?.method, "CARD");
    assert.equal(Number(c.tenderReconciliation?.varianceAmount), -12.5);
  });

  test("a WALLET settlement is a valid tender source", async () => {
    await clearCases();
    const c = await db.varianceCase.create({
      data: {
        cafeId, branchId, type: "TENDER", tenderReconciliationId: walletReconId,
        shiftId, amountVariance: "-5.00", openedById: openerId,
      },
      include: { tenderReconciliation: true },
    });
    assert.equal(c.tenderReconciliation?.method, "WALLET");
  });

  test("no tender source can ever be CASH or MIXED, because no such row exists", async () => {
    // The invariant reaches here intact rather than being restated. A tender
    // variance source is a TenderReconciliation, and T16's CHECK means that
    // table cannot hold a CASH or MIXED row for this case to point at.
    for (const method of ["CASH", "MIXED"] as const) {
      await assert.rejects(
        () => db.tenderReconciliation.create({
          data: { cafeId, branchId, shiftId: otherShiftId, method, expectedAmount: "10.00" },
        }),
        /TenderReconciliation_no_cash_check|constraint/i,
        `${method} must remain unrepresentable as a settlement channel`
      );
    }
    const methods = await db.tenderReconciliation.findMany({
      where: { cafeId }, select: { method: true },
    });
    assert.deepEqual(
      methods.map((m) => m.method).sort(), ["CARD", "WALLET"],
      "so the only tender sources available are the two electronic channels"
    );
  });

  test("an opening exception is a valid source", async () => {
    await clearCases();
    const c = await db.varianceCase.create({
      data: {
        cafeId, branchId, type: "OPENING_EXCEPTION", openingExceptionId,
        shiftId, amountVariance: "-13.00", openedById: openerId,
      },
      include: { openingException: { include: { reasonCode: true } } },
    });
    assert.equal(c.openingException?.id, openingExceptionId);
    assert.equal(c.openingException?.kind, "CASH_MISMATCH");
    assert.equal(
      c.openingException?.reasonCode.code, `${MARKER}-OPEN`,
      "and the exception still carries the reason it was authorised with"
    );
  });

  test("two sources at once are refused by the database", async () => {
    // The rule a sourceType/sourceId pair could never express.
    await clearCases();
    await assert.rejects(
      () => db.varianceCase.create({
        data: {
          cafeId, branchId, type: "STOCK",
          stockCountLineId: lineId, tenderReconciliationId: cardReconId,
          openedById: openerId,
        },
      }),
      /VarianceCase_single_source_check|constraint/i,
      "one case, one cause"
    );

    await assert.rejects(
      () => db.varianceCase.create({
        data: {
          cafeId, branchId, type: "CASH", shiftId,
          stockCountLineId: lineId, openedById: openerId,
        },
      }),
      /VarianceCase_single_source_check|constraint/i,
      "a CASH case that also names a counted line is two causes wearing one label"
    );

    await assert.rejects(
      () => db.varianceCase.create({
        data: {
          cafeId, branchId, type: "OPENING_EXCEPTION",
          openingExceptionId, tenderReconciliationId: walletReconId,
          openedById: openerId,
        },
      }),
      /VarianceCase_single_source_check|constraint/i
    );

    assert.equal(await db.varianceCase.count({ where: { cafeId } }), 0, "none were written");
  });

  test("no source at all is refused for every non-CASH type", async () => {
    await clearCases();
    for (const type of ["STOCK", "TENDER", "OPENING_EXCEPTION"] as const) {
      await assert.rejects(
        () => db.varianceCase.create({
          data: { cafeId, branchId, type, shiftId, openedById: openerId },
        }),
        /VarianceCase_single_source_check|constraint/i,
        `a ${type} case with nothing behind it is an assertion, not evidence`
      );
    }
    assert.equal(await db.varianceCase.count({ where: { cafeId } }), 0);
  });

  test("each source raises one case and no more", async () => {
    // The @unique on every source column. It is what lets an engine retry
    // safely: a second attempt collides rather than opening a twin.
    await clearCases();
    const base = {
      cafeId, branchId, type: "STOCK" as const, stockCountLineId: lineId,
      openedById: openerId,
    };
    await db.varianceCase.create({ data: base });
    await assert.rejects(
      () => db.varianceCase.create({ data: base }),
      (e: { code?: string }) => e.code === "P2002",
      "one counted line cannot be under investigation twice at once"
    );

    const other = await db.varianceCase.create({
      data: { ...base, stockCountLineId: otherLineId },
    });
    assert.equal(other.stockCountLineId, otherLineId, "a different line is a different case");

    for (const [column, first, second] of [
      ["tenderReconciliationId", cardReconId, walletReconId],
      ["openingExceptionId", openingExceptionId, otherExceptionId],
    ] as const) {
      const type = column === "tenderReconciliationId" ? "TENDER" : "OPENING_EXCEPTION";
      await db.varianceCase.create({
        data: { cafeId, branchId, type, [column]: first, openedById: openerId },
      });
      await assert.rejects(
        () => db.varianceCase.create({
          data: { cafeId, branchId, type, [column]: first, openedById: openerId },
        }),
        (e: { code?: string }) => e.code === "P2002",
        `${column} must be unique`
      );
      const distinct = await db.varianceCase.create({
        data: { cafeId, branchId, type, [column]: second, openedById: openerId },
      });
      assert.ok(distinct.id);
    }
  });

  test("Restrict refuses deleting a custody period that has cases attached", async () => {
    // Load-bearing, not decorative: a period with cases attached cannot be
    // deleted, so previous-period responsibility cannot be erased by removing
    // the record of who held the room.
    await clearCases();
    await db.varianceCase.create({
      data: {
        cafeId, branchId, type: "STOCK", stockCountLineId: lineId,
        custodyPeriodId, openedById: openerId,
      },
    });
    await assert.rejects(
      () => db.custodyPeriod.delete({ where: { id: custodyPeriodId } }),
      /Foreign key|constraint|P2003/i,
      "the custody a case names must outlive the case"
    );
  });

  test("Restrict protects every piece of source evidence", async () => {
    // A case exists because something happened. Deleting the evidence and
    // leaving the case would turn an investigation into an assertion.
    await clearCases();
    await db.varianceCase.create({
      data: {
        cafeId, branchId, type: "TENDER", tenderReconciliationId: cardReconId,
        openedById: openerId,
      },
    });
    await assert.rejects(
      () => db.tenderReconciliation.delete({ where: { id: cardReconId } }),
      /Foreign key|constraint|P2003/i
    );

    await clearCases();
    await db.varianceCase.create({
      data: {
        cafeId, branchId, type: "OPENING_EXCEPTION", openingExceptionId,
        openedById: openerId,
      },
    });
    await assert.rejects(
      () => db.openingException.delete({ where: { id: openingExceptionId } }),
      /Foreign key|constraint|P2003/i
    );

    await clearCases();
    await db.varianceCase.create({
      data: {
        cafeId, branchId, type: "STOCK", stockCountLineId: lineId,
        openedById: openerId,
      },
    });
    await assert.rejects(
      () => db.stockCountLine.delete({ where: { id: lineId } }),
      /Foreign key|constraint|P2003/i
    );
  });

  test("opening a case leaves the source record exactly as it was", async () => {
    await clearCases();
    const before = await db.stockCountLine.findUniqueOrThrow({ where: { id: lineId } });
    const reconBefore = await db.tenderReconciliation.findUniqueOrThrow({
      where: { id: cardReconId },
    });

    await db.varianceCase.create({
      data: {
        cafeId, branchId, type: "STOCK", stockCountLineId: lineId,
        quantityVariance: "-0.500", openedById: openerId,
      },
    });

    const after = await db.stockCountLine.findUniqueOrThrow({ where: { id: lineId } });
    assert.deepEqual(
      {
        counted: String(after.countedQuantity),
        effective: String(after.effectiveCountedQuantity),
        variance: String(after.varianceQuantity),
        disposition: after.disposition,
      },
      {
        counted: String(before.countedQuantity),
        effective: String(before.effectiveCountedQuantity),
        variance: String(before.varianceQuantity),
        disposition: before.disposition,
      },
      "a case is a pointer at evidence, not an edit to it"
    );
    assert.equal(
      String(reconBefore.actualAmount),
      String((await db.tenderReconciliation.findUniqueOrThrow({ where: { id: cardReconId } })).actualAmount)
    );
  });

  test("financialImpact reads back null, never zero", async () => {
    // Spec §12. A shortage nobody can price is not a shortage that cost
    // nothing, and the paired boolean is what keeps the two apart.
    await clearCases();
    const unpriced = await db.varianceCase.create({
      data: {
        cafeId, branchId, type: "STOCK", stockCountLineId: lineId,
        quantityVariance: "-0.500",
        financialImpactUnavailableReason: "MISSING_COST",
        openedById: openerId,
      },
    });
    assert.equal(unpriced.financialImpact, null, "unknown is null");
    assert.notEqual(unpriced.financialImpact, 0, "and is not zero");
    assert.equal(unpriced.financialImpactAvailable, false, "which the flag states outright");
    assert.equal(unpriced.financialImpactUnavailableReason, "MISSING_COST");

    const priced = await db.varianceCase.create({
      data: {
        cafeId, branchId, type: "STOCK", stockCountLineId: otherLineId,
        quantityVariance: "-0.500", financialImpact: "225.00",
        financialImpactAvailable: true, openedById: openerId,
      },
    });
    assert.equal(Number(priced.financialImpact), 225);
    assert.equal(priced.financialImpactAvailable, true);

    // A genuine zero is expressible and distinguishable from unknown.
    await db.varianceCase.delete({ where: { id: priced.id } });
    const genuineZero = await db.varianceCase.create({
      data: {
        cafeId, branchId, type: "STOCK", stockCountLineId: otherLineId,
        financialImpact: "0.00", financialImpactAvailable: true, openedById: openerId,
      },
    });
    assert.equal(Number(genuineZero.financialImpact), 0);
    assert.equal(
      genuineZero.financialImpactAvailable, true,
      "a priced zero and an unpriced unknown are different rows, not the same one"
    );
  });

  test("opening a case moves no stock and writes no ledger transaction", async () => {
    // A physical count is evidence. Rebasing stock is the COUNT_REBASE task's
    // job, through applyStockMutation. Nothing here may shortcut that.
    await clearCases();
    const before = await db.inventoryItem.findUniqueOrThrow({ where: { id: itemId } });
    const txnsBefore = await db.inventoryTransaction.count({ where: { cafeId } });

    await db.varianceCase.create({
      data: {
        cafeId, branchId, type: "STOCK", stockCountLineId: lineId,
        quantityVariance: "-0.500", openedById: openerId,
      },
    });

    const after = await db.inventoryItem.findUniqueOrThrow({ where: { id: itemId } });
    assert.equal(
      String(after.currentStock), String(before.currentStock),
      "the shelf figure is untouched by an investigation being opened"
    );
    assert.equal(
      after.ledgerVersion, before.ledgerVersion,
      "and the ledger version did not move — no writer ran"
    );
    assert.equal(
      await db.inventoryTransaction.count({ where: { cafeId } }), txnsBefore,
      "no stock movement was written"
    );
  });

  test("opening a case assigns responsibility to nobody", async () => {
    // Variance is not liability. Responsibility is an investigation outcome
    // recorded later, by somebody, and never a side effect of a difference
    // being found.
    await clearCases();
    const c = await db.varianceCase.create({
      data: {
        cafeId, branchId, type: "STOCK", stockCountLineId: lineId,
        custodyPeriodId, quantityVariance: "-0.500", openedById: openerId,
      },
    });
    assert.equal(c.assignedResponsibilityUserId, null, "attendance is not attribution");
    assert.equal(c.status, "OPEN", "and nothing was decided");

    // No payroll surface exists for this milestone to have touched.
    const payrollish = await db.$queryRaw<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
       WHERE table_schema = current_schema()
         AND (table_name ILIKE '%payroll%' OR table_name ILIKE '%salary%'
              OR table_name ILIKE '%deduction%' OR table_name ILIKE '%liability%')
    `;
    assert.deepEqual(payrollish, [], "no payroll table exists, so none was written to");
  });

  test("the resolution columns start empty and record who closed it", async () => {
    await clearCases();
    const c = await db.varianceCase.create({
      data: {
        cafeId, branchId, type: "STOCK", stockCountLineId: lineId,
        openedById: openerId,
      },
    });
    assert.equal(c.resolvedAt, null);
    assert.equal(c.resolvedById, null);
    assert.equal(c.resolutionNote, null);

    const resolved = await db.varianceCase.update({
      where: { id: c.id },
      data: {
        status: "RESOLVED", resolvedAt: new Date(), resolvedById: resolverId,
        resolutionNote: "أعيد العد وطابق",
      },
      include: { resolvedBy: true, openedBy: true },
    });
    assert.equal(resolved.resolvedBy?.id, resolverId);
    assert.equal(
      resolved.openedBy.id, openerId,
      "who opened it survives who closed it — two signatures, not one field"
    );
  });

  test("all six statuses and all four types store", async () => {
    const statuses = await db.$queryRaw<{ label: string }[]>`
      SELECT e.enumlabel AS label FROM pg_enum e
        JOIN pg_type t ON t.oid = e.enumtypid
       WHERE t.typname = 'VarianceCaseStatus' ORDER BY e.enumsortorder
    `;
    assert.deepEqual(
      statuses.map((s) => s.label),
      ["OPEN", "UNDER_INVESTIGATION", "RESPONSIBILITY_ASSIGNED", "APPROVED", "RESOLVED", "WAIVED"]
    );

    const types = await db.$queryRaw<{ label: string }[]>`
      SELECT e.enumlabel AS label FROM pg_enum e
        JOIN pg_type t ON t.oid = e.enumtypid
       WHERE t.typname = 'VarianceCaseType' ORDER BY e.enumsortorder
    `;
    assert.deepEqual(types.map((t) => t.label), ["CASH", "TENDER", "STOCK", "OPENING_EXCEPTION"]);
  });

  test("Shift.cashVarianceCaseId arrived with the table it points at", async () => {
    // R3.3 again, and the last of the deferred columns in this milestone.
    await clearCases();
    const c = await db.varianceCase.create({
      data: {
        cafeId, branchId, type: "CASH", shiftId,
        amountVariance: "-13.00", openedById: openerId,
      },
    });
    const shift = await db.shift.update({
      where: { id: shiftId },
      data: { cashVarianceCaseId: c.id },
      include: { cashVarianceCase: true },
    });
    assert.equal(shift.cashVarianceCase?.id, c.id, "the shift reaches its case");
    assert.equal(
      Number(shift.actualCashAmount), 487,
      "and still holds the counted drawer — the case did not replace it"
    );

    const back = await db.varianceCase.findUniqueOrThrow({
      where: { id: c.id }, include: { cashShift: true },
    });
    assert.equal(back.cashShift?.id, shiftId, "and the case reaches back");

    await assert.rejects(
      () => db.shift.update({
        where: { id: otherShiftId },
        data: { cashVarianceCaseId: c.id },
      }),
      (e: { code?: string }) => e.code === "P2002",
      "one cash case belongs to one shift"
    );
  });

  test("a reference to a row that does not exist is refused", async () => {
    await clearCases();
    await assert.rejects(
      () => db.varianceCase.create({
        data: {
          cafeId, branchId, type: "STOCK",
          stockCountLineId: `no-such-line-${MARKER}`, openedById: openerId,
        },
      }),
      /Foreign key|constraint|P2003/i
    );
    await assert.rejects(
      () => db.varianceCase.create({
        data: {
          cafeId, branchId, type: "CASH", shiftId,
          openedById: `no-such-user-${MARKER}`,
        },
      }),
      /Foreign key|constraint|P2003/i
    );
  });

  test("every source link is a real foreign key, and the CHECK exists", async () => {
    // The R3.3 proof: zero deferred foreign keys. Asserted against the
    // catalogue rather than read off the schema file, because the schema file
    // is the thing that could be wrong.
    const fks = await db.$queryRaw<{ table_name: string; column_name: string; foreign_table: string }[]>`
      SELECT tc.table_name, kcu.column_name, ccu.table_name AS foreign_table
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
        JOIN information_schema.constraint_column_usage ccu
          ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
       WHERE tc.constraint_type = 'FOREIGN KEY'
         AND tc.table_schema = current_schema()
         AND (tc.table_name = 'VarianceCase'
              OR (tc.table_name = 'Shift' AND kcu.column_name = 'cashVarianceCaseId'))
    `;
    const found = new Set(fks.map((f) => `${f.table_name}.${f.column_name}->${f.foreign_table}`));
    for (const expected of [
      "VarianceCase.cafeId->Cafe",
      "VarianceCase.branchId->Branch",
      "VarianceCase.shiftId->Shift",
      "VarianceCase.custodyPeriodId->CustodyPeriod",
      "VarianceCase.stockCountLineId->StockCountLine",
      "VarianceCase.tenderReconciliationId->TenderReconciliation",
      "VarianceCase.openingExceptionId->OpeningException",
      "VarianceCase.openedById->User",
      "VarianceCase.resolvedById->User",
      "VarianceCase.assignedResponsibilityUserId->User",
      "Shift.cashVarianceCaseId->VarianceCase",
    ]) {
      assert.ok(found.has(expected), `missing foreign key ${expected}`);
    }

    const check = await db.$queryRaw<{ definition: string }[]>`
      SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
       WHERE conname = 'VarianceCase_single_source_check'
    `;
    assert.equal(check.length, 1, "the single-source rule is a constraint, not a convention");
    assert.match(check[0].definition, /stockCountLineId/);
    assert.match(check[0].definition, /tenderReconciliationId/);
    assert.match(check[0].definition, /openingExceptionId/);
    assert.match(check[0].definition, /CASH/, "and CASH is the fourth arm");
  });

  test("the delete behaviour of every new key is the intended one", async () => {
    // Prisma defaults are not assumed. Restrict where evidence must survive,
    // SetNull where a name may be archived without deleting the record that
    // carries it, Cascade only for ownership.
    const rules = await db.$queryRaw<{ column_name: string; delete_rule: string; table_name: string }[]>`
      SELECT kcu.column_name, rc.delete_rule, tc.table_name
        FROM information_schema.referential_constraints rc
        JOIN information_schema.table_constraints tc
          ON tc.constraint_name = rc.constraint_name AND tc.table_schema = rc.constraint_schema
        JOIN information_schema.key_column_usage kcu
          ON kcu.constraint_name = rc.constraint_name AND kcu.table_schema = rc.constraint_schema
       WHERE tc.table_schema = current_schema()
         AND (tc.table_name = 'VarianceCase'
              OR (tc.table_name = 'Shift' AND kcu.column_name = 'cashVarianceCaseId'))
    `;
    const rule = (table: string, column: string) =>
      rules.find((r) => r.table_name === table && r.column_name === column)?.delete_rule;

    assert.equal(rule("VarianceCase", "cafeId"), "CASCADE", "a case belongs to its café");
    assert.equal(rule("VarianceCase", "branchId"), "CASCADE");
    assert.equal(rule("VarianceCase", "custodyPeriodId"), "RESTRICT", "custody is evidence");
    assert.equal(rule("VarianceCase", "stockCountLineId"), "RESTRICT");
    assert.equal(rule("VarianceCase", "tenderReconciliationId"), "RESTRICT");
    assert.equal(rule("VarianceCase", "openingExceptionId"), "RESTRICT");
    assert.equal(rule("VarianceCase", "shiftId"), "SET NULL", "a case outlives its shift row");
    assert.equal(
      rule("VarianceCase", "resolvedById"), "SET NULL",
      "archiving staff blanks the name, never the case"
    );
    assert.equal(rule("VarianceCase", "assignedResponsibilityUserId"), "SET NULL");
    assert.equal(
      rule("VarianceCase", "openedById"), "RESTRICT",
      "somebody opened it, and that cannot become nobody"
    );
    assert.equal(rule("Shift", "cashVarianceCaseId"), "SET NULL");
  });
});
