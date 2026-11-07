// SHIFT-CF-001 — the pure halves of three operational fixes. No database.
//
//   1. A save carrying items and a cadence persists HYBRID unless the owner
//      switched counting off in that save, and the screens say what follows.
//   2. The open dialog's carry-forward: a direct handover waiting comes first,
//      then night storage (blind unless the viewer may see reports), then the
//      previous shift's retained drawer, then nothing.
//   3. Every variance row says branch, shift #, employee, expected, actual and
//      a signed shortage/overage, for all four case types.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  HANDOVER_DISABLED_BANNER, materialsNextLine, savedPolicyOverride, selectedCountSummary,
} from "@/lib/handover-enablement";
import { decideMaterialsCount } from "@/lib/materials-schedule";
import { pickCarryforward } from "@/lib/opening-carryforward";
import {
  CONFIDENCE_LABEL, NO_REASON, OVERAGE_LABEL, SHORTAGE_LABEL, formatVarianceRow, matchesVarianceSearch, signedFigure, type VarianceRow,
} from "@/components/variances/variance-format";

describe("bug 1 — selected items and a cadence turn the materials count on", () => {
  test("a save with selected items + EVERY_SHIFT persists HYBRID; only an explicit switch-off persists NO_SHIFT_COUNT", () => {
    const save = { currentlyEnabled: false, finalMode: "SELECTED" as const, finalSelectedCount: 2, materialsStated: true };
    assert.equal(savedPolicyOverride({ ...save, enabled: undefined }), "HYBRID");
    assert.equal(savedPolicyOverride({ ...save, enabled: true }), "HYBRID");
    assert.equal(savedPolicyOverride({ ...save, enabled: false }), "NO_SHIFT_COUNT");
    // Nothing active and nothing said: the override is left alone.
    assert.equal(savedPolicyOverride({ ...save, enabled: undefined, finalSelectedCount: 0, materialsStated: false }), undefined);
    // Already counting: an ordinary save does not rewrite the policy.
    assert.equal(savedPolicyOverride({ ...save, enabled: undefined, currentlyEnabled: true }), undefined);
  });

  test("EVERY_SHIFT makes materials due at every close, and the screens say what follows", () => {
    const decision = decideMaterialsCount({ at: new Date(), lastClaimedPeriod: null, schedule: { cadence: "EVERY_SHIFT", weekday: null, cutoff: null, since: null, timezone: "Africa/Cairo" } });
    assert.equal(decision.due, true);
    assert.equal(decision.reason, "EVERY_SHIFT");
    assert.equal(
      materialsNextLine([{ name: "بن" }, { name: "لبن" }]),
      "الخطوة التالية: جرد الخامات المطلوبة لهذا الشيفت (عدد 2 صنف: بن، لبن)",
    );
    assert.equal(
      selectedCountSummary(["بن", "لبن", "سكر", "شاي"]),
      "مفعّل: جرد إلزامي لـ 4 صنف (مثل: بن، لبن، سكر…) عند إغلاق الشيفت حسب الجدول المحدد",
    );
    assert.equal(selectedCountSummary([]), null);
    assert.match(HANDOVER_DISABLED_BANNER, /^تنبيه: جرد تسليم الشيفت غير مفعّل حاليًا لهذا الفرع/);
  });
});

