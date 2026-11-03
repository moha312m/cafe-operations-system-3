# Stock handover simplification — 2026-10-28

Spec: user attachment f856de8b-0880-4aba-ac3d-0000a39a3244/Pasted text.txt and HND-UX-001.
Worktree: C:/Dev/nextcup-release-r10, release/pilot-r10-20261027, HEAD 719fdb152f97aff454593acf3e9e53d2c3f3287e.
Preserve the six existing component edits and tests/ui-008-handover-screen-simplified.test.ts. No Git mutations or deployment. Existing :3141 production-mode preview must stay untouched.

1. Server evidence and concurrency (stock-count.ts and handover eligibility): scoped matching-count system validation, null confirmedById, transactional audit with initiating employee; per-item round3 comparison; required-scope/current-round/freeze/evidence/correction/dispute checks. Keep manager confirmation permissions and all standalone count behavior. Add scoped line-save compare-and-swap and retry evidence where necessary. Focused real disposable DB tests.
2. Count capture UI (stock-count-detail.tsx, count-line-row.tsx, small save-state utility if useful): parent-owned drafts surviving search/reloads; serial per-row saves with revision guards and explicit saving/saved/failed feedback; blur/Enter save; compact handover capture columns; pending/failed/dirty submission gate. Read count matching status returned by server, preserve standalone behavior. Focused state regressions.
3. Receiving and navigation (handover.ts, acknowledge route/new sheet, handover-detail.tsx): one explicit final consent for each selected line decision, current count round and actor/time; atomic permission/recipient/state checks and idempotent replay. Null means no independent count. Discrepancies stay disputed and cannot complete. Inline sheet and skip manager stage only for truthful system-validated counts.
4. Verification: focused server/UI tests, relevant existing regression groups, typecheck/lint, build. Identify disposable DB marker and server/database co-location before synthetic mutations. Exercise matching and variance journeys and RTL/screen sizes if a verified isolated environment is available. Fresh independent final review. Deliver local changes and exact limitations.

Contracts: submit count response may return status CONFIRMED plus systemValidated:true; count GET includes handoverId and systemValidated boolean derived from audit plus confirmedById null, only after disclosure. Capture PATCH accepts expectedCountedAt:string|null for handover CAS; response retains existing session/line shape. Combined receive POST /api/handovers/:id/acknowledge accepts {countSessionId, countVersion, lines:[{stockCountLineId,incomingCountedQuantity:number|null,disputeReasonCodeId?,disputeNote?}], idempotencyKey}; legacy single-line API remains supported.

Progress: local implementation and available verification complete. Browser/RTL/mobile visual verification unavailable. Owner delegated the cap decision; the safer 2,000-line bulk receiving cap is retained. No migration required.

## Delivery record — 28 October 2026 (Africa/Cairo)

The server validates matching handover counts at three-decimal quantity precision, independently for every required item, under the handover/count/inventory locks. A matching result has no manager signature: COUNT_SYSTEM_VALIDATED records the initiating employee and exact evidence. Nonzero differences, including within tolerance and without cost, remain manager-controlled. Pending corrections, missing/unknown evidence, superseded rounds and disputes do not qualify. Submission/acceptance revalidate current evidence.

Capture uses persistent parent-owned drafts, blur/Enter saves, explicit saving/saved/failed feedback, per-row serialization and compare-and-swap versions. Known conflicts require refresh/review/retry; uncertain lost responses replay safely. Zero is explicit; blank remains uncounted. Handover capture has four columns and preserves blind disclosure.

Receiving uses one atomic sheet with explicit per-line independent quantity or null/no-independent-count consent. The opaque countVersion rejects changed source evidence without exposing blind quantities. Each signature retains actor, quantity or absence, decision and time; an audit row links the consent, count version and retry key. A later receiving difference remains disputed and blocks completion. Signed rounds use the existing request-recount/new-round workflow before corrections. Cash/custody acceptance remains separate and explicit.

### Files changed by this task

Server:
- src/lib/stock-count.ts
- src/lib/recount.ts
- src/lib/handover.ts
- src/lib/handover-count-match.ts (new)
- src/lib/handover-count-validation.ts (new)
- src/app/api/stock-counts/[id]/lines/[lineId]/route.ts
- src/app/api/handovers/[id]/acknowledge/route.ts

