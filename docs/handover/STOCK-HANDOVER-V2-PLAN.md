# Stock handover v2 — counting and reporting, never blocking (owner decision 2026-11-12)

Branch: `handover/p1-shift-open-custody` (worktree `C:/Dev/cafe-ops-handover-p1`), on top of P1 save point e0be1c9. Local only, nothing pushed.
Decisions: DB changes named date-time-unique (checked against all worktrees); P1 committed as a save point and built on.

## What blocks today (inspected 2026-11-12)
| Mechanism | Where | Effect today | v2 |
|---|---|---|---|
| Inventory freeze | `createHandoverInClose` → `acquireInventoryFreeze` (src/lib/handover.ts); checked by `applyStockMutation` and every stock writer via `inventory-freeze.ts` | Purchases, adjustments, transfers, counts refused; sales deferred (`DeferredStockDeduction`) until acceptance | No new freezes. Guards stay (they act only on an active freeze). Existing active freezes: retired through the existing owner release / cancel paths, history kept |
| Stock gate `AWAITING_OPENING_VERIFICATION` | `ensureCustodyForShift` (src/lib/custody.ts); `getActiveShift` sells only when the gate is null | The morning shift cannot sell until the opening count is verified | Removed for stock: the shift takes the shelf (recorded, uncounted) and sells; the morning count becomes the optional incoming count |
| P1 "second opener waits" | `POST /api/shifts` | Second cashier refused | Removed (contradicts v2) |
| Gate `AWAITING_CUSTODY_TRANSFER` | `ensureCustodyForShift` mid-handover | Incoming cannot sell until acceptance | Kept for the CASH handover only; acceptance no longer requires any stock step |
| Acceptance stock requirements | `acceptHandoverInTransaction`: signed receiving sheet, required items, outgoing count submitted | Acceptance refused until every line signed / items counted | Removed; acceptance = cash receipt; counts are separate records |
| Rebase on acceptance / verification | `applyAcceptedReceivingCounts`, `rebaseFromCount` via handover, opening verification | A count becomes the stock balance | Removed for handover counts; adjustments only via the existing authorized adjustment process, linked back |
| Automatic stock variance cases | acceptance / verification | A count difference opens a case naming an employee | Removed for handover counts; replaced by comparison + review (cash cases unchanged) |
| Count-related close blockers | `handoverStartBlockers` (active count, pending corrections) | Close refused | No longer block; listed on the handover as warnings. Order blockers (unserved / waiter approval) and the open-handover rule for cash stay |

## New records (one migration, test DB only)
- `StockHandoverCount` role marker: outgoing = the existing handover count session; incoming = a second `StockCountSession` linked to the same handover with role INCOMING (blind; quantities of the outgoing never sent to the incoming before submit). Lines keep `countedAt` (physical time per item) and `itemVersion` (ledger cursor) — both already exist.
- `StockHandoverReview`: one per handover: status (OPEN, IN_REVIEW, REVIEWED, RESOLVED), classification, reviewer; notes as append-only `StockHandoverReviewNote` rows (actor, time, text, classification change).
- `Notification`: recipient, cafe, branch, kind (STOCK_HANDOVER_DISCREPANCY | STOCK_HANDOVER_MISSING_COUNT), handover, dedupe key unique per (handover comparison version, recipient, kind), payload JSON, created, read, delivery attempts / delivered at. In-app delivery; the row is written in the same transaction as the submission that triggers it.

## Comparison (pure function, decimal-safe)
Per item, same unit (existing conversions only; incompatible units never totalled):
raw = incoming − outgoing; net movement = Σ InventoryTransaction.quantity with outgoing.itemVersion < ledgerVersion ≤ incoming.itemVersion (cursor boundary: exact, no double count); expected = outgoing + net; adjusted = incoming − expected.
Reliability: CONFIRMED when both lines carry a cursor; PROVISIONAL when a cursor is missing (falls back to countedAt window, labelled); UNAVAILABLE when a count is missing (never zero-filled).
Labels: raw ≠ 0 and adjusted = 0 → «فرق مفسَّر بحركات مسجلة»; adjusted ≠ 0 → «فرق غير مفسَّر — مطلوب مراجعة»; raw = 0 and adjusted ≠ 0 → alert as unexplained; both 0 → no alert.

## As implemented (2026-11-12, uncommitted on top of e0be1c9)
- No freeze at close (`createHandoverInClose` returns `freezeId: null`); legacy freezes still release through acceptance/cancel.
- Count evidence is judged at each line's own ledger cursor (`handover-count-match.ts`: only a cursor AHEAD of the ledger is malformed); recorded evidence keeps the line's own cursor, so later sales do not make a count stale. A freeze is no longer required for system validation.
- Outgoing finish: no count, a partial count, or an unconfirmed count all finish (`notCounted` and `countStatus` returned as warnings). COUNT_NOT_CONFIRMED retired; a missing outgoing count notifies manager + owner.
- Acceptance (shift and branch): DRAFT accepted; no signature / dispute / required-item / pending-correction refusal; no rebase, no receiving-count postings, no automatic stock variance case (cash case unchanged). Required items are recorded omitted when uncounted. Boundary rows and the count lock are still written when a confirmed count exists.
- Direct handover: receivable from DRAFT once the cash disposition exists; the outgoing stock figures are hidden from the incoming employee until their own blind count is submitted.
- Migration `20261112090000_stock_handover_v2` (additive): `StockHandoverIncomingCount`, `StockHandoverIncomingLine` (append-only revisions, UPDATE refused by trigger, reason required from revision 2), `StockHandoverComparison` (one row per input version), `StockHandoverReview` + `StockHandoverReviewNote` (append-only), `Notification` (unique `dedupeKey`). Applied ONLY to the new disposable DB `cafe_ops_test_shv2` on 5434.
- Library: `stock-handover-compare.ts` (pure, integer thousandths), `stock-handover-v2.ts` (evidence, comparison, notifications, incoming count), `stock-handover-review.ts` (report, detail, notes, xlsx).
- Routes: `GET/POST /api/handovers/:id/incoming-count`, `GET /api/stock-handover-reports` (+`?format=xlsx`), `GET/POST /api/stock-handover-reports/:handoverId`, `GET/POST /api/notifications`.
- Screens: `/handovers/incoming-count`, `/reports/stock-handovers`, `/notifications`; links from the handover screen, the nav and the report center.
- P1 worktree now has its own `node_modules` (junctions + real `.prisma` and `@prisma/client`), so its client generation cannot touch another worktree. Test server: 3102 → `cafe_ops_test_shv2`.

## Order of work
1. Stop creating freezes; remove stock gates and P1 second-opener rule; acceptance without stock requirements; no rebase / no automatic stock cases. Update the tests that pin the old blocking.
2. Migration + incoming count + comparison + notifications (same transaction as the submission, retry-safe via the dedupe key).
3. Report (side by side, movements, reliability, review history), filters, export; manager/owner review with append-only notes.
4. Screens (Arabic RTL, phone): outgoing count unchanged; incoming blind count; notifications list; report and review.
