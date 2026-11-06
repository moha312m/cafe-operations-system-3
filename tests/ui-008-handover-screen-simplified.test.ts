import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// UI-008: the handover screen was one long page of sections and notices with
// raw codes (SUBMITTED, KG). It now leads with a step bar and the one thing to
// do next, folds secondary information, and folds the night-cash, opening and
// place panels unless something is waiting. Display only: these checks also pin
// the guards that must not move with the layout.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = (file: string) => readFileSync(path.join(root, file), "utf8");

describe("UI-008 simplified handover screen", () => {
  const detail = source("src/components/handovers/handover-detail.tsx");
  const overview = source("src/components/handovers/handover-overview.tsx");

  test("the step bar follows the existing navigation helper and names the next action", () => {
    assert.match(detail, /import \{ handoverStep \} from "\.\/workflow-state"/);
    assert.match(detail, /const step = view \? handoverStep\(view\.status, view\.count\?\.status \?\? null\) : "unknown"/);
    // Step 5: the five-step bar became the unified journey (closure, handover, incoming readiness) with one "required now" panel.
    const journey = source("src/components/handovers/handover-journey.ts");
    const parts = source("src/components/handovers/handover-workspace-parts.tsx");
    for (const id of ["count", "review", "submit", "sign", "completion"]) assert.match(journey, new RegExp(`id: "${id}", group: "handover"`));
    assert.match(detail, /buildJourney\(\{/);
    assert.match(parts, /aria-current=\{s\.state === "current" \? "step" : undefined\}/);
    // A current receiving dispute outranks the other next actions.
    assert.match(journey, /if \(i\.disputed\) return \{ \.\.\.base, title: "الاستلام معترض عليه — اطلب إعادة الجرد"/);
    assert.match(detail, /data-testid="handover-required-now"/);
  });

  test("the receiving custodian still cannot see the handed-over figures before acknowledging", () => {
    // The disclosure decision moved into the row model; the screen still passes `view.acknowledged` to it.
    assert.match(detail, /receivingRowDisplay\(line, view\.workflow\.acknowledgements\.find\(ack => ack\.stockCountLineId === line\.id\), view\.acknowledged\)/);
    const model = source("src/components/handovers/receiving-model.ts");
    assert.match(model, /disclosed \? \(line\.countedQuantity != null \? trimmed\(line\.countedQuantity\) : "—"\) : "مخفي"/);
    assert.match(model, /disclosed \? signedQuantity\(line\.varianceQuantity\) : "مخفي"/);
    assert.doesNotMatch(detail, /expectedQuantity \?\?/, "expected quantities are never rendered here");
  });

  test("actions, gates and routes are unchanged", () => {
    assert.match(detail, /canKey\("handover\.submit"\) && view\.outgoingUserId === user\.id && \["DRAFT", "REJECTED"\]\.includes\(view\.status\)/);
    assert.match(detail, /disabled=\{busy \|\| view\.status !== "DRAFT" \|\| view\.count\?\.status !== "CONFIRMED"\}/);
    assert.match(detail, /data-testid="handover-start-count"/);
    assert.match(detail, /data-testid="handover-submit"/);
    assert.match(detail, /canKey\("handover\.accept"\) && \["OUTGOING_SUBMITTED", "INCOMING_REVIEW"\]\.includes\(view\.status\)/);
    assert.match(detail, /allowReceive=\{mayReviewStock && stockReviewReady\}/);
    assert.match(detail, /incomingShift\?\.cashierId === user\.id/);
  });

  test("the item search only appears with the table it filters, units are shown in Arabic, empty returns are not shown", () => {
    assert.match(detail, /const receiptVisible = !!view && view\.count !== null && !\["DRAFT", "REJECTED"\]\.includes\(view\.status\)/);
    assert.match(detail, /\{receiptVisible && view\.count && !canReceiveLines && \(\s*<div className="space-y-2">\s*<div className="flex flex-wrap items-end gap-2">\s*<label className="block min-w-48 flex-1">بحث عن صنف/);
    assert.match(detail, /import \{ UNIT_LABEL \} from "@\/lib\/inventory"/);
    assert.match(detail, /unitLabel\(line\.unit\)/);
    assert.match(detail, /unitLabel\(i\.unitSnapshot\)/);
    assert.match(detail, /\{pendingReturns > 0 && \(/);
    const countRow = source("src/components/stock-counts/count-line-row.tsx");
    assert.match(countRow, /UNIT_LABEL\[line\.unit as keyof typeof UNIT_LABEL\] \?\? line\.unit/, "the shared count table shows units in Arabic too");
  });

  test("the money overview keeps every payment method and its test hooks, and shows statuses in Arabic", () => {
    assert.match(overview, /data-testid="handover-overview"/);
    assert.match(overview, /testId="handover-money-totals"/);
    assert.match(overview, /data-testid="handover-payment-table"/);
    assert.match(overview, /\{m\.payments\.map\(\(row\) =>/, "all rows are still rendered");
    assert.match(overview, /SUBMITTED: "مسجّلة — بانتظار الاعتماد"/);
    assert.doesNotMatch(overview, /حالة ERP/);
    assert.match(overview, /<details className="rounded-lg border" open=\{tenderDifference\}>/);
  });

  test("night cash, opening verification and place panels fold away unless something is waiting, and leave the /handovers list when empty", () => {
    const cash = source("src/components/handovers/opening-cash-panel.tsx");
    const opening = source("src/components/handovers/opening-verification-panel.tsx");
    const place = source("src/components/handovers/place-receipt-panel.tsx");
    const page = source("src/app/(app)/handovers/page.tsx");
    assert.match(cash, /<details id="handover-step-night-cash" className="rounded-xl border p-4" data-testid="opening-cash-panel" open=\{!!storage\|\|!!error\}>/);
    assert.match(cash, /if\(hideWhenEmpty&&!storage&&!error\)return null;/);
    assert.match(opening, /<details id="handover-step-opening" className="rounded-xl border p-4" data-testid="opening-verification-panel" open=\{shifts\.length>0\|\|!!loadError\}>/);
    assert.match(opening, /if\(hideWhenEmpty&&!shifts\.length&&!loadError\)return cash;/);
    assert.match(place, /<details id="handover-step-place" className="rounded-xl border p-4" data-testid="place-receipt-panel" open=\{pendingPlace > 0 \|\| !!detail \|\| !!error\}>/);
    assert.match(place, /if \(hideWhenEmpty && pendingPlace === 0 && !detail && !error\) return null;/);
    assert.match(place, /const pendingPlace = rows\.filter\(\(row\) => row\.status === "PENDING"\)\.length/);
    for (const panel of ["OpeningCashPanel", "OpeningVerificationPanel", "PlaceReceiptPanel", "CashDeliveriesPanel"]) {
      assert.match(page, new RegExp(`<${panel} [^>]*hideWhenEmpty onPending=\\{reporters\\.`), `${panel} hides when empty on the list`);
    }
  });
});
