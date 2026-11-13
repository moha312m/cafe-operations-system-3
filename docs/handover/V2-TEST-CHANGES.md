# Stock handover v2 — test changes (2026-11-13)

Source of the decisions: `C:/Dev/_test-evidence/2026-11-12/v2-test-decisions.md` (18 tests that fail only because v2, commit 8b18d1a, removed an old block). Rules cited as "Plan l.N" are in `docs/handover/STOCK-HANDOVER-V2-PLAN.md`.

Rules followed:
- No assertion was loosened. Each updated test still proves the behaviour that matters under v2. Where the test's subject is the pre-v2 path, the fixture now writes the pre-v2 gated state directly (as `handover-010` does in `openGatedShift`).
- Every line that changed beyond the line the decision table quoted is listed below, with the written v2 rule behind it. One failure is NOT tied to a written v2 rule and is recorded below as a possible regression (owner decision needed).
- The three escalated items were fixed in code first, each in its own commit with its own tests:
  - A10: commit b1c27f4, test `shv2-004`.
  - C1: commit c75eb9a, test `shv2-005`, plus the `handover-021` update.
  - C2: commit 0c517b6, test `shv2-006`, plus the `handover-008b` update.

## RETIRE (1)

| # | File | Test | Written reason |
|---|---|---|---|
| A3 | handover-p1-custody-recovery | Q3: on an unverified branch morning the second cashier waits, and nothing of their shift remains | The rule it tested was withdrawn. Plan l.11: "P1 'second opener waits' \| `POST /api/shifts` \| Second cashier refused \| Removed (contradicts v2)". Commit e0be1c9 says the rule was "superseded by the 2026-11-12 decision". Under v2 the second cashier's open returns 201, and that is the intended behaviour. No v2 behaviour is left for this test to prove. A comment in the file marks where it was. |

## UPDATE (14)

| # | File | Test | Changed | v2 rule |
|---|---|---|---|---|
| A1 | handover-p1-custody-recovery | Q2: a morning cashier who never received the shelf closes money-only | The morning shift is the legacy gated shift (`openLegacyGated`), not a route open. **Beyond the quoted line:** the last line, where the next cashier opens, now expects `custodyGateReason: null`. | Plan l.10: "the shift takes the shelf (recorded, uncounted) and sells". The money-only close exists for shifts left gated when v2 ships. |
| A2 | handover-p1-custody-recovery | Q2: a handover already stuck without stock custody can be ended by the manager's cancel | Same legacy fixture. **Beyond the quoted line:** l.142 `freezeReleased === true` failed, because v2's close takes no freeze. The fixture now writes the legacy freeze through the existing `acquireInventoryFreeze`. The release assertion is kept, unchanged. | Plan l.9 "No new freezes"; Plan l.30 "No freeze at close … legacy freezes still release through acceptance/cancel". |
| A4 | handover-p1-custody-recovery | Q1: a waiting shift whose branch lost its shelf is repaired (title now: "the shelf recorded to that shift") | Legacy gated fixture. **Beyond the quoted line**, three later lines:<br>(1) After the repair the shelf is `STOCK:USER` held by the waiting shift, not `STOCK:BRANCH`. The test now also checks `responsibleShiftId`.<br>(2) The waiting shift's gate is `null`.<br>(3) The final "start the morning verification count" (409 under v2: nothing to verify) is replaced by "the repaired shift is operational" (`custodyReadyAt`).<br>All reason, note, idempotency, OpeningException and audit-once assertions are unchanged. | Plan l.10; v2 commit 8b18d1a, `branch-custody-repair.ts`: "the shift is not held back by stock — it takes the shelf below (recorded, uncounted)". Plan l.10: "the morning count becomes the optional incoming count". |
| A5 | handover-p1-custody-recovery | Q1: a drawer nobody's open shift uses is closed at its last counted figure, and the next shift opens | The last line expects `null`. | Plan l.10. |
| A6 | handover-p1-opening-preview | an orphaned employee stock custody is not announced as a blocker the open would repair | The last line expects `null`. | Plan l.10. |
| A7 | shift-opening-custody-lifecycle | an owner ends an unfinished night handover into branch custody | The last line expects `null`. | Plan l.10. |
| A8 | shift-opening-custody-lifecycle | an orphaned employee stock custody passes to the branch on the record, and the opener takes it (was "verifies it") | The gate line expects `null`. The "opener verifies it" half is replaced, as the decision allows, by the v2 fact: the shelf moved by transfer from the branch to the opener (`USER` holder, `responsibleShiftId`, `previousPeriodId` chain). | Plan l.10. |
| A9 | shift-opening-custody-lifecycle | manager approval finishes a night handover through branch custody | The gate line expects `null`. The replay lines after it pass unchanged. | Plan l.10. |
| B1 | hnd-ux-004-two-screen-close | every shift: money then materials … (title now: "receiving difference recorded, book balance unchanged") | (1) The "missing evidence by item name" check expects 200 + `notCounted: [Beta]` instead of 409. Under v2, finishing completes the outgoing side, so in this journey Beta could not be counted afterwards and every later line (declaration, receiving sheet, second close) would lose its subject. The check therefore moved to its own handover, in the new test "finishing with an item uncounted names it and moves on". It also asserts that the gap stays a gap (NULL, not declared, not posted).<br>(2) The two balance lines expect the book figure from before receipt ("book balance unchanged", as the table says).<br>(3) **Beyond the quoted lines:** the receiver's next close (8 / 6) expects `[systemValidated false, recordedDifferences 2]`, not `[true, 0]`. The book was not rebased at receipt, so the same shelf still differs from it on both items. The cash line beside it ("shortage not found again") is unchanged. | Plan l.32 (finish with no or partial count, `notCounted`); Plan l.14 (rebase "Removed for handover counts"); decisions S2 ("The book balance stays wrong until someone authorised posts a stock adjustment"). |
| B2 | hnd-ux-004-two-screen-close | explicit refusal is still a dispute: recorded and reported, and it no longer blocks completion | Acceptance expects 200 `COMPLETED`. Added assertions: the refusal row stays `DISPUTED`, the v2 comparison has `disputedCount: 1`, and the owner is notified (C1). | Plan l.33: "no signature / dispute … refusal"; C1 fix. |
| B3 | hnd-ux-004-two-screen-close | an explicit refusal is never recorded as acceptance, even of a matching quantity or without a count | Only the last line changed: acceptance completes. The "never recorded as acceptance" assertions are kept and repeated after completion (one ACCEPTED row, two DISPUTED rows). Both refusals must reach the v2 comparison. | Plan l.33; C1 fix. |
| B4 | hnd-ux-004-two-screen-close | daily schedule: one claim per period … | The freeze count expects 0. The one-claim-per-period checks are unchanged. | Plan l.9 "No new freezes"; Plan l.30. |
| B5 | handover-count-system-validation | missing count and pending corrections cannot be automatically validated; a later movement does not make a count stale | The stale case expects `CONFIRMED` / `systemValidated`. The missing and pending-correction cases are unchanged and pass. Added: a cursor *ahead* of the ledger is still refused. | Plan l.31: "only a cursor AHEAD of the ledger is malformed … later sales do not make a count stale". |
| B6 | handover-count-system-validation | a submission replay after a later ledger movement answers the recorded validation, once | The replay expects the same answer (`CONFIRMED`, `systemValidated`) instead of a 409. Added: no second `COUNT_SYSTEM_VALIDATED` row, and no signature. | Plan l.31. |

