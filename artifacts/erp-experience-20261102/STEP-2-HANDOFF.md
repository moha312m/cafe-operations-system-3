# NEXT CUP Step 2A–2C handoff — 2026-11-03

## Runtime closeout — 2026-11-03 Africa/Cairo

**Technical closeout complete. Owner visual acceptance pending.** The original partial handoff below records the state at 7865392. Source correction: 4ec914f166228e9cc8296d6b8dd123a9f49d5bba on codex/nextcup-workspace-redesign-20261102, preserving 6bcdefb and 7865392.

- Reproduced the missing November 1 invoice against the preserved build. The corrected report, CSV and print context use invoiceDate for confirmed purchases. The synthetic invoice dated November 1 and confirmed November 3 appears on November 1 only. The EGP 17.35 settlement stays on November 2 by paidAt.
- Fixed report branch/category selection when asynchronous options have yet to load. The rapid resubmit check held the older GET, verified both selections while pending, observed cancellation, and returned one correct result for the latest request.
- Final production build 3CpBRLmpvaT0JJp6jkZ9K, app PID 24440 on 3113. At 21:27 Cairo, the unchanged guard verified localhost:5434, the authorized pgdata, system ID 7693368256609479860, OID 65538, disposable marker, 91 migration checksums and 986 source files. Manifest f38ab10a19ea4a09981f6439dd22b5fe3578de3b3f5bcb3b7f732bf8a7e7ac4e. A resumed disposable postmaster PID 10352 completed normal recovery after the earlier task process exited. No manual data repair.
- Final targeted suite 21/21, nine live report groups passed. The first final test invocation omitted the fixture configuration and failed at its fixture guard. It passed with the retained fixture configuration. Browser acceptance includes 18 final-build captures at 1440/360/390 CSS pixels with no page-wide horizontal overflow, detail drill-down, and the rapid resubmit check. Prior closeout build evidence covers focus/back, shift drill-down, empty/loading/error/timeout/retry and browser CSV downloads. XLSX and A4 print HTML were inspected as actual output artifacts. Physical devices and printer output were outside this check.
- Runtime evidence includes 61 results (30/30/1), page CSV 30 versus full 61, exact 0012 vs 12, 40% contribution, and EGP 9,915 matching the canonical daily total. Tenant, branch, cost/customer permissions and old output tokens were exercised. The retained POS receipt was audited and POS accepted a synthetic item into an unsubmitted cart. Report runs and receipt checks preserved business money, order, stock and GL counts.
- Preview: [SKU](http://localhost:3113/reports/product-sales?branchId=wr_s2c_20261103_branch&from=2026-11-01&to=2026-11-02&q=0012), [purchase date regression](http://localhost:3113/reports/purchase-sales?branchId=wr_768a4910b7034ed5b6737e05b6930456&from=2026-11-01&to=2026-11-01&q=STEP2C-DATE-20261103), [report center](http://localhost:3113/report-center). Uses the retained synthetic workspace session.
- Evidence: local step2-closeout/verification.json and runtime logs in this worktree. Final screenshots and browser matrix are in C:/Dev/cafe-operations-system-3/artifacts/erp-experience-20261102/step2-closeout/screenshots/final. State captures and rapid-scope proof are in its parent directory. The older stale-protected image records the pre-fix result.
- Owner database untouched. No push, main merge, Railway action or deployment. Closeout stops at Step 2C.

## Original Step 2 handoff

Status: **PARTIALLY COMPLETE**. Local implementation exists; dedicated runtime/browser acceptance is **UNVERIFIED**, owner visual acceptance **PENDING**. Do not promote static or pure evidence to runtime acceptance.

## Target and boundaries

Existing worktree: `C:/Users/Acer/.codex/worktrees/nextcup-workspace-redesign/cafe-operations-system-3`; branch `codex/nextcup-workspace-redesign-20261102`; baseline `e9f55c769a309815e973f393033430c25548811e`. Owner checkout remains on `codex/integration-all-approved-20261101` at the same baseline, with its 14 pre-existing tracked changes retained. Step1B source/evidence retained.

No owner SQL/business-data changes, original activation, PostgreSQL service control, provisioning, reset/seed, schema/migration, dependency installation, `.env` edit, push, main merge, Railway action or deployment occurred. No finance policy, menu price, financial command/retry behavior, accountant approval or D7/D8 disposition was changed. Production readiness is not claimed. Private Step2 source-manifest configuration is separate from the preserved Step1 configuration and guard.

## Screenshot-to-feature checklist

| Owner reference | Implemented source behavior | Acceptance |
|---|---|---|
| Sales hierarchy / invoice listing | Sales group: All Sales, Add Sale via existing POS, real server-filtered List POS, POS, supported money-refund view | Runtime pending |
| Invoice search and detail | URL date/invoice/source/customer/branch/creator/business-status/payment-status/method/sort/page; products, charges, notes, payment legs, revisions, authorized trace; existing amendments/receipts retained | Pure invoice/render cases pass; runtime/focus pending |
| Reports menu | One canonical six-report definition feeds report-center/sidebar/backend authority; existing report categories and URLs retained | Pure visibility/direct-link cases pass |
| Purchase & Sale | Separate sales, confirmed purchases, collections and supplier settlements; no fabricated profit/COGS | Runtime reconciliation pending |
| Sales payments | Actual PAID Payment legs and paidAt; no repeated invoice totals | Pure leg cases pass; runtime pending |
| Registers / shifts | Whole referenced shift lifecycle, separate sale/service/payment/posting references, recorded cash and calculated bridge, count/variance unknown until settled | Pure cross-midnight/reference cases pass; runtime pending |
| Register details | Invoice/product/payment/settled-close-report links, method amounts, cash bridge, permission-scoped expense source records | Runtime pending |
| Product report views | Stable product/variant IDs; line/date/category views, current SKU/category attribution, explicit unavailable brand/historical cost; constant contribution denominator | Pure ID/SKU/40%/bridge cases pass |
| Mobile / exports | Mobile cards and contained desktop tables, column preferences, URL state, bounded reads, page vs full snapshots, exact-text XLSX, formula-safe CSV, A4 print/PDF label | Pure rendering/output/read-helper cases pass; actual 360/390/desktop and printing pending |
| Drafts, quotations, shipping, promotions, import writes | **Not implemented: planned 2D**, no fake working links | Outside scope |

## Route and navigation map

- `/sales`: existing invoice workspace. `?source=CASHIER_POS` is an actual Order.source predicate; `?returns=1` requires an actual completed refund leg and includes partial refunds. It does not prove physical stock return.
- `/pos?entry=add-sale` and `/pos`: the existing order workflow; no new sale ledger.
- `/sales?invoice=<id>` restores a scoped invoice selection and opens the existing detail panel. Existing amendment/receipt routes remain; actual reprint retains its audit request.
- `/report-center`: discovery and existing inventory/purchasing/finance/customer/system entries.
- Six pages: `/reports/product-sales`, `/reports/shift-sales`, `/reports/sales-payments`, `/reports/purchase-sales`, `/reports/sales-staff`, `/reports/tables`.
- Each has protected GET `/api/reports/<kind>` and POST `/api/reports/<kind>/output` for signed non-financial output.
- Invoice output uses `/api/sales/output`. The generic output endpoint rejects these newly scoped tokens so it cannot bypass their current authority checks.
- Existing `/reports`, historical report routes and `/reports/shift/<id>` remain. A report never closes a shift; the existing shift workspace/guarded workflow is the only action path.

## Query and response contracts

Strict Zod query: optional cafeId (explicit for platform administration), branchId, from/to real ISO calendar dates, q≤100, shift/category/actor/session IDs≤100, allowlisted view/basis/method/sort, page1–10000, pageSize1–100, export=page|all and dayMode=calendar|business. Report-inapplicable filters are refused. Form controls submit only supported values. Business windows reuse the existing versioned branch-hour helpers with their 62-day bound. Calendar dates use Cairo `[start,end)` boundaries.

`SalesReportResponse`: kind/title/generatedAt, metricBasis/coverage, columns `{key,label}`, rows `{id,cells,details?,href?,links?}`, summaries `{key,label,value}`, total/page/pageSize/pages, selection/filterOptions and optional outputSnapshot. Money crosses JSON as exact two-decimal strings; missing quantities/counts/costs remain null. Row IDs and source links retain stable identities. Sorting has an ID tiebreaker. Text search affects rows/count/pagination; summary cards explicitly identify their pre-search scope and product denominator remains invariant.

Reports use a RepeatableRead **READ ONLY** transaction and bounded sources. Each main source is capped at5000, nested sources are bounded, total detail/row sizes capped at50000; exceeded limits refuse with422 rather than display incomplete totals. Existing invoice list/count/sums share a RepeatableRead read snapshot. Read calls do not seed settings or create orders/payments/stock/accounting entries. Effective report permission resolution also runs in a read-only transaction.

## Metric and attribution contracts

### Product/SKU

Grouping is `[productId,variantId]`; deleted links use available stock identity snapshots, otherwise a line-specific unmapped identity, never name alone. Existing SKU/category is explicitly **current catalog**, not invented historical data. Leading zeros remain strings. Grouping by business date uses the selected branch window; category grouping uses current classification. Aggregated groups do not pretend to have one constituent variant/SKU.

Original SERVED invoice recognition is restored from the first served-order revision's before snapshot when present; subsequent revisions contribute their recorded recognizedDelta in the revision period. Preparing-order amendment refunds stay in the first gross recognition, matching existing pre-service refund-basis policy. Item revenue is recorded lineTotal minus invoiceDiscountShare; item discounts are already in lineTotal and modifiers occur once there. Before/after item deltas retain their stable identities.

Share = scoped item net / all scoped item net ×100. Period/branch/actual shift/current category constrain scope; q/sort/page do not alter its denominator. Nonpositive denominator gives null. **No guessed cash-refund allocation**: unlinked refunds stay in the bridge, allocatedRefund remains unavailable. The bridge reconciles item net + tax + service + unallocated/rounding/other adjustments to canonical net sales. With a category selected, the explicitly labeled whole-scope bridge also includes other categories; the canonical overall figure is not mislabeled as category-only sales.

Quantity is **invoice quantity change**, not a physical-return inference. The separate received quantity comes only from actual linked FinishedGoodsReturn records received in the period. No record is not automatically proof of zero. That source has no receipt shift, so it is not distributed across shifts by guessing. No global incompatible quantity sum is presented. Brand and trustworthy SKU historical COGS/source-purchase links are unavailable; no current cost/latest supplier cost is substituted.

### Shifts

Select shifts by their actual openedAt window (or explicit scoped shift ID), then read complete referenced lifecycle including across midnight. Original sale uses saleShiftId, service accountability remains servedShiftId, revisions use postingShiftId, money uses Payment.shiftId. A revision missing postingShiftId remains unattributed, never falls back into a closed sale shift. Whole-life product/payment links span the actual opening/closing calendar days.

Expected cash displayed is the existing recorded Shift value. A separate diagnostic bridge reuses drawerExpected: opening + completed net CASH - supplier drawer payouts - expense payouts + expense returns. Its difference from the recorded value is exposed without rewriting or silently resolving it. Closed/AWAITING_HANDOVER snapshots remain historical. Open count and final variance are null. Expense source descriptions/IDs require expenses.view. Recognized sales and actual service/payment identities are deliberately distinct; no shift is inferred by name/time overlap.

### Payments

Independent completed Payment legs retain their stable IDs, paidAt event time, receivedById actual collector, payment shift and recorded direction/method. Legacy COLLECTION/status=REFUNDED is preserved as an explicitly tagged gross collection/mirrored-refund pair from one raw Payment source ID; logical display IDs differ, no Payment rows are created. Its recorded timestamp/shift/session are source evidence, not a newly invented actual refund event; the independent refund actor is unknown and stays unattributed. Actor filtering is applied after normalization. Gross collections/refunds/net money movement are separate; pending/unknown/unpaid legs are excluded. Canonical sales-refund bridge retains the existing reporting createdAt/legacy-REFUNDED treatment; this date distinction is disclosed rather than silently changing existing definitions. Authorized customer name is emitted only with customers.view.

### Purchase & Sale

Separate recognized sale events and CONFIRMED purchase invoices filtered and displayed by invoiceDate, including exports. Customer collections and supplier paidAt settlements are separate measures. Both purchase view and cost permissions and inventory/purchasing feature flags are required before data/output. No sales-minus-purchases profit measure, invented consumption cost, new valuation or P&L posting.

### Staff

Stable actor IDs, with unknown actors retained. Creator basis uses createdById and original createdAt; server basis uses servedById and servedAt; both post revisions in their own revision period. Server shift filtering uses servedShiftId for originals, postingShiftId for revisions; it never silently substitutes saleShiftId. Missing historical service timestamps are not guessed into a period. Collector basis uses receivedById/paidAt and signed collection-minus-refund money. The three bases are never added as extra sales; creator/server recognition is labeled before refunds not attributed to that role.

### Tables

Independent TableSession visits stay separate. Orders and distinct payment IDs are aggregated independently. Explicit payment.tableSessionId takes precedence over its order's session fallback; the same payment is never counted twice. Sessions opened/closed or with period activity plus current OPEN sessions are visible, including closed visits referenced only by an in-period revision or an order-linked legacy payment. Linked order count/drill-down includes the actual session orders; recognized sales/payment legs are period events. remainingAmount is **current state at generatedAt**, not a historical balance and not summed across days. Report reads do not change occupancy or take payment.

## Output and UX coverage

Thirty-minute HMAC snapshots bind actor and current cafe/branch/role/effective permission fingerprint; output rechecks current active account, required permissions/features and scope. A role/branch/key change invalidates old output. The signed snapshot retains scope/view/sort/basis/coverage/time and explicit page/all designation. Full output is a separately generated consistent snapshot, bounded to5000 filtered rows and1.8MB token; refusal never silently substitutes a page. Output context preserves declared filters; internal authorization fingerprints are excluded from print/CSV/XLSX presentation.

Opt-in exact-string output preserves decimal text and SKU strings in XLSX; CSV retains the raw quoted values and applies spreadsheet-formula escaping, and Excel import should use text for identifier columns. Arabic remains Unicode. Browser print is labeled **طباعة / حفظ PDF**, with A4 styling and field/value record layouts for wide analytical tables; no native PDF generator or physical/thermal printer verification is claimed. The existing separate receipt layout/audit remains. No thermal layout was added for analytical reports.

Shared reads use the Step1B20s deadline, abort-on-supersede/identity and stale-response protection. No financial write cancellation/retry identity was changed. Loading, empty, failed/retry and unsupported-coverage states are separate. Filters/group/sort/page live in URLs; column preferences are per user/report. Mobile uses readable cards; detailed tables scroll inside their region; detail dialogs retain close/focus behavior.

## Actual verification and failures

- **43 database-free tests PASS**,0failed/0skipped: new analytics/query/invoice/output/render cases plus existing navigation, report-center, sales, read deadline and business-window regressions. `step2/pure-final.log`. These include61 synthetic rows, 40% search/paging,0012 vs12, same-name IDs, revision/cash-refund bridge, A/B/C roles, shift-reference nulls, repeated sessions/payment dedupe,8-hour23–07 window, missing coverage and catalog permission/feature cases.
- Focused TypeScript runs passed during implementation. Final production build and final lint result: see final closeout below.
- Independent read-only review found three important attribution omissions (service-shift filter, closed session activity, legacy refunded movement evidence). All three were reproduced with failing pure cases, fixed, and re-reviewed as closed. No additional important concern was found within those fixes; this is source review, not runtime/auth acceptance.
- Expected test-first missing-module failures occurred before implementation. A shared export regression exposed recursive fallback; corrected and explicit legacy numeric/string regression passes. A JSX closure and React memoization lint diagnostic were corrected. Historical evidence is not rewritten as pass.
- An initially selected existing output-parity suite imports the database harness. Its synchronous URL guard refused the inherited owner-target URL **before constructing Prisma or issuing SQL**. It was not retried against owner data; the final pure list excludes this integration suite. No runtime result is claimed for it.
- The unchanged guard first rejected stale source inventory as designed. A separate Step2 manifest/config was then created, preserving the original guard and Step1 config. Dedicated identity verification reached only127.0.0.1:5434 and failed: **database unavailable**. `step2/runtime-gap.json`; no mutations attempted. No PostgreSQL start/control or owner database fallback occurred.
- Desktop/360/390 authenticated report screenshots, real report reconciliation, real two-cafe/restricted-role API/detail/export checks, live revocation, real slow/empty/failed/stale journeys, shift/invoice drill-down and physical printing remain **UNVERIFIED**. Pure tests do not establish them.

## Preview identity and demonstration

No currently working authenticated Step2 preview is claimed. Intended disposable preview origin: `http://localhost:3113`; expected database `cafe_ops_test_integr20261101_replay_66515e42c85e8ec4`,127.0.0.1:5434,OID65538,system7693368256609479860,`C:/Dev/_nextcup_test_postgres/pgdata`. These are expected retained identities, not fresh successful proof. Owner3110/5433 was never commandeered. Native CIM enumeration was unavailable in the default sandbox; no denied-access workaround was used.

Once the existing dedicated environment is available under the current restrictions, first refresh the Step2 source manifest and run the unchanged full identity/correspondence guard. Only then start/retain the owned app if permitted, sign in with the retained **synthetic** fixture, visit the six `/reports/<kind>` pages, exercise page3 of61rows and page/full outputs, select each role basis, open shift/product/invoice details, and verify desktop/360/390 states. Capture genuine screenshots and record actual source hash/DB/app correspondence. Do not use real owner credentials/data. No screenshot generated from static markup is presented as runtime evidence.

## Remaining work / stopping point

Current independent implementation and static evidence do not close runtime/visual acceptance. Finish the unavailable dedicated-environment checks before claiming full delivery. Keep owner acceptance pending. No Step2D/3 or additions7–9 were started; no backup, offline/LAN synchronization, price recalculation, draft/quotation/shipping/promotions/import workflow was implemented.

Local source/verification commit and exact changed-file list: final closeout below. Only bounded Step2 source/tests/handoff/plan may be staged; private configs, fixtures, logs, build output and historical untracked evidence stay local.

## Final closeout

- Reviewed local source/test commit: `6bcdefb8965010143f5d16609e07a9baba077106` (40files); not pushed or integrated into the owner checkout.
- Final pure suite: **43PASS /0FAIL /0SKIP**, exit0. Final focused ESLint over all40 changed/new source/test files: **exit0,0diagnostics**. Final installed Next16.2.10 webpack production build: **exit0**, including TypeScript and page-data/static generation. Build ID: `c_vrlFB3ZoOgiOAaHWyhv`. No Prisma generation, migration or schema command was run. Earlier successful build logs remain separate; final build follows the independent-review fixes.
- Final source inventory: **985files**, manifest SHA256 `a4ba493a392e9fe1fa4503ab114e2f360d53c5c18a3bad601bdccc8dbb6ed016`. `step2/source-final.json`.
- Fresh final dedicated guard at2026-11-03T14:57:54.798Z again failed reaching5434 before any mutations; `step2/runtime-final-gap.json`. Therefore **no working preview URL, desktop/mobile runtime screenshots, live authorization proof or owner acceptance is claimed**.
- Independent source review rechecked the three corrected findings and found no additional important issue within those fixes. Its scope excludes runtime/authorization/browser verification.
- Machine-readable actual results: `step2/verification.json`. Logs/configs/fixtures/build outputs remain local; no private file is committed.
- Final status: **PARTIALLY COMPLETE**. Source/static verification complete within these recorded contracts; runtime and visual delivery gates open. Stop after2A–2C.

### Changed source/test files

- `src/app/(app)/reports/product-sales/page.tsx`
- `src/app/(app)/reports/purchase-sales/page.tsx`
- `src/app/(app)/reports/sales-payments/page.tsx`
- `src/app/(app)/reports/sales-staff/page.tsx`
- `src/app/(app)/reports/shift-sales/page.tsx`
- `src/app/(app)/reports/tables/page.tsx`
- `src/app/api/reports/output/route.ts`
- `src/app/api/reports/product-sales/output/route.ts`
- `src/app/api/reports/product-sales/route.ts`
- `src/app/api/reports/purchase-sales/output/route.ts`
- `src/app/api/reports/purchase-sales/route.ts`
- `src/app/api/reports/sales-payments/output/route.ts`
- `src/app/api/reports/sales-payments/route.ts`
- `src/app/api/reports/sales-staff/output/route.ts`
- `src/app/api/reports/sales-staff/route.ts`
- `src/app/api/reports/shift-sales/output/route.ts`
- `src/app/api/reports/shift-sales/route.ts`
- `src/app/api/reports/tables/output/route.ts`
- `src/app/api/reports/tables/route.ts`
- `src/app/api/sales/output/route.ts`
- `src/components/app-shell.tsx`
- `src/components/reports/sales-report-rows.tsx`
- `src/components/reports/sales-report-workspace.tsx`
- `src/components/sales/report-output-actions.tsx`
- `src/components/sales/sales-workspace.tsx`
- `src/lib/report-center.ts`
- `src/lib/report-output.ts`
- `src/lib/sales-invoice-filters.ts`
- `src/lib/sales-query.ts`
- `src/lib/sales-report-catalog.ts`
- `src/lib/sales-report-contract.ts`
- `src/lib/sales-report-math.ts`
- `src/lib/sales-report-query.ts`
- `src/lib/sales-report-server.ts`
- `src/lib/workspace-navigation.ts`
- `tests/sales-invoice-step2.test.ts`
- `tests/sales-report-output-step2.test.ts`
- `tests/sales-report-view-step2.test.tsx`
- `tests/sales-reports-step2.test.ts`
- `tests/workspace-navigation.test.ts`
