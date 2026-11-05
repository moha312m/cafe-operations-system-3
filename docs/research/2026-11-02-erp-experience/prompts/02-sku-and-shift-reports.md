# Step 2/5 — Sales hierarchy, invoice workspace and six sales reports

Recommended Codex model: **GPT-6.1 Sol**. Thinking: **Medium** for implementation. Use **High on the same model only for a focused review of difficult metric attribution, reconciliation, authorization or unresolved failures**; Astra is not required. Choose the model/effort in the Codex UI; prompt text cannot switch them. Prefer Standard speed when available to conserve usage. The owner requested this cost-conscious setting on2026-11-03. Keep the complete scope and acceptance checks unchanged; do not use additional agents or models merely to compensate for this setting.
Roadmap: preserve Step1/1B identity → align sales/report navigation → define canonical metrics → implement six reports and drill-downs → verify mobile, export and reconciliation.

Current closeout note (2026-11-03): the owner's Step2 handoff reports implemented2A–2C source in6bcdefb/7865392, with runtime/browser acceptance still pending. Use [the Step2 closeout prompt](02c-runtime-acceptance.md) to continue existing work, address the purchase-date inconsistency and verify the dedicated environment. The original implementation contract below remains the acceptance specification, not an instruction to rebuild completed source. Database startup is not authorized merely by reading/saving either document.