describe("bug 2 — the open dialog shows the drawer it takes over", () => {
  const previous = { shiftNumber: 7, cashierName: "منى", status: "CLOSED", retainedAmount: "500.00", consumedByOtherShift: false };

  test("a closed shift's retained 500 is the next opening", () => {
    assert.deepEqual(pickCarryforward({ previous, pendingHandover: null, overnight: null, canSeeBlindAmounts: false }), {
      source: "CASH_DISPOSITION", expectedOpeningCash: "500.00", previousShiftNumber: 7, previousCashierName: "منى", pendingDirectHandoverId: null,
    });
  });

  test("never twice: a handover already gave it to another shift, or the previous shift is still settling", () => {
    assert.equal(pickCarryforward({ previous: { ...previous, consumedByOtherShift: true }, pendingHandover: null, overnight: null, canSeeBlindAmounts: true }).source, "NONE");
    assert.equal(pickCarryforward({ previous: { ...previous, status: "AWAITING_HANDOVER" }, pendingHandover: null, overnight: null, canSeeBlindAmounts: true }).source, "NONE");
  });

  test("a waiting direct handover comes first; night storage stays blind for a cashier", () => {
    const pending = pickCarryforward({ previous, pendingHandover: { id: "h1", retainedAmount: "500.00" }, overnight: { amount: "300.00" }, canSeeBlindAmounts: false });
    assert.equal(pending.source, "PENDING_HANDOVER");
    assert.equal(pending.pendingDirectHandoverId, "h1");
    assert.equal(pending.expectedOpeningCash, "500.00");
    const night = pickCarryforward({ previous, pendingHandover: null, overnight: { amount: "300.00" }, canSeeBlindAmounts: false });
    assert.equal(night.source, "OVERNIGHT_SAFE");
    assert.equal(night.expectedOpeningCash, null, "the incoming cashier counts the night drawer blind");
    assert.equal(pickCarryforward({ previous, pendingHandover: null, overnight: { amount: "300.00" }, canSeeBlindAmounts: true }).expectedOpeningCash, "300.00");
  });
});