## Changed with the fixes (not in the 14)

| Item | File | Change | Why |
|---|---|---|---|
| A10 | shift-opening-custody-lifecycle (approved correction test) | None. It passes once the code is fixed. | Fixed in code (b1c27f4): a SUBMITTED count is re-submitted at finish, and a replayed finish reports the latest declaration. New test: `shv2-004`. |
| C1 | handover-021-stock-http-journeys | The dispute branch expects completion. Added: the refusal stays DISPUTED, the comparison counts it, owner and manager are notified, a review is opened, and nothing is posted. Teardown also deletes the v2 review row before the handover, because the review row blocks deletion of its handover (Restrict). | Plan l.33; C1 fix (c75eb9a). New test: `shv2-005`. |
| C2 | handover-008b-accept-rollback | "invalid DRAFT acceptance refuses before locking a Shift" became "DRAFT acceptance takes Shift and then Handover NOWAIT". The 409 at l.387 is gone (Plan l.33: "DRAFT accepted"). The lock-order proof at l.388 is now "Shift first, then every Handover lock NOWAIT". | C2 fix (0c517b6). New test: `shv2-006`, with 32 staggered races, no 500, no deadlock in `pg_stat_database`, no double write. |
| — | hnd-ux-004-two-screen-close | Teardown deletes the v2 review row before the handover. | A sheet dispute now opens a review (C1), and the review row blocks deletion of its handover (Restrict). |
| — | direct-handover-001-cash-disposition, handover-007-recount-request, handover-008-accept, handover-020-receiving-sheet, handover-022-receiving-display | One cleanup line each: delete the v2 review row before the handover. No assertion touched. | Found by the wider run on 2026-11-13. Every failure (15, 65, 1 and 1 tests) was `StockHandoverReview_handoverId_fkey` in the reset or teardown, because their sheet disputes or differing figures now open a review (C1). All four passed on 2026-11-12. |

## Seen while testing, not changed

- `handover-count-system-validation` › "a signed current count must use a new recount round before correction" fails with "Missing expected rejection.". It fails the same way on the unchanged base 65993e3 and at e0be1c9 (2026-11-12 evidence, row 31 of `classification.md`), so it is one of the 57 baseline failures and was not touched.

## Possible regression — needs an owner decision

- **`handover-008-accept` › "v2: a bound count that is not CONFIRMED is accepted and recorded as it stands"** fails at `session.status === "SUBMITTED"` ("and it is left exactly as it was"). It failed twice alone on 3102 on 2026-11-13 (66/67).
  - Cause: the C2 fix (commit 0c517b6). When a handover is received with no confirmed outgoing count, the fix closes the unfinished count as history (LOCKED by the handover, figures untouched), the same way the owner-approved cancel of an unfinished handover does.
  - The test, and STOCK-HANDOVER-V2-REPORT l.75 ("that unfinished count stays as it is"), say the count must be left open.
  - Why C2 closes it: an open count holds the branch's single active-count slot (`StockCountSession_one_active_per_branch`). Left open, no later count at that branch, handover or ordinary, can ever start. `shv2-006` showed this in round 1 (it was a 500; it is a plain 409 now).
  - Not changed: the test, and the behaviour. The owner chooses:
    - (a) keep closing it, and update this test and the report line; or
    - (b) leave it open as written, and accept that the branch cannot count again (`shv2-006`'s last step then fails), or decide another way out.

