# Step 5 — handover workflow, journey guidance and report (2026-11-04)

Branch `codex/nextcup-workspace-redesign-20261102`, base `a6fa68b`. Status: **implemented and tested locally; browser verification and owner acceptance are separate lines below.** Authoritative rules stay in the server services (`handover.ts`, `custody.ts`, `cash-close.ts`, `opening-readiness.ts`, `overnight-cash.ts`, `place-receipts.ts`); the screen only reads them.

## 1. Three facts the old screen mixed up

| Fact | Done when | Where it is decided |
|---|---|---|
| Outgoing **financial closure** | The closing shift's money is settled (`financiallyClosedAt`; shift `AWAITING_HANDOVER` or `CLOSED`). | `closeShiftWithSettlement` (`cash-close.ts`) |
| **Handover completion** | `HandoverSession.status = COMPLETED` (accepted, exception-accepted, or converted to branch custody). | `acceptHandover`, `overrideAcceptHandover`, `acceptToBranchCustody` (`handover.ts`) |
| Incoming shift **operational readiness** | The shift's `custodyGateReason` is null, its opening-cash receipt (when one exists) is `ACCEPTED`/`OVERRIDDEN`, and a place receipt is accepted when the branch requires it. | `assertOpeningReady` (`opening-readiness.ts`), enforced on POS/API |

Any one can be true while another is not: the closure can be done long before the handover is signed, and a completed handover can still leave the next shift on `AWAITING_OPENING_VERIFICATION` or waiting for its cash or place receipt. A shift cannot become operational while its custody gate is set, so readiness never runs ahead of the handover.

## 2. Transition matrix (derived from the server rules)

| # | State | Responsible | Permission / key | Prerequisite | Action → resulting state | Blocker (server message class) |
|---|---|---|---|---|---|---|
| 1 | Shift `OPEN` | Closing cashier (or manager) | close-shift grants; `handoverException` grant to choose BRANCH_CUSTODY | cash count, tender reconciliation, open orders handled or carried | Close → shift `AWAITING_HANDOVER`; handover `DRAFT`; stock frozen; (BRANCH_CUSTODY) drawer discharged | open/unserved orders, missing cash reason, handover config error |
| 2 | Handover `DRAFT`, no count | Outgoing user | `handover.submit` | config valid (`SELECTED_WITH_NO_ITEMS` refuses) | `start_count` → count session bound (`DRAFT`/`IN_PROGRESS`) | config error |
| 3 | Count capturing | Outgoing user | `stock_count.*` | required items | count lines, submit count → `SUBMITTED` | uncounted required items |
| 4 | Count `SUBMITTED` | Reviewer with `stock_count.confirm` (skipped when the system validates a matching count) | `stock_count.confirm` | corrections resolved | confirm → `CONFIRMED` (or system-validated) | pending corrections |
| 5 | Count `CONFIRMED`, handover `DRAFT` | Outgoing user | `handover.submit` | count confirmed, required items | `submit` → `OUTGOING_SUBMITTED` | incomplete required items |
| 6a | `OUTGOING_SUBMITTED` / `INCOMING_REVIEW`, **SHIFT_TO_SHIFT** | The incoming shift's cashier only | `handover.accept` | exactly one open shift gated `AWAITING_CUSTODY_TRANSFER` | sign sheet/lines (independent count, or "without count", or refuse) | no incoming shift; more than one candidate; not the recipient |
| 6b | same, dispute | Anyone with `handover.request_recount` | `handover.request_recount` | a disputed line | request recount → `REJECTED` (old round superseded) → back to step 2 | — |
| 6c | all counted lines signed, none disputed | Recipient | `handover.accept` | counted opening cash | `accept` → `COMPLETED`; custody moves; shift gate cleared | unacknowledged/disputed lines |
| 6d | exceptional | Manager | `handover.exception` | recipient absent or sheet unfinished (reason + note) | `override-accept` → `COMPLETED` (manager exception) | reason/note missing |
| 7a | `OUTGOING_SUBMITTED`, **BRANCH_CUSTODY** | Manager | `handover.accept` **and** `handover.exception` | counted lines | sign each counted line in the branch's name (no recipient) | — |
| 7b | all counted lines signed | Manager | `handover.exception` | every counted line signed, none disputed; omitted required item needs reason + note | `to-branch-custody` → `COMPLETED`; branch holds the stock; **a shift already waiting is re-decided to `AWAITING_OPENING_VERIFICATION`** (revised R-A1, owner decision 2026-11-04) | unsigned lines; drawer still open |
| 8 | Next shift `AWAITING_OPENING_VERIFICATION` | Incoming cashier counts; reviewer confirms; verifier signs | `stock_count.start`, `stock_count.confirm`, `handover.accept` | handover `COMPLETED` to branch custody | opening FULL count → `verify` → custody to the shift; gate cleared | count unconfirmed; ambiguity (two gated shifts) |
| 9 | Next shift has an opening **cash receipt** `PENDING` | Named incoming cashier (owner may override) | `handover.accept` (`handover.exception` + owner for override) | the night/branch handover is `COMPLETED` | `ACCEPT` (with own count; reason on a difference) / `DISPUTE` / `DEFER` → `ACCEPTED`/`OVERRIDDEN` | handover not complete |
| 10 | Branch requires **place acceptance** | Assigned place inspector (manager override) | `handover.view` + inspector identity | next shift open (independent of the stock handover) | observations → accept (or override with reason) | incomplete required checks, equipment fault |
| 11 | All of the above satisfied | — | — | — | shift **operational**: POS/API stop refusing (`assertOpeningReady`) | any pending item above |