Interface:
- src/components/stock-counts/count-line-row.tsx (extends Claude's existing edit)
- src/components/stock-counts/stock-count-detail.tsx
- src/components/stock-counts/count-entry-queue.ts (new)
- src/components/handovers/handover-detail.tsx (extends Claude's existing edit)
- src/components/handovers/receiving-sheet.tsx (new)
- src/components/handovers/receiving-model.ts (new)

Tests:
- tests/handover-count-match.test.ts (new)
- tests/handover-count-system-validation.test.ts (new)
- tests/handover-count-entry-queue.test.ts (new)
- tests/handover-count-entry-render.test.ts (new)
- tests/handover-receiving-model.test.ts (new)
- tests/handover-020-receiving-sheet.test.ts (new)
- tests/handover-021-stock-http-journeys.test.ts (new)
- tests/count-018-handover-incomplete-submit.test.ts (fixture now binds current count and freeze)
- tests/ui-002-action-wiring.test.ts (existing assertions follow moved API wiring)
- tests/ui-008-handover-screen-simplified.test.ts (preserved Claude test; two intentional assertions follow recipient/readiness gates)
- This plan/review record.

Claude's pre-existing changes in handover-overview.tsx, opening-cash-panel.tsx, opening-verification-panel.tsx and place-receipt-panel.tsx remain untouched by this task. All unrelated work preserved.

### Verification evidence

- Final focused server/state/render/wiring group: 36/36 PASS.
- Final ordinary acceptance, manager override and rollback group: 124/124 PASS.
- Final production-server count/HTTP group: 32/32 PASS. This includes two complete real HTTP journeys (matching stock; manager-approved shortage), plus an initially matching outgoing count whose receiving discrepancy blocks completion. These are application/API checks, not browser clicks.
- Other selected existing regression groups exercised configuration, scheduled full counts, outgoing submit, recount, acceptance rollback, branch custody/rollback, cash-close handover, inventory freezes and blind cash counting.
- Initial selected broad run: 335/372 PASS, 37 failures. All failures were confined to COUNT-018's obsolete unbound fixture and SH-20's new validation lock-order integration. Fixed the fixture and moved validation after the established inventory lock sequence; corrected suites passed in the final runs above. No unresolved observed test failure remains. The entire repository suite was not run.
- TypeScript: PASS (tsc --noEmit).
- Focused ESLint: zero errors, two effect-pattern warnings in the two existing detail components.
- git diff --check: PASS; existing line-ending notice on untouched owner work only.
- Next.js production build: PASS using CASHIER_TOUCH_BUILD=1, output .next-touch.
- npm run build's Prisma regeneration step encountered Windows EPERM on a query-engine DLL loaded by the existing preview. A temporary schema copy was formatted with Prisma and compared exactly with the generated client's formatted schema; they match. Ran Next.js build directly with that verified existing client, without stopping port 3141 or changing schema/client definitions.
- Fresh independent code review completed; material findings fixed and covered (JSONB field ordering, timestamp hashing, correction after consent, branchless staff, truthful validation flag and inventory lock placement).

Disposable database: cafe_ops_test_hndux_20261028 at 127.0.0.1:5440. Cluster data directory and ownership were verified, the database was newly created and marked disposable, existing migrations applied there, and server/database co-location proven by the repository runner before mutations. New synthetic fixtures only; no owner demo handover completed. Exact synthetic leftovers from an early failed teardown were cleaned and verified. The runner could not establish a separate owner-database URL for cross-database negative checks; those checks were skipped. No claim of a fresh whole-owner-database snapshot audit.

### Preview and process state

- URL: http://127.0.0.1:3142/handovers
- Build: Y83Aku-KkfNCUQozzuwIE
- Process: 23724, Next.js production server, task database only.
- Task dev processes 10728/3000 were identity-verified and stopped before building. Existing preview 3141/PID 19328 remains running and unchanged. PostgreSQL was not stopped or reconfigured.
- Source remains release/pilot-r10-20261027 at 719fdb152f97aff454593acf3e9e53d2c3f3287e with local uncommitted changes. The remote release does not contain these adjustments.
- Evidence logs and preview metadata are in .private/hnd-ux (ignored local artifacts).

### Remaining limitations / owner actions

- In-app browser CDP navigation timed out; actual browser rendering, Arabic/RTL and mobile-size walkthroughs could not be verified. Arabic copy, responsive structure and static row rendering were inspected, but this is not visual acceptance.
- Combined receiving is capped at 2,000 lines. Automatic approval review rejected removing that cap because it broadens accepted request payloads and raises resource/availability risk. Owner subsequently instructed “do whatever see the best and safe”; retained the cap as the safer choice. No removal or workaround was performed.
- No additive migration or permission grant is required. No accounting behavior, stock movement rule or custody consent was changed. No commit, push, merge or deployment performed.

Final status: COMPLETE — local implementation and all available final checks pass. Owner delegated the cap decision and the safer limit is retained. Actual browser/RTL/mobile visual acceptance remains unverified because the browser interface was unavailable.

## Browser acceptance attempt — Claude, 2026-10-30 (Africa/Cairo)

**Status: BLOCKED before any browser scenario. No handover journey was run, no fixture was created, no test server was started, and no source or data changed.** Everything above is preserved as written; this section records only read-only verification.

**Checkout (observed, read-only).** `C:/Dev/nextcup-release-r10`, branch `release/pilot-r10-20261027`, HEAD `c6e30f6` ("fix: live session check on printable pages, throttle public QR orders", 2026-10-29 15:14 +03). The delivery record's base `719fdb1` is an ancestor, so one commit has landed since; it touches printable-page session checks and public QR throttling, not handover files. The same 35 modified and 16 untracked handover/UI files are present (1,327 insertions, 653 deletions). The newest handover-scope source file was last written 2026-10-28 14:47 +03; no file outside build/dependency/Git/`.private` folders was written in the last six hours, and no process referencing this checkout is running, so no other writer is active as far as can be observed. The purchase-integration worktree was not touched and nothing was copied between the two.

**Build correspondence (observed).** `.next-touch/BUILD_ID` is `Ozt9fqTAgE45ZclcICSGg` (written 2026-10-28 18:03 +03), not the `Y83Aku-KkfNCUQozzuwIE` recorded in `.private/hnd-ux/preview.json`; it was built after the last handover-scope edit but before commit `c6e30f6` and before later edits to `pos/page.tsx`, `globals.css`, `order-cart.tsx` and the QR route, so it does not correspond to the current source. The recorded preview (PID 23724, 3142) is not running; nothing listens on 3141 or 3142 either, so the previously existing 3141 preview is also gone (not stopped by this task).

**Environment (observed).** The historical database `cafe_ops_test_hndux_20261028` lives in the R10 acceptance cluster (`C:\Dev\_nextcup_r10_accept\pgdata`, port 5440, `R10-OWNERSHIP.json`: isolated synthetic cluster, not owner data). That cluster is **down**: no listener on 5440, no `postmaster.pid`, and its log ends with a clean "database system is shut down" at 2026-10-29 15:13 +03. The owner cluster on 5433 is also not listening (stale pid file; not touched). The only PostgreSQL running is the Stage 2 purchase-integration cluster on 5442 (`C:/Dev/_nextcup_stage2b1`, database `cafe_ops_test_stage2b1`, PID 15940). It belongs to another worktree and task with a different migration state, so using it for these handover scenarios would be substituting another database; it was not queried or used.

**Why nothing further ran.** Starting the 5440 cluster is PostgreSQL control, which this task forbids, and the verified disposable environment it requires is not running. An owned test server without that database cannot show matching-count, difference, count-entry or receiving journeys. Remaining unverified: all five browser scenarios, roles, blind quantities, Arabic/RTL, desktop and 375 px layout. The earlier delivery limitations stand.

**To proceed (owner decision).** Authorize starting the existing 5440 cluster with its recorded data directory (without creating, migrating or altering anything), then: verify identity and the disposable marker of `cafe_ops_test_hndux_20261028`, confirm schema currency against this checkout's migrations (read-only), build or run an owned server on an unused port from the current source (the existing build is stale), prove server/database correspondence, create fresh synthetic fixtures, and run the scenarios. Alternatively name a different existing disposable database to use.

## Browser acceptance result — Claude, 2026-10-30 (Africa/Cairo)

Supersedes nothing above; the BLOCKED entry that precedes this one stands as the history of why this ran later. **Status: browser scenarios 1-5 observed and passing within the scope below; no application defect found requiring a source change; no source file was edited.** This is an agent's observation of a development-mode server, not owner UAT and not a check of the 28 October production build.

**Authorization and resources.** Owner authorized starting only the existing R10 acceptance cluster. I started it detached (`pg_ctl`, data directory `C:\Dev\_nextcup_r10_accept\pgdata`, `-p 5440`, postmaster PID 20344): no database, role, migration or schema action. Read-only checks before any write: database `cafe_ops_test_hndux_20261028`, port 5440, that data directory, marker row "Disposable HND-UX-001 task database created 2026-10-28. Synthetic fixtures only.", 84 finished migrations ending `20261025070100_reporting_version_immutable` (matches this checkout's 84 migration folders). Owned server: `next dev` on 3143 via `scripts/test-server.mjs` with the 5440 URL; the repository runner proved "server proved to read the same database" before every fixture write. At the end I stopped only what I started: the 3143 server and the 5440 cluster (clean `pg_ctl stop -m fast`). No 3141, 3142, 3143 or 5440 listener remains; the Stage 2 cluster on 5442 and the owner cluster on 5433 were untouched. All fixtures and evidence are preserved in the stopped database.

**Source/build correspondence (be precise).** Source: branch `release/pilot-r10-20261027`, HEAD `c6e30f6` plus the same uncommitted handover files; no edits by this task. The evidence below comes from `next dev` serving that current source, **not** from the production build `.next-touch` (BUILD_ID `Ozt9fqTAgE45ZclcICSGg`, stale against HEAD) or the historical preview build `Y83Aku-KkfNCUQozzuwIE`. No production build was made and nothing was stopped or replaced: the historical previews on 3141 and 3142 were already absent. The first `next dev` start served an HTML 404 for every nested `/api/stock-counts/[id]/...` route (a fixture request failed on it). I renamed `.next/dev` to `.next/dev.stale-20261030` (reversible, nothing deleted) and restarted, after which all routes answered. Cause unconfirmed; same symptom as the earlier purchase-worktree 404.

**Fixtures (fresh, synthetic, kept).** Created through the repository's guarded runner (`.private/hnd-ux/browser-fixtures.test.ts` and `incoming-shift.test.ts`, outputs beside them): cafes `PH1-HNDUIMATCH-4876-1`, `PH1-HNDUIOPPO-4876-2`, `PH1-HNDUIENTRY-4876-3`, `PH1-HNDUIRECV-4876-4` and `PH1-HNDUIRECV-13548-1`, plus unreferenced partial rows from one failed first attempt (`browser-fixtures.attempt1.out`). Each has manager, cashier, storekeeper, waiter, owner and a synthetic incoming employee; the password is the repository-documented `count-fixture-1234`. The RECV cafes' outgoing counts were submitted through the product's own API as setup only.

| # | Scenario | Observed | Kind |
|---|---|---|---|
| 1 | Matching count | Cashier opened the handover, started the count, entered Alpha 10 and Beta 5 (Enter saved each and advanced focus; "المحفوظ 2/2"), pressed "إنهاء العد والتحقق". Page moved to "الجرد معتمد — قدّم العهدة", status "متأكد", text "الكميات مطابقة — تحقّق منها النظام دون توقيع اعتماد من مسؤول", next action "تقديم العهدة للمستلم" (with its own confirmation dialog). No manager involved. DB: session CONFIRMED, `confirmedById` NULL, audit `COUNT_SYSTEM_VALIDATED` with the initiating employee and `SYSTEM_MATCHING_QUANTITIES`; handover then OUTGOING_SUBMITTED | browser + DB read-back |
| 2 | Differences | Alpha 11 (+1) and Beta 4 (-1) on the same count: not confirmed; "الجرد مُرسل — يعتمده مسؤول بصلاحية تأكيد الجرد". The cashier saw no confirm, accept or recount controls; the manager saw "تأكيد الجرد", "اعتماد الفرق", "إعادة عد", "تسجيل سبب الفرق", "تصحيح". Manager pressed "تأكيد الجرد" with both lines open: refused ("في سطور لسه مش مقفولة (2)..."), session stays SUBMITTED. Opposite differences did not cancel into a pass. | browser + DB |
| 3 | Count entry | (ENTRY fixture) Failed save, using a stubbed fetch that rejected the PATCH once, so this is **test instrumentation** and an assumption that a real outage behaves alike: alert with the error, draft "3" kept, row shows "إعادة الحفظ", counter 0/4, finish disabled. Search "Gamma" showed only Gamma; clearing it restored Alpha=3 with no extra save call. After the stub was lifted, "إعادة الحفظ" sent the identical payload (`countedQuantity:3, expectedCountedAt:null`) and the row became "محفوظ" (1/4). "0 (صفر فعلي)" on Delta saved an explicit 0 while Beta and Gamma stayed blank "لم تُعدّ"; finish stayed disabled with "أكمل الكميات واحفظ التعديلات قبل إنهاء العد". After a reload the saved values (Alpha 3, Delta 0) persisted. | browser + stubbed failure |
| 4a | Receiving, no discrepancy | The incoming employee (own shift) saw the combined sheet with outgoing quantities hidden ("كميات المُسلّم تُعرض بعد تسجيل قرارات الاستلام"); "أؤكد قرارات الاستلام" stayed disabled until every line had a decision. Alpha: "أستلم دون عدّ مستقل (بدون كمية)"; Beta: independent count 5; explicit confirmation made both lines "تم استلام السطر". Cash (100) and custody then needed a separate "تأكيد استلام عهدة الشيفت" with its own dialog; handover COMPLETED. DB: Alpha `incomingCountedQuantity` NULL, variance NULL, ACCEPTED; Beta 5, variance 0, ACCEPTED; session `confirmedById` still NULL | browser + DB |
| 4b | Receiving discrepancy | The outgoing count had matched (setup by API). The receiver counted Alpha 8 against 10 with no reason: refused ("لازم تحدد سبب الاختلاف · لم تُمسح إدخالاتك..."), entries kept, nothing written. After choosing the reason and confirming again: Alpha "معترض عليه — اطلب إعادة الجرد" (DISPUTED, variance -2), Beta received; no custody or cash accept control offered; handover INCOMING_REVIEW, not completed. One API cross-check, not a browser step: `POST /api/handovers/:id/accept` returned 409 "في اعتراض على الجرد الحالي — لازم إعادة جرد" | browser + DB + one API check |
| 5 | Presentation | Arabic, `dir=rtl`; stepper "الجرد، اعتماد الجرد، تقديم العهدة، استلام المستلم، مكتمل" with a "المطلوب الآن" line at every state; count rows blind (no expected column or text for the cashier; shown only after submission). At an 800x600 pane and at 375x812: no horizontal page scroll, count inputs 112x48, receiving controls 230-252 wide by 48 high, and no interactive control under 36 px high except the 24 px checkbox (its label is the tap target). | browser + DOM measurement |

**Observations to carry forward (no change made).**
1. The manager's refusal on unresolved lines prints raw line ids instead of item names. Behavior is right; the wording is not for staff.
2. At 375 px the count table scrolls inside its own container, so with the long synthetic item names the name column is clipped; short real item names were not tested.
3. The receiving table for a disputed line still shows "الفرق 0" (the outgoing variance) beside "معترض عليه"; the -2 difference is only in the stored acknowledgement and the dispute label. Presentation only.
4. The matching-count banner "الكميات مطابقة — تحقّق منها النظام..." stays visible during a later receiving dispute. It describes the outgoing count only; completion is correctly blocked.
5. Pane screenshots lag one interaction and some pointer clicks missed (a confirmation dialog hid the button I clicked twice). Results above were read from page text, DOM measurements, the database and network, not from screenshots alone.

**Not verified in a browser.** A nonzero difference inside tolerance (the fixtures' tolerance defaults classified plus or minus 1 as outside); the manager completing approval end to end (no reason-code fixture was created for the OPPO cafe, so I stopped at the refusal); storekeeper and waiter roles; selected-item settings and scheduled full counts (untouched; fixtures use critical-item counts); the 2,000-line receiving cap; idempotent replay and concurrent counts (covered only by the earlier server suites); a production build. The earlier backend groups were not repeated because no source changed.

**Evidence.** Six screenshots in `.private/hnd-ux/browser-2026-10-30/`; fixture outputs `.private/hnd-ux/browser-fixtures*.out`. Handover ids: match `cmvu4boap000xhlrg159igevn`, opposite `cmvu4bpff0027hlrg1oqgf0sa`, entry `cmvu4bqie003lhlrgf4whjpo6`, receiving `cmvu4brnj004xhlrgiuud17li` and `cmvu4r323000xhlgch44rg8fk`.

**Remaining.** Owner UAT of the real build; a production build of current HEAD plus this work for a true build-level check; the within-tolerance and manager-approval browser journeys; the presentation notes above. No staging, commit, push, merge or deployment.


## Display corrections, remaining journeys and production build — Claude, 2026-10-30 (Africa/Cairo)

Earlier sections are history and unchanged. **Status: COMPLETE for the bounded acceptance checks listed below, within the limitations at the end. Human UAT and production release approval are not claimed and stay separate.** Source: branch `release/pilot-r10-20261027`, HEAD `c6e30f6` plus the existing uncommitted handover work and the edits below. Nothing was staged, committed, pushed, merged or deployed.

### 1. What changed (all inside the handover scope)
| Finding | Reproduced | Change |
|---|---|---|
| A disputed receiving row showed "الفرق 0" (the outgoing variance) | Yes, dev server, fixture PUR…RECV-4876-4 and a fresh one: handed over 10, receiver counted 8, row showed 0 | `GET /api/handovers/[id]` now returns the stored acknowledgement figures (`incomingCountedQuantity`, `handedOverQuantity`, `varianceQuantity`) for the **current count round only**. New pure `receivingRowDisplay` in `receiving-model.ts` keeps two comparisons apart: "العدّ / الفرق عن المتوقع" (outgoing count against expected) and "عدّ المستلم / المُسلَّم / فرق الاستلام" (receiver against handed over). 10 vs 8 shows `−2`; "بدون عدّ مستقل" shows `—`, never 0 |
| The matching banner stayed during a receiving dispute | Yes | While a current-round dispute exists: a `role=alert` "الاستلام معترض عليه والعهدة لم تكتمل: <items>" (with the true fact "جرد المُسلّم كان مطابقًا وتحقّق منه النظام، لكن عدّ المستلم يختلف عمّا سُلّم"), the next-action line becomes "الاستلام معترض عليه — اطلب إعادة الجرد…", and the all-clear banner and the stale "بانتظار المستلم…(0)" callout are hidden |
| Manager refusal printed raw line ids | Yes, dev | `unsettledLinesMessage` (stock-count.ts): "في سطور لسه مش مقفولة (n): <item names>. لكل صنف: اعتمد الفرق، أو سجّل سبب الفرق، أو اطلب إعادة عد، ثم أكّد الجرد تاني." Same 409, same permissions |
| Long item names clipped at 375 px | Yes, dev: the name column scrolled out of view while a quantity was typed | Names wrap anywhere (`[overflow-wrap:anywhere]`); below `sm` the count rows and the receiving rows become stacked cards (name, unit, controls/figures), column headers hidden below `sm` |
| (found while scoping) a superseded round's signatures leaked into the current round | Reasoned from `incomingHandoverViewWithClient` and the existing acceptance comment, then covered by a test | The blindness flag `acknowledged` and the displayed acknowledgements now follow the **current** round (`line.sessionId`), the same clause acceptance already uses. **This is a behavior change in a blind-disclosure service; please review it.** |

Files: `src/app/api/handovers/[id]/route.ts`, `src/lib/handover.ts`, `src/lib/stock-count.ts`, `src/components/handovers/handover-detail.tsx`, `receiving-model.ts`, `receiving-sheet.tsx`, `src/components/stock-counts/count-line-row.tsx`, `stock-count-detail.tsx`. Tests: new `tests/handover-022-receiving-display.test.ts` (pure row display, signed values, refusal wording, HTTP journey: figures `8 / 10 / −2`, null is not zero, a superseded dispute stays out and the replacement round stays blind, static stacked-layout checks); updated `tests/count-018-…` (it asserted the raw line id) and `tests/ui-008-…` (two static assertions followed the moved wiring). No stored count, audit row, approval rule, custody state or schema was changed.

### 2. Test evidence reconciled (no totals added across runs)
- `focused-1.log` (46 tests, 1 failure): the failure was COUNT-018's assertion that the refusal contained the raw line id, now intentionally the item name. Fixed in the test at 01:20; `count018-rerun.log` 20/20.
- `focused-2.log` (17 files, 290 tests, started after the last source edit at 01:26): 288 passed, 2 failed, both UI-008 static assertions that matched removed source strings. Fixed in the test at 01:40; `focused-3.log` (UI-008, UI-002, display tests) 20/20.
- Resolution: no source file changed after 01:26, COUNT-018 ran again inside `focused-2` and passed, and the only failures there were the two UI-008 assertions, which pass in `focused-3`. So every earlier failure is resolved against the current source of that point: 290 distinct tests in 17 files pass (not 45+20+288+20).
- Later layout edits (stacked cards) changed only classes: after each, `tsc --noEmit` exit 0, focused ESLint 0 errors (one inherited warning), whitespace scan clean, and `handover-022` + UI-008 + count-entry render re-run against the production server: 15/15 and 16/16 (`final-20261030/focused-final*.log`). The broader group, including scheduled full counts (`count-016`), required items (`handover-004`), configuration (`config-001/002`), recount (`handover-007`), accept (`handover-008`), HTTP journeys (`handover-021`) and combined receiving (`handover-020`), is the 17-file `focused-2` run; those files do not touch the later class-only edits. The 2,000-line receiving cap is the unchanged `.max(2000)` in `src/app/api/handovers/[id]/acknowledge/route.ts` (not modified here); no cap-specific test was rerun and the cap was not exercised in the browser.

### 3. Browser evidence
**Development server (`next dev`, port 3143, current source at the time):** within-tolerance difference (branch tolerance 2: counted 11 vs 10 = +1 "داخل السماحية") still ends `SUBMITTED`, no `COUNT_SYSTEM_VALIDATED` audit, no cashier confirm control, waiting for a manager; manager approval end to end (refusal naming the item → "اعتماد الفرق" requires a reason → "تأكيد الجرد" with a real manager signature → cashier submits custody → incoming counts independently (receiving difference 0, outgoing difference −2 shown separately) → separate cash+custody confirmation → `COMPLETED`); dispute display on a fresh fixture; roles (waiter: "ليس لديك صلاحية لعرض التسليم والاستلام", no sidebar link; storekeeper: handover page without review controls, API `confirm` → 403, `GET` count → 200; waiter API 403 on all three); selected-item scope (a non-critical item is not required; required snapshot 2 of 3 items) and settings read back unchanged (`HYBRID / CRITICAL / MANUAL_ONLY`).
**Production build (`next start` on 3144, task-only random `AUTH_SECRET`, database 5440):** matching count at 375 px (stacked cards, full names, system validation with `confirmedById` null); manager-approved shortage 8 vs 10 through outgoing submission, independent receiving counts and separate cash/custody to `COMPLETED` (refusal named the item; manager signature recorded); receiving dispute at 375 px (alert, next action, `فرق الاستلام: −2`, null shown as "بدون عدّ مستقل · —", no cash/custody control); on the final build: the dispute at 375 px with stacked rows, a matching handover through to `COMPLETED` with an independent count on one line and "without independent count" on the other (null kept), and opposite differences (+1 / −1) staying `SUBMITTED` for a manager.

### 4. Build identity and correspondence
Stale build preserved, not deleted: `.next-touch.stale-20261030` (BUILD_ID `Ozt9fqTAgE45ZclcICSGg`, 463 MB; identifying hashes in `.private/hnd-ux/stale-build-evidence-20261030/`). `next build` (Turbopack, `CASHIER_TOUCH_BUILD=1`, existing Prisma client, no `prisma generate`) produced, in order: `h0i6BVzayPXPnLW8lhpyz`, `IDvsXzk2LIGBZkoUHMpCC` (each superseded by a later source edit) and the **final `YqM2FAtmJ2KwW0KkxTzG0`**, built from source tree hash `2058b4b4ec92efd8…` (sha256 of every modified/untracked file under `src`, `tests`, `prisma`, `package.json`, `next.config.ts`); the hash was recomputed after the build and matches. Logs and hashes: `.private/hnd-ux/final-20261030/`. Labels: the matching and manager-approved-shortage journeys on production ran on `IDvsXzk2…` (identical to the final source except the receiving-table class change); the final build was exercised by the three journeys listed above and the tests. Development-server observations are labelled as such in section 3.

### 5. Limitations and things to know
- No human UAT, no physical device, no screen-reader run. Screenshots (4) are in `.private/hnd-ux/browser-2026-10-30-followup/`; most results were read from page text, DOM measurements, the database and network because the pane's screenshots lag one step.
- The within-tolerance journey and the storekeeper/waiter UI checks ran on the development server, not on the production build. Scheduled full counts were verified by the unchanged server group (`count-016`, config tests) and by settings read-back, not by a scheduled-count browser walk.
- Storekeeper UI: the review pane needs `stock_count.confirm`, which the role lacks; I did not add or change grants. One API probe I made with the storekeeper (`POST …/submit` on an already submitted fixture session) was an idempotent replay but wrote one extra `COUNT_SUBMITTED` audit row in that synthetic fixture; state unchanged.
- The manager-approval journey on production used the E2E cafe with reason codes; the opposite-differences cafes have none, so they stop at "needs manager" by design.
- The `acknowledged` current-round scoping (section 1) and the first dev start's HTML 404 on nested routes (stale `.next/dev`, renamed to `.next/dev.stale-20261030`, cause unconfirmed) are the two items most worth a second look.
- The Stage 2 purchase worktree was not touched and nothing was copied between checkouts.

### 6. Resources and cleanup
Started and stopped by this continuation: production server 3144 (stopped; no listener on 3141/3142/3143/3144). The 5440 cluster (PID 5036, data directory `C:\Dev\_nextcup_r10_accept\pgdata`) was already running when this continuation began, started earlier in this same run under your authorization, so I left it running as instructed; stop it with `pg_ctl stop -D C:\Dev\_nextcup_r10_accept\pgdata -m fast` when you no longer need it. 5442 and 5433 untouched. Temporary launch entries I had added to the other project's `.claude/launch.json` were removed. Fixtures, evidence and previous builds are preserved.


## HND-UX-004 two-screen close — Claude, 2026-10-30 (Africa/Cairo) — PARTIALLY COMPLETE

Earlier sections are history and unchanged. Source: `release/pilot-r10-20261027`, HEAD `c6e30f6` plus all prior uncommitted work plus the edits below. Nothing staged, committed, pushed or deployed. Stopped early because the session usage limit was reached.

### Implemented
- Close is now `/close-shift` («إنهاء الشيفت» from POS/current-shift): screen 1 «تسليم الفلوس» (all drawer cash incl. opening float, card/wallet totals when the channel took money, optional note), screen 2 «تسليم الخامات» only when due (blind, owner-selected scope, one «إنهاء التسليم»), then «تم تسجيل تسليم شيفتك». Server-read stage (`GET /api/shifts/close-flow`) resumes at materials after refresh/lost response; the old POS close dialog was removed (one close path).
- Money/tender differences no longer require a reason (`resolveVarianceReason`, `resolveTenderSettlement`); NULL note, case stays OPEN.
- Materials cadence per branch (EVERY_SHIFT default / DAILY / WEEKLY + weekday + cutoff "HH:MM"), `src/lib/materials-schedule.ts`; one claim per business period (partial unique index), missed periods claimed by the next close, NOT_DUE closes with no handover/freeze and records next due. Settings panel shows «تسوية الفلوس: كل شيفت» and the cadence controls, separate from the periodic full count.
- Complete handover count with differences → `COUNT_OUTGOING_DECLARED` audit, lines `VARIANCE_RECORDED`, `confirmedById` NULL (never a match, no manager). `finish_outgoing` action on `POST /api/handovers` submits count+handover in one transaction, idempotent; missing items refused by name. Submit no longer refuses `VARIANCE_REASON_MISSING` (still named in position/audit).
- Receiving (HND-UX-003): a different quantity is ACCEPTED with the difference recorded; `refuse` (or a dispute reason) is the explicit DISPUTED path. Acceptance applies the receiver's accepted count as the balance (`HANDOVER_RECEIVING_COUNT` COUNT_REBASE).
- Shift report page and `GET /api/shifts/:id/report` add materials (decision, period, covered shifts, per-item counted/expected/diff, receiving, evidence, unresolved responsibility); WhatsApp template params unchanged. Login honours a safe relative `next`.
- Migration `20261030130000_hnd_ux_004_materials_cadence` (additive). Applied ONLY to verified `cafe_ops_test_hndux_20261028` @5440 (marker present, datadir verified). Prisma client JS regenerated; engine DLL rename EPERM (locked by 3144) — binary byte-identical, harmless.
- `.next-touch.stale-20261030/.gitignore` (`*`) added so Tailwind stops scanning that preserved folder (dev CSS failed); nothing moved or deleted.

### Verification so far
- `tsc --noEmit` clean; focused ESLint 0 errors (set-state-in-effect warnings only).
- New `tests/hnd-ux-004-two-screen-close.test.ts`: 9/9 PASS via guarded runner on dev server :3146 (server proved co-located). Log `.private/hnd-ux/hndux004-run1.log`.
- Broad related run (`.private/hnd-ux/hndux004-regression-1.log`, was still running when stopped). Failures seen and updated as legitimate policy changes: CASHCLOSE-001/002, COUNT-004, close-guidance, OPS-001, UI-003, UI-015, HANDOVER-006 (incl. SH-17 walk now leaves a gap), HANDOVER-008 replay (split into stale-unsigned + signed replay), COUNT-012 (prior-session wording change). CASH-001 #7 fails on ambient pre-existing demo data (shift `cmvr8qosn…`, 2026-10-27) — not this change.
- NOT yet updated/re-run: HANDOVER-007 2.3/3.6 (assert old receiving refusal; change to `refuse: true` + «لازم تحدد سبب الاعتراض»), 6.8 and 7.2 (fixtures need a gap like SH-17); HANDOVER-021 and receiving-model tests; remainder of the regression list. None of the updated tests has been re-run yet.
- NOT done: production build, browser walkthroughs/screenshots (fixture script `.private/hnd-ux/hndux004-browser-fixtures.test.ts` written, not run), owner UAT.

### Resources
- Task dev server `hnd-ux-004-test-server` on :3146 (launch entry in `C:/Dev/cafe-operations-system-3/.claude/launch.json`) — task-owned; stop when done. Owner preview :3144 (`.next-touch`, YqM2F…) untouched. 5440 cluster left running; 5433/5442 untouched.
- Deployment implication: the migration must be applied before this code runs; `ALTER TYPE ADD VALUE` is non-transactional-safe in PG17.


## HND-UX-004 continuation — regressions, two fixes, final build and browser checks — Claude, 2026-10-30 (Africa/Cairo) — PARTIALLY COMPLETE

Earlier sections are history and unchanged. Same checkout and branch; nothing staged, committed, pushed, merged or deployed. This entry corrects one statement in the previous one: "`ALTER TYPE ADD VALUE` is non-transactional-safe in PG17" was imprecise. Precisely: in PostgreSQL 12+ (this cluster is 17) `ALTER TYPE … ADD VALUE` may run inside a transaction, but the new value cannot be USED in that same transaction. The migration only adds `VARIANCE_RECORDED`; nothing in it uses the value. Observed: it applied cleanly on the disposable DB and later transactions wrote and read `VARIANCE_RECORDED` rows (COUNT-004 reads `pg_enum`). Deploy order: apply the migration before running this code.

### Previous run, accounted for
`hndux004-regression-1.log` completed (footer present): 1117 tests, 1068 pass, 49 fail, exit 1. It was not active when this continuation started.

### Two defects fixed (reproduced by new tests first)
1. Explicit refusal of a MATCHING quantity was recorded as ACCEPTED. Now an explicit `refuse: true` is always DISPUTED (matching quantity or no independent count) and still needs a HANDOVER reason; the legacy API shape (a dispute reason without `refuse`) keeps its old meaning (disputes a difference, ignored on a match or null count). `src/lib/handover.ts`.
2. A branch-custody (end of night) close forced a materials count every night, defeating daily/weekly cadence. Now: BRANCH_CUSTODY still requires the `handover.exception` grant even when no count follows (checked before the schedule); with materials not due and no periodic FULL count due it takes the ordinary uncounted close (no handover, no freeze, decision NOT_DUE, `requestedHandoverTarget` audited); a due FULL count still counts every eligible item. Exception kept on purpose: when the branch stores night cash (`overnightCashEnabled`), `CashStorage` can only exist on a branch-custody handover, so that close still counts (reason BRANCH_CUSTODY). A carried/unverified branch-custody transition with night cash is NOT implemented. `src/lib/cash-close.ts`, `src/lib/materials-schedule.ts`.
Also fixed from browser findings: the success screen claimed "جرد الخامات غير مستحق" for a café that does not count at all; a network save failure showed raw English; the handover page still said "أي اختلاف يتطلب مراجعة"/"الفروقات يراجعها المسؤول"; report "الجدول" duplicated the cadence; screen 1 did not foresee a due FULL count when branch custody is ticked; the report listed no covered shifts for a branch's first scheduled count (now starts at the claimed period's first business day).

### Test changes classified
- Old policy deliberately replaced (owner decisions HND-UX-003/004): CASHCLOSE-001 (4), CASHCLOSE-002 (1, now refused by a schema-invalid count), TENDER-001 (9), TENDER-002 (1), TENDER-003 B/C/D, HANDOVER-006 (4), HANDOVER-007 2.3/3.6 (now send `refuse: true`), handover-020, handover-021 outgoing-difference, handover-count-system-validation (2), handover-receiving-model, COUNT-004 (fourth terminal state), close-guidance/OPS-001/UI-003/UI-015 (close moved to `/close-shift`).
- Fixtures that no longer reached the intended state: SH-17 walk and HANDOVER-007 6.8/7.2 (a complete differing count is now declared; SH-17 leaves a gap so manager confirmation stays covered; 7.2 asserts no fabricated reason). HANDOVER-008 replay split: unsigned evidence becomes stale after a post-count movement (acceptance 409), and the manager-signed shape still replays (8.75).
- Prior-session wording change: COUNT-012 #4 (refusal names the item, as COUNT-018 already asserted).
- CASH-001 #7 investigated: it asserted every pre-existing shift in the whole DB has a NULL reason note. Evidence: demo-café shift `cmvr8qosn01aehlb0e961bsz2` was closed 2026-10-27 22:18:49 with +25 and reason `'test'` (SHIFT_CLOSED audit at the same instant, `updatedAt` = close time, never written since). The test now captures each pre-existing shift's reason code/note and asserts they are unchanged (NULL stays NULL); the café's data was not touched.
- NOT resolved, environment: SHIFT-003 (10). It drives the seeded demo café, whose branch has the owner's live DRAFT handover `cmvr8z81g01f5hlb001pu18nd` (2026-10-27 22:18); `src/lib/custody.ts` (unchanged) correctly gates every new shift there ("الشيفت مستني استلام العهدة"). Not reset, per the owner-cycle rule.

### Final-source evidence (distinct tests, not cumulative)
- `hndux004-regression-2.log` (dev server 3146, source before the last UI/report-copy edits): 1128 tests, 1118 pass, 10 fail = SHIFT-003 only (environment above). Server proved co-located with `cafe_ops_test_hndux_20261028`@5440.
- Final production build `CGwnBuBZLD-_RWybWXv3Z` (`.next`, `hndux004-next-build-2.log`, exit 0; one pre-existing NFT warning about `next.config.ts`). Source tree hash over 99 modified/untracked files under src/tests/prisma/package.json/next.config.ts: `36067fff…` identical before and after the build. After the build only `tests/ui-003-…` changed (not part of the app).
- Against that build on 3147: `hndux004-final-build-focused.log` 82 tests (HND-UX-004 suite 11, close-guidance, UI-003/008/015/016, handover-020/021/022, receiving-model, OPS-003): 81 pass, 1 fail (UI-003 asserted the removed defective branch); UI-003 restated and re-run: 6/6 (`hndux004-final-ui003.log`).
- `tsc --noEmit` clean; ESLint on all touched files 0 errors (set-state-in-effect warnings only); `git diff --check` clean.

### Browser checks (built-in browser, production build 3147, fixtures `.private/hnd-ux/hndux004-browser-fixtures.json`)
Observed through real controls: POS «إنهاء الشيفت» → «تسليم الفلوس» (blank and over-precise cash keep the button disabled with a field error); 1600/480/220 → «التالي: تسليم الخامات»; only the 3 selected items, blind; leave and return → «كمّل تسليم الخامات» resumes without resettling; injected network failure (test instrumentation) kept the draft, showed the error at the field and «إعادة الحفظ», finish disabled until 3/3; note; double-pressed «إنهاء التسليم» → «تم تسجيل تسليم شيفتك», waiting for the next employee. DB read-back: cash diff 0, CARD −20, WALLET +20 (NULL notes), 3 payments/1 order unchanged, one SHIFT_CLOSED, one HANDOVER_SUBMITTED, count CONFIRMED unsigned with 2 VARIANCE_RECORDED lines and no system match. «تسليم الجهاز للموظف الجاي» → login → returned to the intended handover with outgoing figures hidden. Owner report (cash/card/wallet, «بدون ملاحظة — للمراجعة», materials table, «غير متاحة» cost, pending receipt, unresolved responsibility); daily due report shows the claimed period; another café's report refused, cashier 403 on the oversight API. Opening 600/no sales/600 → 0 (current-shift entry, same screen); daily not due (B) and weekly branch-custody not due (D) finish on screen 1 with the true next due time; due FULL count at branch custody (E) switches the action and shows both items; explicit zero vs blank (C, money already committed). 375 px: screens 1 and 2 have no horizontal overflow, stacked item cards, 48 px main action. Screenshots: `.private/hnd-ux/browser-hndux004/`.
NOT browser-verified: the incoming receiving sheet (different count accepted, explicit refusal checkbox) and completing the next shift. The built-in pane stayed hidden, `requestAnimationFrame` never fired (probed), and the Suspense handover page stayed at «جاري تحميل التسليم…» with no API calls; the API itself returned 200. These behaviours are covered by the service/HTTP tests only.

### Resources
- Delivered preview: http://127.0.0.1:3147 — `next start` of build `CGwnBuBZLD-_RWybWXv3Z`, task-owned, launch entry `hnd-ux-004-prod-3147` in `C:/Dev/cafe-operations-system-3/.claude/launch.json`, DB 5440 `cafe_ops_test_hndux_20261028`, random task-only AUTH_SECRET per start, WhatsApp pointed at a dead local port. It lives with the app session that started it.
- Stopped: dev server 3146 (task-owned). Owner preview 3144 (`.next-touch`, `YqM2F…`) untouched and answering. 5440 left running; 5433/5442 untouched.
- Remaining: browser receiving walk; SHIFT-003 needs an isolated café or the owner's cycle finished; night-cash branch custody without a count; owner UAT. Production is not authorized.


### Addendum — receiving browser walk, same build `CGwnBuBZLD-_RWybWXv3Z` (3147), 2026-10-30
With the owner's pane in view (`requestAnimationFrame` probed: fires), the receiving gap above is closed for scenario A, through real controls:
- Incoming employee (own login, own gated shift) opened the handover from POS «متابعة التسليم». Cups «أستلم دون عدّ مستقل», coffee 8 (handed over 9), milk 13; «أؤكد قرارات الاستلام» → every line «تم استلام السطر», coffee «فرق الاستلام: −1», cups «بدون عدّ مستقل · —». Counted cash 1600 → «تأكيد استلام عهدة الشيفت» + dialog → «مكتمل». DB: COMPLETED, no exception signer, acknowledgements ACCEPTED (null / 8 vs 9 = −1 / 13 vs 13 = 0), coffee balance 8.
- The receiver then closed their own shift through `/close-shift` (opening float shown as 1600, cash 1600, coffee 8, milk 13, cups 6): count SYSTEM-validated, every difference 0, cash difference 0 — the −1 recorded at receipt was not found again against them.
- Explicit refusal UI: ticking «أرفض استلام الصنف ده» on a line with a MATCHING count leaves that line undecided (2/3), keeps the confirm disabled and asks for «سبب الرفض»; it is never sent as an acceptance. This café has no HANDOVER reasons, so refusal → DISPUTED stayed server/HTTP-tested only. Nothing was submitted from that sheet (handover `cmvv5xim9033jhl7wtgccjbog` stays OUTGOING_SUBMITTED with Sara's shift #3 open and gated).
- Observation, pre-existing page behaviour: a full browser load of `/handovers?…` (address bar / reload) stayed on its Suspense fallback «جاري تحميل التسليم…» with no API calls even with rAF running; opening it through the in-app link (client navigation) works every time. Not changed here.
Screenshots 09–10 added to `.private/hnd-ux/browser-hndux004/`. Remaining: owner UAT; SHIFT-003 environment block; night-cash branch custody still counts; the `/handovers` full-load observation.


# Cash receipt difference: optional reason and note — 30 October 2026

Status: COMPLETE for this requested cash-receipt defect, locally implemented and checked on the production-build test preview. This does not complete owner UAT or authorize release of the whole HND-UX-004 workstream.

## Reproduction and cause

The owner saw “لازم تحدد سبب فرق النقدية بين المسلم والمستلم وتكتب ملاحظة” when accepting a different counted cash amount. HND-UX-004 had made outgoing close commentary optional, but `recordCashHandover` retained the earlier mandatory reason-plus-note guard on incoming cash differences. `OpeningException.reasonCodeId` also remained non-nullable, so hiding the guard alone could not persist an honest unexplained observation.

The new service regression reproduced that exact error before implementation. The red run was 4 pass / 4 fail, with the four newly allowed optional-evidence cases failing at that guard.

## Changes

- `src/lib/cash-handover.ts`: reasons and notes are independently optional for a nonzero ordinary handover cash difference. A supplied code must still belong to the café, be active and have HANDOVER domain. No fabricated reason, note, manager approval or financial liability.
- `prisma/schema.prisma` and migration `20261030170000_cash_receipt_optional_reason`: nullable observation reason; preserve existing supplied references and explicit delete restriction. A database check retains required reasons for other exception kinds. Other service paths, including overnight-cash exceptions, retain their existing reason rules.
- `src/lib/employee-variance-report.ts`: safely renders a missing reason as null while retaining the HANDOVER_CASH case and both quantities.
- `src/components/handovers/handover-action-bar.tsx`: receipt note explicitly labelled optional.
- `tests/handover-018-cash-verification.test.ts`: nine real service/database/report checks, including shortage/surplus with no reason, note only, code only, invalid optional code, bad currency and retained non-cash exception guard.
- `tests/hnd-ux-004-two-screen-close.test.ts`: real API acceptance at 1580 versus 1600, no commentary, idempotent replay and next close at 1580 with no repeated cash shortage.
- `tests/var-001-case-schema.test.ts`: explicitly asserts the supplied reason remains attached before dereferencing the now-optional relation.
- `tests/handover-008-accept.test.ts`: updates the superseded mandatory-reason expectation while preserving one-case replay, custody opening and manager-override replay refusal.

Original versions of each edited existing file were preserved under `before/`. Unrelated release work was preserved. No staging, commits, pushes, production database changes or notifications.

## Verification

- Fresh typecheck after the final test update: PASS, `typecheck-delivery.log`.
- Focused lint: PASS, `lint-final.log` and `lint-acceptance.log` (no output/errors).
- Production build: PASS, `build.log`; BUILD_ID **VG8srzmXHQz7mQuYq_lEf**. All application source edits preceded the build; later edits were tests/documentation only.
- Nine receipt tests are included in the targeted production-build regression group. That first group ran **159 distinct tests: 158 pass, 1 fail**. The one failure was HANDOVER-008's old mandatory-reason assertion. After replacing that policy expectation, the entire affected acceptance file passed **70/70**, `acceptance-rerun.log`. Those 70 overlap the original group; do not report 229 distinct tests. No observed failure remains in this targeted scope. The whole repository suite was not rerun.
- The guarded runner verified the exact disposable DB `cafe_ops_test_hndux_20261028` on 5440 and app/database co-location. Directory/marker were independently checked: `C:/Dev/_nextcup_r10_accept/pgdata`, “Disposable HND-UX-001 task database created 2026-10-28. Synthetic fixtures only.” The migration was applied only there. 5433 and 5442 were not accessed.
- Standard Prisma generation wrote current JS/types before failing to rename the engine DLL held by the old preview. Verified runtime DMMF optionality and byte-identical installed/package engine SHA256 `263946105f428384d2318dc3241b85b1c3dd98fbb1bfac62d3e81f513ab35897`; completed the schema-file copy while preserving the existing engine and 3144 process. Fresh checks and the production build then passed. Do not label the initial generate command itself a success.

## Actual browser check and stored result

A separate synthetic café `PH1-CASHOPTUI-22908-1` was used. The owner's current receiving attempt was not completed by the agent.

Through actual in-app browser controls: signed in as the owned incoming employee, navigated through the application's handover link, independently counted the one item as 5 and confirmed its receipt, typed cash **530**, left the reason at **بدون سبب** and the optional note blank, pressed the acceptance button and its confirmation. The screen reached **مكتمل** without the old refusal.

Read-back, `browser-readback.json`:

- Outgoing declaration **550**, incoming counted **530**, difference **−20**.
- Handover **COMPLETED**, incoming opening/expected cash **530**, custody gate cleared.
- Exactly one linked difference case, status **OPEN**, reason code **null**, note **null**, assigned responsibility **null**.
- Screenshot: `receipt-completed.png`. Fixture metadata: `browser-fixture.json`.

The first browser-fixture preparation attempt stopped on its helper expecting 200 for a valid 201 Created response. The helper was corrected, and the second fixture preparation passed. Both attempts' owned synthetic data were preserved; this was not an application failure. No owner data reset was used.

## Resources and remaining scope

- Rebuilt and restarted only preview 3147. New process **23904**, started `2026-10-30T16:52:42.8694446Z`, ownership in `preview-owner.json`. New AUTH_SECRET is process-only; existing browser sessions may require signing in again.
- Preview: http://127.0.0.1:3147. Left running for owner testing. Separate 3144 process **23504** was preserved. Existing 5440 database process **5036** was left running; no database control operation was performed.
- In-app browser tab 4 shows the completed synthetic receipt and is retained as a deliverable. The owner's Edge tab was not operated.
- Earlier broader HND-UX-004 limits remain separate: owner UAT, prior SHIFT-003 seeded-café environment failures, scheduled branch custody with overnight cash, and the historical full-load `/handovers` observation. This cash fix does not claim those resolved.

Deployment, when separately authorized, needs the new migration and generated client before using this code against another database.
