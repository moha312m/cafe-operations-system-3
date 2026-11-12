# Handover audit — current state

Date: 2026-11-11. Tree: `handover/integration` @ 7b44089 (= PR #5 branch `fix/handover-s1-guards` 30c40cc + docs).
Method: targeted reads and greps of this tree only. No code changed, no DB written, no test run for this audit.
Evidence labels: **CODE** = proven by reading the code path cited; **TEST** = an existing suite asserts it; **NOT VERIFIED** = inferred, not reproduced.

> The owner's own problem statement was left as a placeholder in the request. Section 4 and the ranking should be re-checked against it once written.

---

## 1. Current flow

### 1.1 Handover states (`HandoverStatus`, prisma/schema.prisma:2462)

| State | Written by | Means |
|---|---|---|
| DRAFT | `createHandoverSession` (src/lib/handover.ts:294) inside the shift close; `startHandoverCount` restart (handover.ts:669, 728) | Outgoing shift money is settled, stock still with the outgoing cashier, branch inventory frozen |
| OUTGOING_SUBMITTED | `submitHandover` / `finishOutgoingHandover` (handover.ts:1185-1225) | Outgoing count handed over, waiting for receiver |
| INCOMING_REVIEW | `acknowledgeStockLine` (handover.ts:1869) | Receiver has started signing lines |
| REJECTED | `requestRecount` (handover.ts:2111-2139) | Receiver asked for a recount; restartable (handover.ts:496) |
| COMPLETED | `acceptHandoverInTransaction` (3226), `overrideAcceptHandover`, `acceptToBranchCustody` (4137), `cancelHandoverIntoBranchCustody` (handover-cancel.ts:187), direct acceptance (handover-direct.ts) | Custody moved, freeze released, outgoing shift CLOSED |
| ACCEPTED | **never written** (grep: only read in close-guidance.ts:322, inventory-freeze.ts:193) | Dead enum value |
| MANAGER_EXCEPTION | **never written** (only read in close-guidance.ts:323) | Dead enum value; manager paths end in COMPLETED with `exceptionById` set |

"Live" = DRAFT, OUTGOING_SUBMITTED, INCOMING_REVIEW, REJECTED (`LIVE_HANDOVER_STATUSES`, custody.ts:118; same list in handover-blockers.ts:33 and handover-cancel.ts:37).

### 1.2 Related state machines
- **Shift** (`ShiftStatus`): OPEN → AWAITING_HANDOVER (close with a due materials count, cash-close.ts:613) → CLOSED (on handover completion), or OPEN → CLOSED directly when no count is due. Gate on OPEN shifts: `custodyGateReason` = AWAITING_CUSTODY_TRANSFER | AWAITING_OPENING_VERIFICATION (custody.ts:420-576).
- **Custody** (`CustodyPeriod`, schema:1643): separate CASH and STOCK periods; holder USER or BRANCH; OPEN → TRANSFERRED/CLOSED; chained by `previousPeriodId`. Writers: `openCustodyPeriod`, `transferCustody` (custody.ts:628), `finalizeCashCustodyAtFinancialClose` (handover.ts:201), `finalizeUncountedCustodies` (cash-close.ts:377), `reconcileStrandedShifts` (custody.ts:196).
- **Inventory freeze** (`InventoryFreeze`): acquired at close (`createHandoverInClose`), released at completion; guarded writer in ledger (ledger-007, rebase-005).
- **Stock count** (`StockCountSession`): DRAFT → IN_PROGRESS → SUBMITTED → (RECOUNT_REQUIRED) → CONFIRMED → LOCKED (locked by the handover that consumes it). `accountabilityContext` NONE | HANDOVER | BRANCH_OPENING_VERIFICATION.

### 1.3 Shift close → handover (src/lib/cash-close.ts `closeShiftWithSettlement`, 410-)
1. Lock shift; exclusive branch inventory lock (484).
2. Handover config enabled? then a target is mandatory: SHIFT_TO_SHIFT or BRANCH_CUSTODY (486-495).
3. BRANCH_CUSTODY needs `handover.exception` grant (509) and is refused while another shift on the branch is trading (515-521, added by PR #5).
4. Materials schedule decides if a count is due (`resolveMaterialsDecision`, 526). Not due → ordinary close, target dropped, custodies retired by `finalizeUncountedCustodies` (796).
5. Due → blockers (`handoverStartBlockers`: unserved orders, waiter-approval orders, draft purchase invoices, pending corrections, active counts, other live handovers; handover-blockers.ts:65-93). Open orders may be carried if `carryOpenOrdersOnHandover`.
6. Cash variance → VarianceCase (651-677); tender settlements (684).
7. BRANCH_CUSTODY: drawer custody closed at counted cash, no successor (716); overnight cash storage recorded if enabled (740).
8. `createHandoverInClose`: DRAFT handover, required items snapshot, freeze, audit `HANDOVER_STARTED` (handover.ts:328-410).

### 1.4 API routes and role checks

| Route | Method | Check | Service |
|---|---|---|---|
| /api/handovers | GET / POST | `handover.view` / `handover.submit` + inventoryEnabled | listHandoversForViewer / submitHandover |
| /api/handovers/[id] | GET | `handover.view` | handover-detail-payload |
| /api/handovers/[id]/acknowledge | POST | `handover.accept`; countVersion check (handover.ts:1971) | acknowledgeStockLine / acknowledgeStockSheet |
| /api/handovers/[id]/accept | POST | `handover.accept`; idempotency key | acceptHandover |
| /api/handovers/[id]/direct | GET / POST | `handover.view` / `handover.accept`; idempotency + review version | handover-direct |
| /api/handovers/[id]/request-recount | POST | `handover.request_recount`; status-guarded | requestRecount |
| /api/handovers/[id]/override-accept | POST | `handover.exception`; idempotency | overrideAcceptHandover |
| /api/handovers/[id]/to-branch-custody | POST | `handover.exception`; idempotency | acceptToBranchCustody |
| /api/handovers/[id]/approve | POST | active session + `handover.exception`; reason + note; not own handover | approveHandoverAsManager (handover-approval.ts:63) |
| /api/handovers/[id]/cancel | POST | `handover.exception` or `handover.cancel`; reason + note; not the custodian | cancelHandoverIntoBranchCustody |
| /api/handovers/[id]/issues | GET / POST | `handover.view` / any of view/accept/submit | report issue |
| /api/handover-issues/[id]/resolve | POST | `handover.manage` | resolve issue |
| /api/handovers/[id]/report | GET | `handover.view` (+ `reports.export`) | handover-report |
| /api/handovers/carried-orders | GET | `orders:read` | — |
| /api/custody/opening-verification | POST | `stock_count.start` (start) / `handover.accept` (verify) | handover-boundary.ts:507, 843 |
| /api/branches/[id]/inventory-freeze/release | POST | `handover.exception` or `handover.cancel` | ends DRAFT/REJECTED handovers via cancel; force-releases only finished ones |
| /api/branches/[id]/handover-config | GET / PATCH | session / `stock_count.configure` | handover-config |
| /api/cafe/handover-policy | GET / PATCH | `orders:create` / `settings.edit` | — |
| /api/reports/handover-accountability (+/export) | GET | **active session only at the route**; masking inside `accountabilityFromParams` | reports/handover-accountability* |
| /api/stock-counts/[id]/re-sync | POST | owner/super-admin only; refused for HANDOVER and opening counts | — |
| /api/shifts (POST open) | POST | shift permissions; `ensureCustodyForShift` | custody.ts:420 |
| /api/shifts/active | GET | `requirePermission`; computes `openingBlocker` | shifts/active/route.ts:67 |

### 1.5 Tables
HandoverSession, HandoverRequiredItem, HandoverStockBoundary, HandoverStockAcknowledgement, HandoverCarriedOrder, DeferredStockDeduction, InventoryFreeze, HandoverIssue, ShiftMaterialsDecision, CustodyPeriod, CustodyParticipant, ShiftCustody, OpeningException, OpeningCashReceipt(+Event), ShiftPlaceReceipt, CashStorage, CashStorageMovement, ShiftCashDisposition, CashDeliveryDeclaration, StockCountSession/Line/Recount/Correction/Rebase, StockVarianceSpan(+Custody), VarianceCase, AuditLog.

### 1.6 Screens
- `/handovers` (src/app/(app)/handovers/page.tsx): list, overview, detail, receiving sheet, direct-handover panel, action bar, manager action dialog (`manager-handover-action.tsx`, PR #5), branch signing, opening cash / opening verification / place receipt panels, cash deliveries panel.
- `/close-shift`: two-screen close (HND-UX-004), materials step, cash disposition.
- `/stock-counts`: count detail (handover-bound counts show the handover banner).
- POS `shift-controls.tsx`: opening requirements and the custody blocker message.
- Settings: handover config panel, handover policy card.

---

## 2. Existing tests (what each suite proves)

Run status for this audit: **NOT RUN**. Last known results: PR #5 reports 32 handover/shift/stock-count suites green on 5434 with 4 pre-existing source-pinning failures (hnd-ux-005 ×2, hnd-ux-006 ×2).

| Group | Suites | Behaviour proven |
|---|---|---|
| Schema | handover-001, handover-003, handover-004, handover-005, rebase-001, count-003/004/005, shift-005 (M20/M21), shift-006-legacy | Columns, enums, CHECKs, partial unique indexes, additive migrations. handover-005 needs `.migration-allocation.json` (env guard) |
| Start / blockers | handover-002, handover-016 | Which open orders/invoices/corrections block a close; carrying open orders when enabled |
| Freeze | handover-003, ledger-007, perf-001, rebase-005, resale-009 | Freeze is idempotent, guarded writer refuses untokened stock writes, cache invalidation, frozen intake |
| Outgoing count / submit | handover-006 (49), count-018, handover-count-match, handover-count-system-validation, handover-count-entry-* | Binding count to handover, immutable scope snapshot, incomplete submit, zero vs blank |
| Recount | handover-007 (76), count-011, rebase-004 | Reasons, state machine, recount cursor |
| Accept | handover-008 (70), handover-008b, handover-013, handover-014, handover-020, handover-021, handover-022 | Tenancy, status gates, required-items omission, staff branch scope, receiving sheet, HTTP journeys, display of differences |
| Manager paths | handover-009/009b (override), handover-010/010b (branch custody), handover-cancel-atomicity, shift-opening-custody-lifecycle (11, PR #5) | One exception per key, rollback on failure, branch custody completion, cancel/approve/release need reason+note, refusal while colleague trades |
| Cash | cashclose-001/002/003, handover-018, direct-handover-001 (42), pos-001 | Variance and reason, atomic close, custody left open for SHIFT_TO_SHIFT, opening cash verification, cash disposition split |
| Custody | custody-001/002/003/004/005/007, shift-004, shift-006-no-count, pos-conc-005 | Separate scopes, chain, BRANCH holder, bootstrap on shift open, coworker joins, two devices open one drawer |
| Shift close | shift-005, shift-007, shift-008, hnd-ux-004, shift-carryforward-001/002 | Atomic close boundary, serve/close lock order, materials cadence, retained drawer carry-forward |
| Rebase / variance | rebase-002/003, var-010, var-012, report-003/004, hndrep-001, count-variance-books (variance branch only) | Rebase replay, audit atomicity, variance attribution along the custody chain, accountability report |
| UI source-pinning | ui-003/008/009/010/012/014/016, hnd-ux-005/006, handover-023, handover-guided-workflow, handover-receiving-model, config-003 | Source text/structure assertions; they do not exercise a browser |

Gaps in tests: no suite drives the `ShiftOpeningCustodyError` paths other than the PR #5 lifecycle cases; no suite asserts the GET `/api/shifts/active` blocker agrees with what POST would do; no suite covers a live handover with `outgoingStockCustodyId = NULL`; no browser test of the manager action dialog (PR #5 says so).

---

## 3. Connection matrix

| Module | Status | Handover reads | Handover writes | Missing |
|---|---|---|---|---|
| Shifts open/close | BUILT | shift status, gate, cash totals | AWAITING_HANDOVER, CLOSED, gate reason, materials decision | Blocker preview on GET disagrees with POST (D1d) |
| Cash drawer and custody | BUILT | CASH custody, counted cash | closes/transfers CASH custody, cash variance case, opening cash receipt | No recovery for an orphaned USER cash period (D1a) |
| Treasury / banking | PARTIAL | overnight storage settings | CashStorage + movements (posted as CASH_TO_SAFE / STORED_CASH_MOVEMENT) | Cash deliveries to owner/manager are not a treasury movement and not posted (D4, NOT VERIFIED) |
| POS orders, open tables | BUILT | unserved and waiter-approval orders (blockers) | HandoverCarriedOrder, deferred stock deduction | Table-level view of what is carried — NOT VERIFIED |
| Stock counts, count variances | BUILT | bound count, lines, cursor | locks count, boundary, acknowledgements, rebase, variance cases | Count-variance posting to books is on its own branch, not here |
| Inventory adjustments | BUILT (guard only) | ledger movements via freeze guard | refuses untokened writes during freeze | Adjustments are blocked, not listed on the handover |
| Purchases, supplier deliveries | PARTIAL | DRAFT purchase invoices (blocker) | — | Deliveries received during the shift are not shown on the handover; frozen intake only covered by resale-009 |
| Expenses, petty cash | PARTIAL | expense payouts/returns inside expected cash (shifts.ts:191) | — | Not itemised on the handover; finance track owns it |
| Employee advances | NOT BUILT | — | — | No model in this tree (finance track may have it — NOT VERIFIED) |
| Attendance, payroll | NOT BUILT | — | — | No model, no link from custody to who was on shift other than the shift itself |
| Accounting journal, P&L | PARTIAL | — | indirectly: CASH_VARIANCE, CASH_TO_SAFE, STOCK_MOVEMENT (COUNT_REBASE costless here) | Count rebases carry no cost on this branch, so stock differences skip the P&L (fixed on feat/count-variance-books-sheet) |
| Reports / print / export | BUILT | everything | handover report, accountability xlsx/csv/html | Route has no permission key (D5, NOT VERIFIED) |
| Notifications | NOT BUILT | — | — | Nobody is told a handover is waiting; only correction notifications and WhatsApp shift report exist |

---

## 4. Defects

### D1. «حالة العهدة غير مكتملة في الفرع» (shift cannot open)
Source: `ShiftOpeningCustodyError` (custody.ts:127-135), thrown by `ensureCustodyForShift` (custody.ts:460-466) when no handover is mid-flight and `incompleteOpeningCustody` (custody.ts:120) returns CASH_WITHOUT_STOCK, STOCK_WITHOUT_CASH or INCONSISTENT_CUSTODY.

What PR #5 fixes (CODE + TEST shift-opening-custody-lifecycle): the reproduced case where `reconcileStrandedShifts` step 4 opened a lone CASH period on a branch with no custody, which the open then refused. It also replaces the in-place BRANCH rewrite of orphaned stock with an audited transfer.

**PR #5 does not fully close it.** Remaining paths:
- **D1a — a waiting shift holds a drawer but the branch holds no stock at all.** *Corrected in P1:* the scenario first written here cannot happen, because opening verification refuses when two shifts are waiting (handover-boundary.ts:455). The state itself is real and was found on the 5434 demo branch (P1, read-only query): shift #7 OPEN with AWAITING_OPENING_VERIFICATION, linked to an open USER drawer custody, with **no open stock custody at all**. History from the audit log: on 2026-11-04 the branch took the shelf (`CUSTODY_TRANSFERRED` to BRANCH) and #7 was re-decided onto the opening verification. Later that BRANCH period shows holderType USER, a change with no audit row (who wrote it is NOT VERIFIED; pre-PR #5 code or a test fixture). On 2026-11-06 shift #9 claimed it, then closed with no count due, and `finalizeUncountedCustodies` closed the stock period because #7 was never linked to it. Result: every new opener gets CASH_WITHOUT_STOCK, and #7 can never be verified. Reconcile has no step for it, and there is no screen action. Production (5433) ran pre-PR #5 code, so the same state may exist there (NOT VERIFIED; 5433 not read). This stale state is also why `pos-conc-005` (which uses the shared demo café) fails 4/4 on both the base and P1.
- **D1b — live handover without a stock custody.** `branchIsMidHandover` ignores handovers whose `outgoingStockCustodyId` is NULL (custody.ts:185), while reconcile skips entirely when any live handover exists (custody.ts:207-208). Cancel refuses it (`CANCEL_NO_STOCK_CUSTODY`, handover-cancel.ts:120). **Reproduced in P1 on real routes:** on a branch-custody morning a cashier opens (gated, drawer only) and closes SHIFT_TO_SHIFT before the morning count. The close is accepted, a DRAFT handover is created with `outgoingStockCustodyId = NULL`, and the branch inventory is frozen. Cancel and freeze release both answer 409 «مفيش عهدة مخزن مربوطة بالتسليم ده». The next shift opens gated and **joins the departed cashier's drawer** as a shared holder. The freeze and the live handover stay with no way out.
- **D1e — two cashiers on an unverified branch-custody morning (reproduced in P1).** The second opener joins the first one's drawer and is also gated; the morning count then refuses both («في أكتر من وردية مستنية الجرد الافتتاحي», handover-boundary.ts:455). Recovery today is that one of them closes their shift.
- **D1c — INCONSISTENT_CUSTODY** needs a BRANCH-held cash period, which custody-004 shows is refused on creation; only legacy rows. (CODE + TEST)
- **D1d — the warning is shown when the open would succeed, and points to a screen with no fix.** *The preview half is fixed in P1* (`predictOpeningBlocker`, tests/handover-p1-opening-preview.test.ts); the "no fix on the screen" half remains. PR #5 removed reconciliation from GET `/api/shifts/active` (diff on shifts/active/route.ts), but the blocker there is still computed from raw rows (route.ts:67). An orphaned USER stock period with open cash shows STOCK_WITHOUT_CASH on GET while POST would reconcile and open. The message (shift-controls.tsx:268-270) tells the cashier to ask a manager to fix it from «التسليم والاستلام», but the blocker is only shown when there is no live handover, and every manager action there needs a handover id. No custody-repair route exists (grep: `reconcileStrandedShifts` is called only from custody.ts).

Reproduction (for a later phase, on 5434): build the D1a sequence through the HTTP routes, then call POST /api/shifts as a third cashier, and expect 409 with code CASH_WITHOUT_STOCK.

### P1 resolution of D1 (owner decisions 2026-11-11: Q1 manager button, Q2 money-only close, Q3 second opener waits)
| Path | Change | Proof |
|---|---|---|
| D1d preview | `predictOpeningBlocker` shares `orphanedUserStock` with the open | tests/handover-p1-opening-preview.test.ts |
| D1a / one-sided custody | ADD `POST /api/branches/:id/custody-repair` + `src/lib/branch-custody-repair.ts` + POS button. One transaction under the branch's exclusive inventory lock; refused while any handover is live or when nothing is wrong; idempotency key replays. A drawer in use stays its shift's, and the shift waits on the morning count. A drawer nobody uses closes at its last shift's counted cash. The shelf goes to a BRANCH stock custody, uncounted. OpeningException MANAGER_ADJUSTMENT plus audit `BRANCH_CUSTODY_REPAIRED` | tests/handover-p1-custody-recovery.test.ts (Q1 ×4) |
| D1b source | CHANGE `closeShiftWithSettlement`: a shift with no open STOCK link closes money-only (no handover, freeze or materials decision; audit `shiftHeldStock:false`) | recovery test Q2 #1 |
| D1b existing | CHANGE `cancelHandoverIntoBranchCustody`: a stockless handover ends without a boundary or stock transfer; the shelf is left as it was | recovery test Q2 #2 |
| D1e | CHANGE `POST /api/shifts`: a new shift that would wait on an opening verification is refused while another shift already waits (serialised by the branch allocator lock) | recovery test Q3 |

The existing refusal of one-sided custody at shift open (`shift-opening-custody-lifecycle` "one-sided custody stays blocked") is unchanged.

### D2. Two dead handover states
ACCEPTED and MANAGER_EXCEPTION exist in the enum and are read in UI/guards but never written (grep). Harmless today; misleading for reports and for anyone adding a state. (CODE)

### D3. Duplicate audit row on re-decided gates
With 2+ shifts waiting, the second gets a duplicate `SHIFT_CUSTODY_GATE_REDECIDED` row (known edge in PR #5 body). (Reported by PR #5, NOT VERIFIED here.)

### D4. Cash handed to owner/manager is not in the books
`CashDeliveryDeclaration` (DECLARED → CONFIRMED) is counted by the accounting close checklist (close-checklist.ts:56-58) but no projection posts it (no sourceType for it in src/lib/accounting). Cash collected is debited to CASH_DRAWER; cash leaving the drawer to the owner has no credit, so the drawer balance in the books is likely overstated. (CODE for "not posted"; the overstatement is NOT VERIFIED.) **Finance track overlap — owner decision.**

### D5. Accountability report route has no permission key
`/api/reports/handover-accountability` and `/export` call only `requireActiveSession` before running the report; masking and branch scoping happen inside (`handover-accountability-request.ts:15-45`). Whether a plain cashier can read other employees' variances is NOT VERIFIED.

### D6. Count differences from handovers carry no cost on this branch
`applyAcceptedReceivingCounts` (handover.ts ~3438) and `rebaseFromCount` write COUNT_REBASE without unit/total cost, so the books list them as exceptions ("حركة مخزون من غير تكلفة"). Fixed on `feat/count-variance-books-sheet`, not merged here. (CODE + TEST count-variance-books on that branch)

---

## 5. Dead ends (states a branch can get stuck in)

| Stuck state | Why | Recovery today |
|---|---|---|
| Shift cannot open: CASH_WITHOUT_STOCK / STOCK_WITHOUT_CASH with no live handover | D1a, D1b | **P1:** «إصلاح عهدة الفرع» on the POS blocker (owner / handover.exception / handover.cancel, reason + note). INCONSISTENT_CUSTODY still needs a developer |
| Live handover with no stock custody | Cancel refused (`CANCEL_NO_STOCK_CUSTODY`) | **P1:** cancel (and freeze release) end it; P1 also stops the close from creating one |
| Two cashiers waiting on one branch-morning count | D1e | **P1:** the second opener is refused until the count is done; existing doubles: one closes |
| Handover whose stock is shared with another trading shift | Cancel refused (`CANCEL_STOCK_SHARED`, handover-cancel.ts:135) | Wait until the other shift closes |
| Café with no active HANDOVER reason codes | Cancel / approve / release all demand one (`assertHandoverReason`) | Owner creates a reason code first (NOT VERIFIED whether seeds create one) |
| Shift gated AWAITING_OPENING_VERIFICATION with no branch stock | Reconcile step 3 only re-decides AWAITING_CUSTODY_TRANSFER | None (NOT VERIFIED on data) |
| Shift AWAITING_HANDOVER, handover COMPLETED | — | Self-heals at the next shift open (reconcile step 1) |
| Orphaned USER stock | — | Self-heals at the next shift open (reconcile step 2, audited) |
| Freeze left by a DRAFT/REJECTED handover | — | Freeze release route ends it via cancel (PR #5) |

---

## 6. Displays numbers without enforcing or recording

- **Direct handover** (`directHandover`): the receiver acknowledges one reviewed summary, "not a count and not a per-line signature" (schema comment, HandoverSession). The stock figures are accepted on sight.
- **Retained drawer cash carried forward**: the next shift's opening is set to the retained amount with audit `independentVerification: false` (custody.ts:390-411) unless the opening cash receipt flow is on.
- **Cash deliveries panel**: shows DECLARED deliveries; nothing posts them (D4).
- **GET /api/shifts/active custody blocker**: a preview that can disagree with the real open (D1d).
- **Accountability report / handover report**: read-only views; disputed deliveries shown apart (hndrep-001) but they create no task or notification.
- **Carried orders**: recorded (HandoverCarriedOrder), but the receiving shift is not required to acknowledge them — NOT VERIFIED.

---

## 7. Integrity risks

| Risk | Current protection | Gap |
|---|---|---|
| Double submit | Idempotency keys on accept, approve, override, to-branch-custody, direct, issues, cash deliveries; status-guarded updateMany everywhere; cancel returns `alreadyCompleted` | request-recount, count submit/line routes, re-sync rely on status/version guards only: a retry gets a 409 instead of the first answer (NOT VERIFIED per route) |
| Two devices | Row locks (`FOR UPDATE` handover, `FOR SHARE` mid-handover probe), exclusive inventory lock at close and cancel, pos-conc-005 one drawer | Second device sees a 409, not "already done", on some routes |
| Stale screen | countVersion on acknowledge (handover.ts:1971), directReviewVersion on direct acceptance | Plain accept / override / to-branch-custody / cancel do not carry a version of what the manager looked at |
| Failure halfway | Close, cancel, accept, override, branch custody all one transaction; rollback suites 008b, 009b, 010b, cashclose-002, rebase-003 | None found |
| Unknown outcome retries | Receiving model keeps the same request key on lost responses (handover-receiving-model) | Not checked for the cancel/approve dialog (NOT VERIFIED) |
| Freeze vs colleague still trading | SHIFT_TO_SHIFT close with a colleague open freezes the branch shelf | Whether the colleague's sales are refused during the freeze is NOT VERIFIED (resale-009 covers intake only) |

---

## 8. Overlap with other worktrees and the finance track

| Worktree / branch | Overlap |
|---|---|
| `feat/count-variance-books-sheet` (nextcup-variance-books) | stock-count screen, handover.ts (cost on receiving rebase), stock-rebase.ts, purchase-posting.ts. Committed and merged with PR #5 on that branch; PR not yet opened |
| `feature/hnd-cash-01` (cafe-ops-finance-f1) | 11 commits touching handover/cash-close; HND-CASH-01 named cash deliveries. **Finance track** — owns D4 |
| `feature/finance-f1-purchase-payments` (PR #4) | 9 commits touching handover paths (older lineage). **Finance track** |
| `release/pilot-r10-20261027` (nextcup-release-r10, PR #3) | 5 commits + 32 uncommitted handover files (HND-UX-004 work). Do not touch |
| `cafe-ops-finance-preview` (detached) | 17 uncommitted handover files. Do not touch |
| `codex/stage2-inventory-integration` | 8 commits touching handover paths (inventory idempotency) |
| `nextcup-combined-check` (detached) | uncommitted `src/lib/handover.ts` |

Whether those branches' handover commits are already superseded by main is NOT VERIFIED.

---

## Top 10 gaps, ranked

1. **Shift cannot open with «حالة العهدة غير مكتملة في الفرع» and there is no button to fix it** (D1a, D1b, D1d). PR #5 closes one cause only.
2. **No manager "repair branch custody" action** for states with no live handover (section 5).
3. **Cash handed to the owner/manager never reaches the books** (D4). Finance track.
4. **Handover stock differences carry no cost on this branch**, so they miss the P&L (D6). Fix waiting on the count-variance PR.
5. **Direct handover accepts stock figures without counting** (section 6). This is a business decision.
6. **No notifications**: nobody is told a handover, cash delivery or recount is waiting.
7. **Manager actions don't check a screen version**, so a manager can act on a stale page (section 7).
8. **Purchases, expenses and advances are invisible on the handover**: the receiver doesn't see what came in or went out during the shift.
9. **Dead states ACCEPTED and MANAGER_EXCEPTION** confuse guards and reports (D2), and there is a duplicate gate audit row (D3).
10. **Accountability report route has no permission key** (D5, NOT VERIFIED). There is also no test that the shift-open preview matches the real open.