Parallelism confirmed from the code: the place check (10) needs only an open shift and runs in parallel with 6–8; the cash receipt (9) and opening verification (8) both wait for the handover to be `COMPLETED`; 9 and 8 are independent of each other.

## 3. Confirmed gaps and what changed

| Gap (confirmed) | Fix |
|---|---|
| Stepper ended at "complete"; opening verification, cash receipt and place receipt were separate panels at the bottom. | Unified journey model (`handover-journey.ts`): stages grouped as closure / handover / next-shift readiness, one **Required now** panel (what, who, why blocked, direct button, parallel items), and the three facts shown side by side. |
| Branch custody showed "receiver count / employee received" wording and had no signing UI; a waiting shift deadlocked the branch (R-A1). | Branch-signature wording throughout; signing panel with preflight, progress and recovery; waiting shift is re-decided on conversion (owner-approved reversal of R-A1, test updated). |
| "Sign all" sequential batch had no preflight, progress or recovery. | Eligible/excluded counts and the acting user are shown first; the server is re-read before starting, after any failure and after a lost response; partial results are reported per line with a continue path. |
| Retry keys were regenerated per press (a lost response then answered "already accepted" to a new key). | One key per intent (handover + action + payload) kept in `sessionStorage`; replays show "same result, no duplicate". |
| Money printed without currency, times in the browser's zone. | Currency from the café, timezone from the branch reporting version (fallback `Africa/Cairo`), carried in the payload. |
| No activity timeline, no export or print. | Activity from recorded audit events only (never inferred); XLSX + print HTML report built from the screen's own payload; `handover.view` + `reports.export`. |

## 4. Policy decisions recorded (not invented)

1. **R-A1 reversal** (waiting shift on branch-custody conversion) — owner-approved 2026-11-04; implemented and audited (`SHIFT_CUSTODY_GATE_REDECIDED`).
2. **Who may sign for the branch** — the server requires `handover.accept` and `handover.exception`; the UI follows it and says so. Whether a lower role should sign is an open business decision.
3. **Report permission** — `reports.export` in addition to `handover.view`; an alternative key is a business choice.
4. **"Exempted items"** — the data model has no exempt flag; the filter shows *uncounted* lines (outside the signature). A real exemption concept would need a decision.

## 5. Evidence (2026-11-04) — kept apart on purpose

**Implemented (source, uncommitted):** journey model and unified workspace (header, three-fact status, Required-now panel, four summary cards, six accessible tabs, inventory filters, activity timeline); branch-signing panel with preflight, progress and server re-read; per-intent retry keys; readiness and activity services; report model with XLSX and print HTML; revised R-A1.