describe("bug 3 — every variance row is readable on its own", () => {
  const cashier = { id: "u1", name: "منى" };
  const shift = {
    id: "s1", shiftNumber: 12, openedAt: "2026-11-07T07:00:00.000Z", openingCashAmount: "500.00", expectedCashAmount: "800.00",
    actualCashAmount: "750.00", cashDifference: "-50.00", cashReasonNote: "  فكة ناقصة  ", cashier,
  };
  const core = { status: "OPEN" as const, quantityVariance: null, amountVariance: null, financialImpact: null, financialImpactAvailable: false, blocking: false, openedAt: "2026-11-07T15:00:00.000Z", branch: { id: "b1", name: "فرع المعادي" } };

  test("CASH: branch, shift #, cashier, expected/actual, signed shortage, the reason and the opening drawer", () => {
    const f = formatVarianceRow({ ...core, id: "c1", type: "CASH", amountVariance: "-50.00", cashShift: shift, shift });
    assert.equal(f.branchName, "فرع المعادي");
    assert.equal(f.shiftNumber, 12);
    assert.equal(f.employeeName, "منى");
    assert.equal(f.typeLabel, "نقدية الدرج");
    assert.equal(f.expected, "800.00");
    assert.equal(f.actual, "750.00");
    assert.equal(f.difference, "-50.00");
    assert.equal(f.direction, "SHORTAGE");
    assert.equal(f.directionLabel, SHORTAGE_LABEL);
    assert.equal(f.openingCash, "500.00");
    assert.equal(f.reason, "فكة ناقصة");
    assert.equal(signedFigure(f.difference, 2), "−50.00");
  });

  test("TENDER: the Arabic method, an overage, and «بدون سبب مسجل» when nobody wrote one", () => {
    const f = formatVarianceRow({ ...core, id: "c2", type: "TENDER", amountVariance: "30.00", shift,
      tenderReconciliation: { id: "t1", method: "CARD", expectedAmount: "1000.00", actualAmount: "1030.00", varianceAmount: "30.00", reasonNote: null } });
    assert.equal(f.typeLabel, "تحصيل إلكتروني — ماكينة الكارت (فيزا)");
    assert.equal(f.expected, "1000.00");
    assert.equal(f.actual, "1030.00");
    assert.equal(f.direction, "OVERAGE");
    assert.equal(f.directionLabel, OVERAGE_LABEL);
    assert.equal(f.reason, NO_REASON);
    assert.equal(signedFigure(f.difference, 2), "+30.00");
    const wallet = formatVarianceRow({ ...core, id: "c2w", type: "TENDER", amountVariance: "-5.00", shift,
      tenderReconciliation: { id: "t2", method: "WALLET", expectedAmount: "100.00", actualAmount: "95.00", varianceAmount: "-5.00", reasonNote: "تحويل متأخر" } });
    assert.equal(wallet.typeLabel, "تحصيل إلكتروني — محفظة إلكترونية");
  });

  test("STOCK: the item, quantities with the unit, the cost, and the custody's responsible cashier", () => {
    const row: VarianceRow = { ...core, id: "c3", type: "STOCK", quantityVariance: "-0.250", financialImpact: "112.50", financialImpactAvailable: true, shift,
      custodyPeriod: { id: "p1", scope: "STOCK", status: "CLOSED", responsibleShift: { id: "s1", shiftNumber: 12, cashier: { id: "u2", name: "كريم" } }, participants: [] },
      stockCountLine: { id: "l1", unit: "KG", expectedQuantity: "2.000", countedQuantity: "1.750", effectiveCountedQuantity: "1.750", varianceQuantity: "-0.250", reasonNote: null, inventoryItem: { id: "i1", name: "بن", unit: "KG" } } };
    const f = formatVarianceRow(row);
    assert.equal(f.typeLabel, "مخزون — بن");
    assert.equal(f.isMoney, false);
    assert.equal(f.unit, "KG");
    assert.equal(f.expected, "2.000");
    assert.equal(f.actual, "1.750");
    assert.equal(f.direction, "SHORTAGE");
    assert.equal(f.costImpact, "112.50");
    assert.equal(f.employeeName, "كريم");
    assert.equal(signedFigure(f.difference, 3), "−0.250");
    assert.equal(formatVarianceRow({ ...row, financialImpactAvailable: false }).costImpact, null, "unvalued is not zero");
    assert.ok(matchesVarianceSearch(row, "بن"));
    assert.ok(matchesVarianceSearch(row, "#12"));
    assert.ok(matchesVarianceSearch(row, "كريم"));
    assert.equal(matchesVarianceSearch(row, "شاي"), false);
  });

  test("OPENING_EXCEPTION: proposed/actual, the reason label, and an assignee named over the cashier", () => {
    const f = formatVarianceRow({ ...core, id: "c4", type: "OPENING_EXCEPTION", amountVariance: "-20.00", shift, assignedResponsibility: { id: "u3", name: "سارة" },
      openingException: { id: "o1", kind: "CASH_MISMATCH", proposedAmount: "500.00", actualAmount: "480.00", varianceAmount: "-20.00", note: "عدّ الصبح", reasonCode: null } });
    assert.equal(f.typeLabel, "استثناء فتح — فرق نقدية الافتتاح");
    assert.equal(f.expected, "500.00");
    assert.equal(f.actual, "480.00");
    assert.equal(f.direction, "SHORTAGE");
    assert.equal(f.employeeName, "سارة");
    assert.equal(f.reason, "عدّ الصبح");
    const coded = formatVarianceRow({ ...core, id: "c5", type: "OPENING_EXCEPTION", shift,
      openingException: { id: "o2", kind: "MANAGER_ADJUSTMENT", proposedAmount: null, actualAmount: null, varianceAmount: null, note: null, reasonCode: { id: "r1", code: "SAFE", label: "تسوية خزنة" } } });
    assert.equal(coded.typeLabel, "استثناء فتح — تسوية خزنة");
    assert.equal(coded.direction, "UNKNOWN", "no figure recorded is not a zero difference");
  });

  test("confidence labels are Arabic", () => {
    assert.equal(CONFIDENCE_LABEL.VERIFIED, "موثّق بجرد معتمد");
    assert.equal(CONFIDENCE_LABEL.PARTIAL, "مبدئي");
    assert.equal(CONFIDENCE_LABEL.UNVERIFIABLE, "تقديري");
  });
});