Implement STEP 2 ONLY, slices 2A–2C, when explicitly invoked. Recording this prompt does not execute it. Explicit invocation authorizes the bounded local source work, focused verification and reviewed local commits described below. Use only the feature worktree path/branch identified in the invoking instruction or its approved current handoff; inspect HEAD/current work without selecting an unrelated checkout. Preserve Step1/1B and read their latest handoffs, PLAN.ar.md and [the owner's screenshot-derived reference](../SALES-REPORTS-REFERENCE.ar.md). Ask for a missing implementation target only after checking those records. Do not rerun Step1 or automatically advance to Step3 or planned slice 2D.

The owner supplied ten Vendora screenshots and requested the same navigation hierarchy and easy sales reporting. Use the screenshots as evidence of desired organization and features, not permission to run their Delete, Close, ETA, notification or import actions. Preserve NEXT CUP's established identity and accounting behavior.

Delivery slices: **2A** shared navigation and existing invoice workspace; **2B** the six read-only sales reports; **2C** responsive behavior, export/print, reconciliation, browser evidence and owner acceptance. **2D** is a separately planned future sales-workflow expansion: drafts, quotations, shipping, promotions and sales-import writes. Do not fabricate these features through dead links or unsafe financial mutations.

## Operating boundaries

Original checkout: C:/Dev/cafe-operations-system-3. The real ERP on3110 and database5433 must remain untouched by tests and runtime experiments. Preserve .env, AGENTS.md, owner work, historical SQL, permissions and financial policies. No PostgreSQL control, new dependency, owner-data/schema write, push, main merge or deployment. Read relevant installed Next.js guides.

Use the task's verified disposable database/app from Step1, prove current identity and correspondence before runtime tests, and retain financial fixtures. If unavailable, continue pure/static implementation and record the gap. Never weaken historical guards or use the owner database as a fallback. Routine technical decisions are delegated; implement rather than repeat the ten-system research or the prior integration.

## Existing foundations

Inspect src/lib/reporting.ts, src/lib/sales-recognition.ts, src/lib/sales-query.ts, src/lib/metric-definitions.ts, report-window/reporting-hours helpers, src/lib/shift-report.ts, Order/OrderItem/OrderRevision/Payment/Shift models and their snapshot producers. Reuse existing Decimal/money and authorization helpers.

Also inspect src/components/app-shell.tsx, src/lib/report-center.ts, src/components/reports/report-center.tsx, src/components/sales/sales-workspace.tsx, reporting-controls.tsx, report-output-actions.tsx, src/lib/report-output.ts, TableSession/MenuCategory/Product and HistoricalSaleLine. Reuse the existing sales amendment/detail/receipt routes and report catalog. In the inspected source, Product has a category but no Brand relation; signed exports currently describe specific displayed snapshots, not necessarily all filtered rows. Recheck these facts against the implementation HEAD.

Preserve existing recognition timing, revisions, refund policy and operational financial definitions. Vendor references inspire presentation, not replacement accounting rules.

Proposed Prisma additions/enums/relations/indexes: NONE for this step. Do not fabricate historical IDs/SKUs or backfill invoices. If future snapshot improvements require schema work, prepare an exact separate proposal and continue the reports using explicit data-coverage states.

All new report routes are authenticated read-only queries. A POST used to prepare an export must remain non-financial. Use existing transaction-aware reads or a bounded consistent read snapshot for multi-query totals; never seed default settings or write business records during report reads. No new financial-command idempotency mechanism is needed for these reads; preserve all existing protected mutation/retry behavior.

## Navigation and invoice workspace

Implement the hierarchy from SALES-REPORTS-REFERENCE.ar.md: Sales contains All Sales, Add Sale, List POS, POS and the existing supported returns view. Reports contains the report center, Sales Reports with Purchase & Sale, Product Sales/SKU, Sales Payments, Registers/Shifts, Sales Staff and Tables, followed by the existing Inventory, Purchasing, Finance, Customers and System report groups. Preserve legacy URLs, permissions, feature gates and existing non-sales catalog entries. Keep incomplete 2D features in the owner's roadmap/preview rather than exposing nonfunctional navigation to ordinary users.

All Sales and List POS are two views over the same Order records; enforce the POS source filter end-to-end on the server rather than changing only the heading. Add Sale and POS enter the existing order workflow. Use one canonical route mapping/catalog with accessible collapsible groups, correct active ancestors and direct-link restoration; avoid parallel hardcoded lists that disagree about role visibility.

Reuse the current invoice workspace for date/invoice/customer/branch/source/payment status/method/actor filters, sorting, safe paging and authorized detail. Keep business status separate from payment status. Open invoice products, quantities, snapshots, discounts, taxes/service, collections/refunds/remaining balance, notes, revisions and authorized activity in a responsive detail panel/page, preserving filters and return focus. Do not expose customer fields outside current permissions. Existing edit/discount/refund actions keep their current approval and settlement flows. A posted financial record has no new hard-delete action; a refund is not proof of physical stock return.

ETA/fiscal integration panels, shareable invoice links, shipping documents or new notifications may appear only when genuinely supported and authorized; do not create fake success states from the reference screenshots. Reprint retains current logging semantics and must not collect funds or consume stock.

## A. Product-sales report

Implement /reports/product-sales and a protected GET /api/reports/product-sales, following repository conventions. Proposed focused files: src/lib/product-sales-report.ts and src/components/reports/product-sales-report.tsx; reuse equivalent existing modules if present.

Validate query inputs with Zod: from/to ISO dates, authorized branch, optional shift/category, search, positive page, bounded pageSize and allowlisted sorting. Reject malformed/reversed dates. Preserve tenant/branch scope on screen, export, print and drill-down.

Before implementation, record a compact metric contract in STEP-2-HANDOFF.md:
- Group by stable productId plus variantId and available historical identity, never name alone.
- Expose SKU and its source: historical snapshot, current catalog value, or unmapped. Preserve leading zeros. Deleted/unlinked historical lines stay visible in an unmapped bucket and reconciliation.
- Rows include sold/returned/net quantity where supported, item sales, discounts, allocated refunds, net item sales and revenue share. Show cost/margin only with trustworthy recorded costs.
- Share = row net item sales / scoped total net item sales ×100. The denominator includes selected date/branch/shift/category filters but excludes textual SKU search, pagination and TopN.
- Net item sales exclude tax and service and follow existing approved discount/refund treatment. Count modifier revenue once under an explicitly stated existing rule.
- Keep service, taxes, rounding and unallocated adjustments separate in a reconciliation bridge to the canonical period total. Do not invent an allocation rule for unlinked refunds.
- For a zero/negative denominator return share=null with an explanation. Do not alter financial amounts to force rounded percentages to100%.

Use existing JSON conventions and exact server arithmetic. Freeze the new response contract before coupling the UI to it; preserve existing endpoint field types.

Build a useful table with search, scope filters, sorting, totals, export/print and invoice drill-down. Preserve the full-scope denominator when showing a subset. Label quantity share separately if offered.

Provide the screenshot's useful views within one report: detailed invoice lines, grouped by business date, grouped by category, and grouped by brand only when genuine metadata exists. Show a clear unavailable/coverage state for absent brand data, not fabricated brands or categories relabeled as brands. A cost/purchase-detail view may use only documented historical cost/source links. Current catalog cost/latest supplier price is not automatically historical COGS; do not invent a source purchase for recipe ingredients or multiply sales by joining every purchase row.

The denominator contract includes every declared scope filter, including an active brand filter if later supported; textual search, paging and TopN remain excluded. Label snapshot-vs-current category/SKU/brand attribution and preserve unmapped historical lines in reconciliation. Do not sum incompatible quantity units under an unlabeled grand quantity.

## B. Sales-by-shift report

Implement /reports/shift-sales and protected GET /api/reports/shift-sales, with drill-down to product sales and invoices. Proposed focused files: src/lib/shift-sales-report.ts and src/components/reports/shift-sales-report.tsx.

Inspect saleShiftId, servedShiftId, payment/settlement shift references and amendment rules before choosing attribution. Define sale, collection, refund and adjustment shift separately where they differ. Never infer a shift merely from a cashier name or time overlap, and never move later adjustments into a closed shift to make totals look consistent.

Show shift ID, branch, cashier, open/close times, status, orders, net sales, tax/service, refunds, collections by method, drawer expenses/returns and final variance when available. Open shifts are provisional. Keep a23:00–07:00 shift intact, using existing Africa/Cairo/business-day helpers.

This is the hierarchy's Register Report, built on the real Shift/custody model. Add a detail view with payment-method summaries, documented cash opening/movement/count/variance bridge, expense sources, products sold with SKU shares and drill-down to invoices/payments. Keep physical drawer cash separate from card/wallet/provider totals. Show configured meaningful payment methods, not twelve empty custom-payment columns. Refunds, supplier payments and expense returns remain distinct cash legs according to existing policy. The report cannot close a shift directly; any existing close affordance enters the normal guarded closing workflow. Never show zero counted cash or final variance for an uncounted open shift.

## C. Sales-payment report

Proposed page/API: /reports/sales-payments and GET /api/reports/sales-payments, adapted to existing conventions. Query actual Payment collection/refund rows and their order, collecting actor and shift references. Show payment reference/ID, paidAt, invoice, authorized customer identity, branch, collecting actor, payment shift, method, direction and exact amount; provide invoice/payment drill-down and gross-collection/refund/net movement summaries.

Filter by actual paidAt/payment shift rather than order creation time. Partial or mixed payments appear as their true payment legs, not repeated invoice totals. A refund is a positive amount with its existing direction/type; do not subtract it twice. Pending/uncertain settlements and non-paid statuses are not completed collections. Keep POS order status, recognized sales and money movement separate, and reconcile against the existing collection ledger.

## D. Purchase & Sale report

Proposed page/API: /reports/purchase-sales and GET /api/reports/purchase-sales. Present canonical recognized sales and confirmed purchases for the authorized period/branch in separate sections with their own event-date labels, plus collections and supplier payments when authorized. Reuse current purchasing/reporting sources rather than making new valuation rules.

Purchase totals are not COGS, supplier settlement is not a second expense, and sales minus purchases is not profit. Preserve the accountant/D7/D8 and Step4 P&L gates. Require both sales and purchase-cost authority for combined figures; a user lacking purchase authority must not receive hidden cost data in JSON/export. Link to scoped invoices and source reports. Missing data remains unavailable rather than zero.

## E. Sales-staff report

Proposed page/API: /reports/sales-staff and GET /api/reports/sales-staff. The vendor label is truncated as Sales Representative…; the owner has not requested commissions or a new sales-representative entity. Use verified existing actor references and allow an explicit role basis: order creator, collector or served-by actor. State the corresponding event-date basis and measure in the heading/export.

Aggregate by stable user ID within cafe/branch, not display name. Do not attribute collections to the order creator when another actor collected them. Preserve unknown/deleted historical actors as an unattributed bucket and reconcile it. No invented waiter/commission fields or historical backfill. Do not add role-based subtotals together as though the same order were multiple sales.

## F. Table report

Proposed page/API: /reports/tables and GET /api/reports/tables. Reuse TableSession, Order, Payment and existing table metric definitions. Display cafe/branch/table number/session ID, started/closed times and duration, status, linked order count, recognized sales, collections/refunds and remaining balance with explicit event/current-state bases.

Two visits to the same table remain two sessions. Separate sessions opened/closed during a period from current outstanding balances; never sum “now” balances across days. Aggregate independent order/payment relations before joining to avoid Cartesian multiplication, and count each payment once even where its order and table references both match. Link to the existing session/invoice details without taking payments or mutating table occupancy from a report read.

## Shared query, responsive UI and output contract

Extend common Zod query validation with allowlisted view/grouping/sort/source/actor-basis/method fields as needed. Preserve compatible existing endpoint fields and types. Every filter shown must affect the corresponding server query; reject invalid scope and malformed/unsupported values. Page size is bounded, ordering deterministic, date windows use existing Cairo/business-day helpers, and each report publishes its metric/coverage contract before UI coupling. Protect list, totals, drill-down, exports and direct URLs using current effective server permissions and tenant/branch scoping; client-side hiding alone is insufficient.

Use a common report header, concise purpose, generated-at/coverage metadata, relevant summary cards, shared period/branch filter bar, applied-filter chips/reset, report-specific tabs, search and user-scoped column preferences. Keep filters/grouping/sort/page in the URL and restore them after detail navigation. Support labels/focus/keyboard, scoped pending/error/empty states, bounded cancellable reads and stale-response protection. Do not alter or abort existing financial mutation recovery to implement report timeouts.

At desktop widths show a readable analytical table; at 360/390px show essential fields in cards or expandable rows and keep any detailed horizontal scroll inside its table region. Do not render a desktop page at tiny zoom. Details must fit the viewport with a clear close/back action; test RTL, long Arabic/SKU text, drawer focus and browser zoom. Preserve Step1B typography, tokens and theme.

Reuse and extend the output pipeline. Clearly distinguish “export displayed page” from “all filtered results”; the latter cannot silently contain only the current 30 rows. Preserve exact scope, grouping, sort, metric versions, generated-at/coverage metadata and cost-field permissions. Bound full exports, generate consistent snapshots and report limits visibly; do not ship huge signed row payloads or claim a new read at another time is the same old snapshot. Verify current export authority and scope on reuse, including after a user's role/branch changes, rather than trusting only a previously signed actor ID.

CSV/Excel preserve SKU leading zeros, exact amounts and safe formula/text handling. Print A4 with readable Arabic repeated headers and summaries; if PDF uses the browser dialog, label “طباعة / حفظ PDF” instead of pretending there is a direct PDF generator. Thermal output needs a separate concise layout plus real printer-width evidence before a hardware claim. Report/receipt printing must not mutate money or stock.

Keep HistoricalSaleLine reports explicitly separate from operational Order/Payment reports. Do not combine historical source exports into live branch/shift totals without trustworthy identity and an approved contract. Addition8 is planned as shared LAN continuity; until implemented, do not fabricate local/offline totals. Later integrate separate cloud/local coverage and synchronization checkpoints without double counting.

## Planned slice 2D — prepare scope, do not implement writes here

The owner's Sales menu also includes drafts, quotations, shipments, promotions and Import Sales. Record them as planned capabilities, not completed features. Draft/quotation conversion must later be exactly-once and must not post cash/stock before the existing order lifecycle. Campaigns must not be substituted by changing current user discount limits. Shipping requires its own supported workflow, not a decorative action.

Sales import requires template → authorized scope and invoice grouping → SKU/variant mapping → validated preview/errors/duplicates/totals → explicit commit → import history. Historical evidence intake and creation of live operational orders are distinct modes. The current HistoricalSaleLine sourceHash/sourceRow uniqueness does not alone deduplicate the same invoice across different exports. A future import design must define invoice/line identity, Decimal/date/time/unit mapping, preview fingerprint, conflict handling and transactional batch idempotency before any commit route. No owner imports, hidden financial backfill, fake historical branch/shift links, second collection or inventory deduction from a file upload. Exact Prisma proposals for those future entities are outside this no-schema 2A–2C prompt and must be prepared separately.

## Required verification

- Two different products with the same name remain separate; renaming one product does not split its stable identity.
- SKU0012 remains distinct from12.
- 4000 out of10000 gives40%, including when only that SKU is searched or one page is returned.
- Empty/zero/negative periods, partial refunds, discounts, served-order amendments, archived/deleted products and unsupported historical identity have explicit expected results.
- Product totals plus the reconciliation bridge match the approved canonical aggregate without double counting.
- A cross-midnight shift stays one shift; a sale in one shift and collection/refund in another do not duplicate sales.
- Date/branch/shift filters, screen/export/print and restricted-role access agree.
- All six reports are reachable through the requested hierarchy; current non-sales report entries and direct URLs remain usable. All Sales vs POS source filtering is real; unavailable 2D features are not fake active links.
- Payment and invoice totals reconcile for split/partial collections and refunds; one payment has one money effect, even after joins or drill-down.
- An order created by A, collected by B and served by C is attributed correctly under each selected staff basis; unknown actors are retained.
- Two sessions of the same table and multiple orders/payments in each do not merge or multiply amounts. Current-state table balances remain distinct from period events.
- Purchase/sale comparison never labels sales minus purchases as profit; missing historic costs/brands have honest coverage states and do not become zero margin/cost or fake metadata.
- At least 61 matching rows demonstrate correct pagination and explicit page-vs-full exports; SKU leading zeros and Arabic/formula-like cells survive safely. Screen/CSV/Excel/print match their declared scope, and changed permissions invalidate out-of-scope output.
- Production-mode browser acceptance at 360/390px and desktop covers every report and invoice/shift drill-down, direct-link navigation/back, filter persistence, slow/error/empty/stale reads and no page-wide overflow. Show real screenshots from the same verified preview, not recreated mock data claiming runtime success.

Use meaningful pure fixtures for arithmetic and guarded disposable runtime cases for relational attribution and authorization. Run focused checks first; broaden only for shared changes. No mutating owner-data tests.

Finish STEP-2-HANDOFF.md with the screenshot-to-feature checklist, route/navigation map, per-report contracts and attribution, export coverage, tests, mobile/desktop evidence, remaining 2D gaps, files/commits and actual preview URL. Clearly distinguish functioning reports from incomplete historical data, technical verification from owner acceptance, and planned sales features from implemented ones. Stop before 2D or Step3; no push/merge/deploy.

Final status: COMPLETE / PARTIALLY COMPLETE / BLOCKED / NEEDS OWNER DECISION.