**Tested (serial, against the disposable test database and test server 3100):** `handover-023` journey model (7) · Step 5 server tests in `handover-010` (readiness/activity through the POS gate, half-signed recovery with replay and audit counts, report permissions/tenancy/blind counts/injection/coverage) · existing suites re-run on this source: `handover-008` 70, `009` 36, `007` 76 (recount, journey D), `016` 11 (carried orders, journey H), `010` 34 + 1 skipped fixture, `010b` 33, `018` 9 (cash verification), `overnight-002` 11 (stored-cash receipt, journey F), `place-001` 5 (place receipt, journey G), `021` 1, `custody-004` 5, `014` 5; static/UI suites `ui-001/002/003/004/008/014/016`, `handover-shared-page`, `guided-workflow`, `receiving-*` all green after updating the pins to the new structure. `ui-017` (light-theme tokens) fails because of the owner's uncommitted `globals.css` edit, not this work. `tsc` clean; `eslint` 0 errors.

**Browser-verified (emulation, not a physical device):** on test server 3100 with a synthetic branch-custody handover that had one line signed and a shift already waiting: header, three-fact status, Required-now, cards, tabs; the preflight/confirm/progress signing flow ("اتوقّع 1 من 1"); conversion through the dialog; the page then showing handover complete with the next shift still not ready and "التحقق من العهدة الافتتاحية" as the required action; activity timeline of 10 recorded events; print page; 375px width with no horizontal page scroll and no touch target under 36px. Screenshots in `artifacts/erp-experience-20261102/step5/`.

**Print and export:** the HTML report was printed headlessly through Edge to an A4-landscape PDF (4 pages, `handover-report.pdf`); I could not render the PDF pages to images here, so the visual check of print is the on-screen HTML plus page count/size. The XLSX was parsed with SheetJS (sheets, numeric cells, text identifiers, no formulas, blind-count hiding, row coverage = count lines). No spreadsheet application is installed on this machine, so it was **not** opened in Excel/LibreOffice.

**Journeys:** A (shift-to-shift receiving), B/C (branch custody, with and without a waiting shift), D (dispute → recount → completion), F (cash difference and stored-cash receipt) and G (place receipt) and H (carried orders) are covered by the existing server suites above; E (partial signing / lost response) by the new tests and the browser flow. They were **not** each re-driven by hand through the UI: only B/C/E were, on the synthetic fixture. The owner's own handover was only read, never acted on.

**Preview 3113:** serves this source (`.next-integration` build `qn1bSUb8Vk_jx3hXNkked`, source manifest sha256 `dce2b052…ea3f6`, 1021 files, 93 migrations unchanged) under the guard copy from 4B.2; the guard verified source, migrations, database identity and HTTP/database correspondence. It has no handover fixtures, so only reachability was checked there (login, `/handovers` 200, report route 404/400). The journey checks ran on the test server.

**Owner-accepted:** nothing yet. Deployment: none.

## 6. Proposed separate commit scope (handover only)

`src/lib/handover.ts` (revised R-A1), `src/lib/handover-readiness.ts`, `handover-activity.ts`, `handover-detail-payload.ts`, `handover-report.ts`, `src/app/api/handovers/[id]/route.ts` and `[id]/report/route.ts`; `src/components/handovers/` (`handover-journey.ts`, `handover-intent.ts`, `branch-signing-panel.tsx`, `handover-workspace-parts.tsx`, `handover-detail.tsx`, `handover-action-bar.tsx`, `handover-overview.tsx`, `opening-verification-panel.tsx`); `src/app/(app)/handovers/page.tsx`; tests `handover-010-branch-custody`, `handover-023-journey-model`, `ui-008`, `ui-014`, `ui-017` (one line). Not in this scope: the 4B.2 accounting files, `globals.css`, `app-shell.tsx`, `expense-workspace.tsx`, the reports files and `src/lib/xlsx.ts`/`report-output.ts` (those belong to 4B.2).

## 7. Open decisions

Who besides managers may sign for the branch; the export permission; an exemption concept for uncounted items; whether the place check may run before the stock handover completes in every configuration (the server allows it today); acceptance of the three-fact wording by the owner.


## 8. Simplified direct handover & closing cash disposition (2026-11-04)

Branch `codex/nextcup-workspace-redesign-20261102`, base `203cc48` (above `bbbed42`, `3ea7c9b` and `a6fa68b`). Status: **implemented, verified against the disposable test databases on `5434` (`cafe_ops_test` and `cafe_ops_test_integr20261101_replay_66515e42c85e8ec4`) and both the isolated test server (`3160`, stopped after test run) and the live guarded preview server on `http://localhost:3113` (`.next-integration` build `A3spcpzBC2MpBTkVSfila`, `sourceSha256: 4a62d785942da5b4d7a0a94e0f1b891ed782a63863fe37805b4368b724c5c983`, `PID 17280`). Visual owner acceptance remains a separate owner decision.**

### 8.1 Owner-approved workflow implemented

1. **Outgoing employee (`ShiftCloseFlow` + `CashDispositionEditor`):**
   - Enters closing cash, card, InstaPay/wallet, and required ingredient counts.
   - Allocates counted cash across named owner/manager recipients (`استلمها المالك`, `استلمها المدير`) and retained drawer custody (`تُترك في الدرج كعهدة`) with exact cent-level equality (`deliveredAmount + retainedAmount === countedCashAmount`). Electronic tenders remain reconciliation data and are excluded from physical cash allocation.
   - Reviews a single unified closing summary and submits **"إغلاق الوردية وتسليم العهدة"**.
   - `finishOutgoingHandover` enforces that a recorded `ShiftCashDisposition` exists on newly opted-in direct handovers (`HandoverSession.directHandover = true`), while preserving compatibility for legacy/historical and in-progress handovers (`directHandover = false`).
2. **Incoming employee (`DirectHandoverPanel`):**
   - Reviews a concise handover summary (closing cash, allocations, retained drawer custody opening their shift, and disclosed outgoing stock count lines).
   - Presses **"فتح ورديتي واستلام العهدة"** to acknowledge the physical handover directly (`directAcknowledgedById`, `directAcknowledgedAt`, `directReviewVersion`) without repeating ingredient counting, cash counting, or per-line signatures (`HandoverStockAcknowledgement`).
   - Reuses an already-waiting `AWAITING_CUSTODY_TRANSFER` shift when one exists, or opens a new shift with `retainedAmount` as `openingCashAmount`, clearing the custody gate while preserving independent place/equipment readiness gates (`assertOpeningReady`).
3. **Named recipient confirmation & dispute (`CashDeliveriesPanel`):**
   - Each owner/manager delivery starts as `PENDING_CONFIRMATION` (**"تسليم مُعلن — بانتظار تأكيد المستلم"**) and does not block incoming acceptance of retained drawer cash.
   - Only the named recipient (`recipientUserId === session.userId`) may confirm or dispute a delivery from their own account; unauthorized owner proxy confirmation was removed because no established proxy-confirmation policy exists.
   - Disputed deliveries (`DISPUTED`) can be resolved (`RESOLVED`) with a note and resolved amount by an authorized manager/owner (`shifts.override_close`), keeping historical counts intact.
4. **No-handover shift close lifecycle:**
   - When a shift closes without a handover (`stockCountPolicy: "NO_SHIFT_COUNT"`), `recordShiftCashDisposition` records the disposition and creates `PENDING_CONFIRMATION` declarations for owner/manager deliveries, while `ensureCustodyForShift` (`src/lib/custody.ts`) carries forward `retainedAmount` into the next shift's `openingCashAmount`, `expectedCashAmount`, and `CustodyPeriod.openingCashAmount`.
5. **Discrepancy / issue reporting (`HandoverIssue`):**
   - Outgoing/incoming staff and managers can report cash, stock-item, or general handover issues before or after acceptance without mutating historical counts or receipts, and managers (`handover.exception`) can record resolutions.

### 8.2 Schema, migrations & Prisma client (applied to disposable `5434` databases only)

- `20261106090000_direct_handover_cash_disposition` (`sha256: 04393bd501b92dd8298e8271601b0e1f8953542aa07e6c96a4cb0fb90734a13c`): `ShiftCashDisposition`, `CashDeliveryDeclaration`, `CashDeliveryDestination`, `CashDeliveryStatus`, and direct acknowledgement columns on `HandoverSession`.
- `20261106100000_handover_issue` (`sha256: d653599562bc1bb6f0fb490fa7f9705b2d224055930143ef28bc69b316182c4f`): `HandoverIssue`, `HandoverIssueKind`, `HandoverIssueStatus`.
- `20261106110000_handover_direct_flag` (`sha256: 9d0a0c415b42ac09dfab98d4b76ab0aa18e00bd6573eb9f1d6c530306ba370fa`): `ALTER TABLE "HandoverSession" ADD COLUMN "directHandover" BOOLEAN NOT NULL DEFAULT false;`.
- Official `npx prisma generate` succeeded with exit code `0` (`v6.19.3`) after renaming the in-use `query_engine-windows.dll.node` to `query_engine-windows.dll.node.locked-by-3100` in place on NTFS so the unrelated `3100` server (`PID 25156`) remained undisturbed; `artifacts/erp-experience-20261102/step4b2/local-node-modules.mjs` remained intact (`96` migrations applied on both disposable databases on `5434`, `0` pending, `0` failed, all checksums matching disk).

### 8.3 Verification & closeout evidence (2026-11-04)

- **Typecheck & Lint:** `npx tsc --noEmit` PASS (0 errors); `npx eslint` on all touched files PASS (0 errors).
- **Direct Handover & Cash Disposition Suite (`tests/direct-handover-001-cash-disposition.test.ts`):** **34/34 PASS (0 failed, 0 skipped)** — executed both against the isolated test server (`3160`, stopped after run) and directly against the final guarded preview `http://localhost:3113` (`artifacts/erp-experience-20261102/direct-handover/direct-handover-001-on-3113.log`, build `A3spcpzBC2MpBTkVSfila`). Covers split/all-retained/all-delivered/zero-cash allocations, over/under-allocation rejection, electronic payment exclusion, replay idempotency, stale review rejection (cash movement, carried order change, disposition change), `finishOutgoingHandover` disposition prerequisite (`directHandover = true` vs legacy `false`), direct acceptance opening a new shift or reusing a waiting shift, concurrent acceptance, pending delivery non-blocking, named-recipient confirmation/dispute/resolution, proxy confirmation rejection (`403`), cross-branch/cross-tenant isolation, issue reporting/resolution, and no-handover shift-close carryforward.
- **Handover & UI Regression Suites:** **291/291 PASS** across `handover-023-journey-model` (10), `hnd-ux-004-two-screen-close` (3), `ui-001/002/003/004/008/014/015/016` (43), `handover-008-accept` (70), `handover-008b-accept-rollback` (25), `handover-009-override-accept` (36), `handover-009b-override-rollback` (20), `handover-010-branch-custody` (34 + 1 intentional fixture-only skip at line 993), `handover-010b-branch-custody-rollback` (30), `handover-018-cash-verification` (9), `overnight-002-receipt-and-readiness` (11).
- **Guarded Preview `http://localhost:3113` Rebaseline & Live Split-Cash Journey (`artifacts/erp-experience-20261102/direct-handover/`):**
  - Real preview guard chain discovered: `artifacts/workspace-redesign-20261102/workspace-guard.mjs` (original 91-migration guard), `workspace-guard-4b2.mjs` (93-migration guard copy), `private-step5-config.json`, and `artifacts/erp-experience-20261102/step5/rebaseline.mjs` & `start.mjs` (the earlier report's reference to `scripts/preview-server-3113.mjs` was corrected).
  - Updated guard copy `artifacts/workspace-redesign-20261102/workspace-guard-direct-handover.mjs` (`sha256: 82f428d160e79dcd95d5f147d2c2bb74af2e656ecaf23b048be3b3138e57bde6`) and config `artifacts/workspace-redesign-20261102/private-direct-handover-config.json` (`96` migrations, all 93 earlier checksums preserved unchanged, `1038` source files, `sourceSha256: 4a62d785942da5b4d7a0a94e0f1b891ed782a63863fe37805b4368b724c5c983`).
  - Built `.next-integration` (`buildId: A3spcpzBC2MpBTkVSfila`) and started `http://localhost:3113` (`PID 17280`, verified in `preview-direct-handover.json` and `correspondence.json`).
  - Exercised the split-cash journey on `http://localhost:3113` (`verify-preview-3113.mjs` → `preview-3113-verification.json`): outgoing shift `#101` closed with `3,000 EGP` counted cash (`2,950 EGP` expected, `+50 EGP` difference), allocated `2,000 EGP` to Owner, `500 EGP` to Manager, and `500 EGP` retained drawer custody; incoming cashier reported an issue and accepted once (`"فتح ورديتي واستلام العهدة"`), opening Shift `#102` with `500 EGP` opening cash and `0` per-line stock acknowledgements; verified POS readiness (`readyWithoutPlaceRequirement: true`, `gatedWhenPlaceRequired: true`); Owner confirmed the `2,000 EGP` delivery while Manager's `500 EGP` delivery remained `PENDING_CONFIRMATION`.
  - Mobile emulation at both `390x844` and `375x812` across all 4 screens (`outgoing`, `incoming`, `recipient`, `overview`) verified `scrollWidth <= innerWidth` (`375 <= 390` / `360 <= 375` on outgoing/incoming, `390 <= 390` / `375 <= 375` on recipient/overview) after adding `[&_select]:max-w-[calc(100vw-2rem)]` to `/handovers/page.tsx`.
  - **PDF Print Inspection (`handover-report.pdf` — 6 A4-landscape pages, 177,643 bytes):** Rendered every page via Windows `Windows.Data.Pdf.PdfDocument` to `pdf-page-1.png` .. `pdf-page-6.png` (`1056x816`) and visually inspected all 6 pages: zero horizontal clipping, repeating `<thead>` across page breaks, and exact agreement of all cash/delivery/inventory/issue/readiness/activity figures. (Minor print layout note: on pages 3–4, `overflow-wrap: anywhere` on narrow table headers wraps a trailing character in `الوحدة`/`المُسلّم`/`النوع`/`الحالة`, and the `الاختلافات والملاحظات المسجلة` heading appears at the bottom of page 3 with its table at the top of page 4; no text is clipped or missing.)
  - **XLSX Verification (`handover-report.xlsx` — 9 sheets, 11,786 bytes):** Verified with SheetJS (`0` formula cells, exact cash disposition rows `2000` confirmed / `500` pending / `500` retained, issue rows, inventory rows, and activity rows). Checked Windows Registry (`Uninstall` keys), `Program Files`, `AppData`, and `.xlsx` file associations: neither WPS Office, Microsoft Excel, nor LibreOffice is installed on this machine, so desktop spreadsheet application rendering remains an explicit environment limitation.

### 8.4 Proposed separate commit scope (direct handover & cash disposition)

- Schema & migrations: `prisma/schema.prisma`, `prisma/migrations/20261106090000_direct_handover_cash_disposition/migration.sql`, `prisma/migrations/20261106100000_handover_issue/migration.sql`, `prisma/migrations/20261106110000_handover_direct_flag/migration.sql`
- Backend services: `src/lib/cash-disposition.ts`, `src/lib/handover-direct.ts`, `src/lib/handover.ts`, `src/lib/custody.ts`, `src/lib/handover-overview.ts`, `src/lib/handover-detail-payload.ts`, `src/lib/handover-activity.ts`, `src/lib/handover-report.ts`, `src/lib/shift-report.ts`
- API routes: `src/app/api/shifts/[id]/cash-disposition/route.ts`, `src/app/api/handovers/[id]/route.ts`, `src/app/api/handovers/[id]/direct/route.ts`, `src/app/api/handovers/[id]/issues/route.ts`, `src/app/api/handover-issues/[id]/resolve/route.ts`, `src/app/api/cash-deliveries/route.ts`, `src/app/api/cash-deliveries/[id]/confirm/route.ts`, `src/app/api/cash-deliveries/[id]/dispute/route.ts`, `src/app/api/cash-deliveries/[id]/resolve/route.ts`
- UI components & pages: `src/components/pos/cash-disposition-editor.tsx`, `src/components/pos/shift-close-flow.tsx`, `src/components/handovers/direct-handover-panel.tsx`, `src/components/handovers/cash-deliveries-panel.tsx`, `src/components/handovers/handover-detail.tsx`, `src/components/handovers/handover-journey.ts`, `src/components/handovers/handover-overview.tsx`, `src/app/(app)/handovers/page.tsx`, `src/app/reports/shift/[id]/page.tsx`
- Tests: `tests/direct-handover-001-cash-disposition.test.ts`, `tests/handover-023-journey-model.test.ts`, `tests/hnd-ux-004-two-screen-close.test.ts`, `tests/ui-008-handover-guided-ux.test.ts`

### 8.5 Hardening (2026-11-05) — implementation A confirmed by the owner

The owner chose this implementation (A) over `feature/hnd-cash-01` (B, `cafe-ops-finance-f1`, `19425eb`), which stays parked and untouched. Status: **implemented and tested on the disposable `cafe_ops_test` (5434) via an owned server on 3160. Owner visual acceptance is still a separate step.**

| # | State / actor | Action → result | Gate / evidence |
|---|---|---|---|
| D1 | Shift financially closed; outgoing cashier (or `shifts.close_others`) | Record the disposition once: deliveries to a named OWNER/MANAGER plus retained drawer cash = counted cash | Exact sum; at most one drawer partition per shift (service check plus `*_single_partition` triggers against `CashStorage`); `withIdempotency` |
| D2 | Delivery `DECLARED`; named recipient | Confirm → `CONFIRMED` | Recipient's own account only; audit `CASH_DELIVERY_CONFIRMED` |
| D3 | Delivery `DECLARED`; café owner, not the recipient | Confirm «تأكيد نيابةً عن المستلم» → `CONFIRMED` with `confirmedByException` | Written reason required; audit `CASH_DELIVERY_CONFIRMED_ON_BEHALF`; labelled distinctly in the UI, report and XLSX; never counted as the recipient's own |
| D4 | `DECLARED`, or on-behalf `CONFIRMED`; named recipient | Dispute → `DISPUTED` (optional claimed amount) | On-behalf disputes are allowed only while that day's accounting period is open; the closed shift and the next opening are never rewritten |
| D5 | `DISPUTED`; café owner | Resolve → `RESOLVED` with the resolved amount | The report shows declared / claimed / resolved and the shortfall; an owner resolving their own dispute is labelled self-resolved |
| D6 | Period close (G1 checklist) | — | `cash-deliveries` is **blocking** while any delivery is `DECLARED`/`DISPUTED`; `cash-deliveries-on-behalf` is a **warning**. Never blocks a shift or the incoming acceptance |
| D7 | Direct handover `OUTGOING_SUBMITTED`; incoming cashier | «فتح ورديتي واستلام العهدة» → `COMPLETED`; drawer opens at the retained amount | Reviewed version; ambiguity refused; `withIdempotency` on top of the handover's own key |

**Other changes:**
- Every new mutating route (cash-disposition, direct accept, issues, issue resolve, confirm, dispute, resolve) goes through `withIdempotency`. The key travels in the `Idempotency-Key` header; a body key is accepted only when it is identical.
- New ranked locks: `lockHandoverRow` (1.7), `lockCashDelivery` (9.1), `lockHandoverIssue` (9.2). These replace the ad-hoc `FOR UPDATE` calls.

**New migration:** `20261106120000_direct_handover_hardening`. It adds triggers only and changes no data.

**Tests:** `direct-handover-001` full run, 42/42 PASS. The regression suites are recorded in `artifacts/erp-experience-20261102/direct-handover/PROGRESS.md`.
