# NEXT CUP update prompts - five steps and optional additions

Use one prompt at a time, in order, in the same Codex chat and isolated feature worktree. Select each prompt's recommended model and thinking level in the UI before pasting. Each prompt is independently copyable. This pack is preparation only; no implementation or owner-data operation was performed when creating it.


Current roadmap status (2026-11-03): Step1/1B implementation is done; Step2A-2C source is reported implemented with runtime/owner acceptance pending; core Steps3-5 remain. Optional additions6-9 are planned. Step1B remains in its standalone correction prompt. Step2 now follows the owner's Sales/Reports screenshots: navigation/invoices and six reports in2A-2C, with sales-workflow writes planned separately in2D. This pack is an index of independent instructions: do not rerun completed steps or execute multiple steps automatically. Addition7 keeps the confirmed browser-open computer backup schedule. Addition8 now uses the owner-confirmed shared-LAN cashier+kitchen+QR topology; invoke architecture slice8A first, not the superseded independent-browser proposal. Addition9 provides optional direct/recipe-cost multipliers with editable final prices, explicit reference-cost branch, protected manual overrides and selected publication; cost/recipe changes do not publish prices automatically. Step2 now recommends GPT-6.1 Sol with Medium implementation effort and focused High review only when needed, following the owner's usage preference.

For the reported implemented Step2 source, use [the runtime closeout continuation](02c-runtime-acceptance.md); do not rebuild it or treat the unavailable preview as accepted.

<!-- Standalone source: 01-unified-ui-and-tables.md -->

# Step 1/5 — Unified identity and café-table management

Recommended Codex model: GPT-6.1 Sol. Thinking: High.
Roadmap: preserve baseline → consolidate shared UI → update workspaces → harden table management → verify and hand off.

Implement STEP 1 ONLY of the accepted NEXT CUP update roadmap. This message authorizes this step's local source changes, focused tests, an isolated feature branch/worktree and explicit local commits. Routine implementation choices are delegated. Execute the bounded work; do not stop after another broad audit or design discussion.

Read C:/Dev/cafe-operations-system-3/docs/research/2026-11-02-erp-experience/PLAN.ar.md, AGENTS.md and the latest owner-live/integration report. Preserve historical authorization records. This new step authorization supersedes older batch-specific local-code restrictions only for the work described here; financial-policy and owner-data restrictions remain.

## Shared operating rules for all five steps

- Original checkout: C:/Dev/cafe-operations-system-3. Real ERP: port3110; original database: port5433. Verify current state; these are recorded identities, not proof of today's process ownership.
- Keep the real ERP running. No tests, fixtures, recipe imports, seeds, resets, schema changes or financial posting against5433. Do not edit .env or control PostgreSQL. Previous one-time database approvals are not permission for new operations.
- Use one isolated worktree and a codex/ feature branch for all five steps. Detect an existing task worktree before creating one. Preserve all owner work, including existing AGENTS.md and historical migration differences. Verify the current HEAD/upstream; do not repeat the previous integration or assume a push grants permission to overwrite changes.
- Reuse installed dependencies. No installs, package upgrades, pushes, main merges or deployment. Use installed local executables rather than download-capable commands.
- Read relevant installed Next.js documentation before changing Next.js code. Keep Decimal arithmetic, tenant/branch boundaries, permissions, immutable history and existing API contracts.
- A preview may use3113 if free. Start/stop only positively identified task-owned app processes. Never select a process for termination by port.
- Runtime checks require an explicitly targeted, positively verified dedicated disposable database and actual server/database correspondence. A port number alone is insufficient. Reuse this task's verified database across steps and retain financial evidence. If none is available, prepare the exact setup request, continue independent pure/static work and report the runtime gap.
- Preserve historical test guards. A task-specific adapter may bind new reviewed source and a verified disposable target; do not weaken old source pins or repurpose retained finance databases by assumption.
- Run meaningful targeted checks. Do not unit-test literal colors/classes or repeatedly rerun expensive unchanged checks. Use stronger verification for transactions, money, authorization, import integrity and concurrency.
- Keep a short handoff in artifacts/erp-experience-20261102/STEP-N-HANDOFF.md within the task checkout: HEAD/branch/worktree, files/contracts, commands and results, preview/process ownership, database identity without credentials, limitations and next-step instructions.

## Deliverable A — one shared visual identity

Use NEXT CUP's current green identity and cashier interface as the reference. Unify semantic colors, Arabic typography, spacing, radii, icons, buttons, forms, tabs, tables, filters and loading/empty/error states across Sales, Finance, Reports, Recipes and Tables.

Keep the cashier optimized for touch and fast order entry. Management reports may have denser layouts while using the same component language. Preserve Arabic RTL and readable LTR numeric/identifier fields.

Inspect before changing:
- src/components/app-shell.tsx
- src/app/globals.css and existing theme/UI primitives
- src/components/pos/
- src/components/sales/sales-workspace.tsx
- src/components/sales/reporting-controls.tsx
- src/components/treasury/treasury-workspace.tsx
- src/components/treasury/treasury-details.tsx
- src/components/expenses/expense-workspace.tsx
- src/app/(app)/reports/page.tsx
- src/app/(app)/accounting/
- src/app/(app)/recipe-review/page.tsx
- src/components/recipe-import/recipe-exchange.tsx

Improve the existing components; do not create a second shell/design system. Finance should present concise summaries and searchable lists, with forms in accessible dialogs/drawers or dedicated pages rather than stacked permanently below lists. Preserve entered values on failure, focus management, keyboard access and pending/duplicate-submission behavior.

Keep truthful UNKNOWN, LIMITED and SHADOW finance states visible in understandable language. Do not turn unknown balances into zero, remove coverage restrictions or enable accounting initialization from a page render.

## Deliverable B — visible and safe dining-table management

Inspect and reuse:
- src/app/(app)/tables/page.tsx
- src/app/(app)/tables/setup/page.tsx
- src/app/api/tables/config/route.ts
- src/app/api/tables/config/[id]/route.ts
- src/app/api/tables/config/bulk/route.ts
- TableSession creation and table-selection paths, plus existing transaction locks.

Make management easy to discover. Support existing single/bulk creation, editing, areas, seats, sorting, activation, archive and restore. Display vacant/occupied/inactive/archived states in grid and list modes.

Removal means archiving from active use while preserving historical sessions and invoices. Reject renumbering, deactivation and archiving during an OPEN session. Enforce this on the server under a transaction/locking strategy shared with competing session creation; a client-side disabled button or unlocked precheck is insufficient.

Preserve branch-level table-number uniqueness and existing Zod limits. Keep tables.manage/create/edit/archive/bulk_create and narrower POS view permissions. Put business changes and their audits in the same appropriate protected transaction. Preserve lock ordering and handle duplicate numbers/concurrent changes with clear responses.

Proposed Prisma additions/enums/relations/indexes: NONE. Reuse CafeTable and TableSession exactly as defined. Do not add a parallel table model or hard-delete historical records.

## Acceptance and handoff

Verify shared appearance at representative desktop/tablet/mobile widths, RTL overflow, input labels, keyboard/focus behavior and that normal POS entry still works. Meaningful table tests must cover duplicate number refusal, cross-tenant/branch denial, occupied-table refusal, concurrent session-versus-archive/rename, archive/restore and audit rollback. Run mutation tests only on the verified disposable target.

Do not implement the new SKU/shift reports, new recipe-import behavior or expense/P&L policy in this step. Preserve useful links for later steps without fake working controls.

Finish STEP-1-HANDOFF.md, list modified files, actual checks and a verified disposable preview URL with any login instructions. Distinguish static success from browser/runtime gaps. Stop after this step; do not start Step2 automatically.

Final status: COMPLETE / PARTIALLY COMPLETE / BLOCKED / NEEDS OWNER DECISION.

---

<!-- Standalone source: 02-sku-and-shift-reports.md -->

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

---

<!-- Standalone source: 03-recipe-bulk-exchange.md -->

# Step 3/5 — Bulk recipe export, external editing and safe import

Recommended Codex model: GPT-6.1 Sol. Thinking: High.
Roadmap: inspect current exchange → simplify workbook and entry points → strengthen preview/conflicts → verify round trip → hand off.

Implement STEP 3 ONLY. Continue the isolated feature worktree/branch and shared UI from Steps1–2. Read C:/Dev/cafe-operations-system-3/docs/research/2026-11-02-erp-experience/PLAN.ar.md and both prior STEP-N-HANDOFF.md files. This message authorizes scoped local changes, focused tests and explicit local commits; routine choices are delegated.

## Boundaries

Keep the real ERP on3110 and original database5433 running and unchanged. No real recipe import, stock write, historical repricing, .env edit, PostgreSQL control, package install/upgrade, schema migration, push, main merge or deployment. Use only the task's positively verified disposable target and owned preview server; prove server/database correspondence and preserve retained evidence. If unavailable, finish independent pure/static work and report runtime limits. Read relevant installed Next.js guides.

Do not rebuild the existing exchange or repeat prior integration/research. Inspect:
- src/app/(app)/recipe-review/page.tsx
- src/components/recipe-import/recipe-exchange.tsx
- src/lib/recipe-file.ts
- src/lib/recipe-import.ts
- src/lib/recipes.ts and recipe-access.ts
- src/app/api/recipe-import/route.ts
- src/app/api/recipe-import/preview/route.ts
- src/app/api/recipe-import/export/route.ts
- Existing recipe review/verification routes and Recipe/RecipeItem models.

Existing behavior includes XLSX/CSV decoding, XLSX export/template/reference sheets, a1000-row limit, replace/new-only modes, signed preview tokens and transaction/concurrency guards. Preserve and improve it.

Proposed Prisma additions/enums/relations/indexes: NONE by default. Reuse Product/ProductVariant/AddOn/InventoryItem/Recipe/RecipeItem and current audits. If a durable new operation-receipt contract truly needs schema work, prepare its exact separate proposal without applying it; do not silently weaken retry or conflict protection.

## Required workflow

Select products or export all → edit externally → upload → see errors and before/after changes → explicitly confirm → see result and changed recipes requiring review.

1. Make entry points easy to find from recipe review and relevant product/recipe screens, using Step1 components and existing recipe permissions.
2. Support selected-scope and full export. One row represents one ingredient of a product-default, variant or add-on recipe. Preserve explicit scope and variant inheritance.
3. Make SKU visible in product reference sheets and preserve it as text, including leading zeros. Keep stable IDs and version/fingerprint metadata understandable and protected where useful; names are helper labels, not ambiguous matching keys.
4. Include reference sheets for products/variants, ingredients/branches, add-ons, valid units and concise Arabic instructions. Simplify editable columns without breaking current templates; version any changed file contract and define backward compatibility.
5. Keep explicit replace-included-recipes versus new-only choices. Replacement affects only recipe groups included in the approved file; never delete other recipes because their rows were omitted.
6. Show per-recipe before/after and totals for create, change, unchanged, skip and error. Include row numbers and actionable error text; provide an error export if useful. Any invalid file must not silently partially apply.
7. Preserve the preview-token protection between preview and commit. Assess and close stale-export overwrites using the smallest compatible baseline/version strategy; changing a recipe after export must not be overwritten without a meaningful conflict/confirmation flow.
8. Preserve existing finite numeric validation, quantity precision, waste precision and unit compatibility. No weight/volume conversion without item-specific density, and no guessed package conversions. Reuse existing conversion utilities.
9. Keep1000 rows as the current explicit limit unless a justified, tested bounded change is needed. Reject oversized input clearly. If larger work is split into batches, show partial completion and receipts per batch; do not claim whole-file atomicity across separate transactions.
10. Handle double submission and a lost success response without duplicate recipes or misleading success. Reuse transactional/audit/idempotency facilities where suitable and record actual limitations honestly.

Changing recipes must not change sale prices, stock balances, prior stock consumption or historical financial snapshots. Unchanged recipes retain their existing verification status; changed/new recipes follow the approved review and verification flow. Do not auto-verify imported ingredients or quantities.

Planned addition9 offers optional cost-based price suggestions with editable final prices. Recipe import may later invalidate/refresh those suggestions, but cannot publish prices or replace manual overrides. Its independent preview/selected-publication workflow is outside this Step3 prompt; see 09-optional-cost-based-pricing.md.

## Contracts and transaction requirements

Retain Zod validation on the server, including tenant/branch ownership and active catalog identity. Document any optional workbook metadata or request/response extension before implementation. Revalidate file content and preview state inside the appropriate existing transaction; all business mutations and required audits must succeed or roll back together.

Bound file bytes, rows, columns and field lengths appropriately. Treat formulas, macros and external links as untrusted data; never execute them. Ensure exported identifiers/text cannot become executable spreadsheet formulas.

## Acceptance

Use a real export→edit→preview→import→export round trip on synthetic disposable fixtures. Verify Arabic, SKU0012, variants/default inheritance, add-ons, matching ingredient names in different branches, conflicting identifiers, invalid units/precision, duplicate rows/headers, empty/oversized files and stale export/preview state.

Changing one recipe must preserve all unrelated recipes. Invalid input or injected audit failure must leave no partial recipe effects. Check result/retry behavior, permission denial and unchanged prices/stock/history. Perform browser checks of the actual file-selection and preview controls, not only parser tests.

Finish STEP-3-HANDOFF.md with the workbook/request contract, sample synthetic workflow, tests, source changes, limitations and actual preview URL. Stop before Step4.

Final status: COMPLETE / PARTIALLY COMPLETE / BLOCKED / NEEDS OWNER DECISION.

---

<!-- Standalone source: 04-operating-expenses-and-profit-loss.md -->

# Step 4/5 — Operating-expense categories and trustworthy P&L

Recommended Codex model: GPT-6 Astra. Thinking: High.
Roadmap: category UX → coverage/mapping assessment → read-only P&L presentation → guarded verification → concrete financial approval packet.

Implement STEP 4 ONLY on the same isolated worktree/branch. Read PLAN.ar.md and STEP-1/2/3-HANDOFF.md. This message authorizes scoped local implementation, focused tests, read-only reporting, a draft accounting design and explicit local commits. It does not authorize adopting new financial policy, enabling previously blocked postings or applying owner-database/schema changes.

## Protect the running system

Original checkout: C:/Dev/cafe-operations-system-3. Real app3110/database5433 must remain running and unchanged. Preserve .env, owner work, historical migrations, permissions, money precision and posting gates. No PostgreSQL control, package install, real-data seed/import, opening-balance adoption, retrospective posting, push, main merge or deployment. Read relevant installed Next.js guides. Runtime verification uses only the task's positively verified disposable database/app with identity/correspondence proof and retained evidence.

Finish all independent authorized work before asking for a financial decision. Existing explicit approvals remain valid for their exact scope; never ask again for a decision already recorded. The past approval for two startup migrations does not authorize this new policy or schema work.

## Current foundations to inspect

- src/components/expenses/expense-workspace.tsx
- src/lib/expense-rules.ts, expenses.ts, expense-api.ts and expense-authorization.ts
- src/app/api/expenses/ and categories/ routes
- ExpenseCategory, OperatingExpense and OperatingExpenseReturn
- src/lib/accounting/chart.ts, ledger.ts, queries.ts, statements.ts and shadow-projection.ts
- AccountingEntity, AccountingAccount, JournalEntry, JournalLine and existing policy/opening records
- Treasury coverage and current P&L/accounting configuration states.

categoryId is already required, expense category labels are snapshotted, and the existing path represents drawer-funded operating expenses. Shadow projection currently holds OPERATING_EXPENSE and OPERATING_EXPENSE_RETURN for unapproved posting alignment. Do not remove that safeguard as a UI fix.

## Part4A — operating-expense categories and entry

Rename the user-facing workspace to “مصروفات التشغيل”. Reuse the existing category model and routes.

- An authorized expense recorder must select an active category from a searchable list. No free-text substitute or silently created “Other”.
- Authorized category administrators can create, rename and archive categories. Preserve existing permission boundaries; “anyone entering an expense” does not mean everyone gains that permission.
- Preserve category snapshots and referenced history. Archive rather than delete used categories.
- Keep amount, description, reference, branch, funding/custody and return controls consistent with current contracts. Do not relabel a bank-funded/rent/accrual event as a drawer expense to fit the form.
- Suggested category drafts for review: RENT, ELECTRICITY, WATER, INTERNET, MAINTENANCE, CLEANING, MARKETING, SERVICE_FEES and OTHER. Do not seed real data. Require a clear description; accountant-approved grouping controls wages/taxes/fees.
- Empty categories should produce a useful setup action for authorized users and a clear explanation for others.
- Preserve numeric JSON, exact two-decimal money, transactional audits, retry keys, original-shift custody restrictions and refund limits.

Proposed Prisma changes for4A: NONE. Keep the existing categoryInput/expenseInput Zod contracts unless a reviewed UI-compatible correction is necessary; validate all fields server-side.

## Part4B — P&L presentation and policy packet

Reuse the existing ledger and incomeStatement calculation. Create or improve a canonical read-only P&L page under the accounting/reporting route conventions; link it from Finance and Reports. Do not create another financial ledger or duplicate calculations in the client.

Present approved net sales, recognized cost of sales, gross profit, approved operating expenses and other approved groups, with drill-down and source coverage. Preserve SHADOW/unconfigured labels and branch restrictions. Missing cost or unposted expenses must not produce a misleading complete profit number.

Keep distinct:
- A ledger-based financial statement.
- An explicitly labelled management preview of available operational sources, if useful.

Do not mix both into one undisclosed total. If coverage is incomplete, expose missing/unmapped items and withhold a complete net-profit claim. Preserve the existing expense-posting gate unless an exact approved policy is already present.

Prepare a concrete FINANCE-DECISIONS.md containing:
1. Category→existing AccountingAccount mapping with actual verified IDs/codes and unmapped categories.
2. Recognition date, source/funding coverage, refund treatment and effective/cutover date.
3. Treatment of historical items and explicit prohibition of silent retrospective reclassification.
4. Proposed schema changes, if necessary: exact reference Prisma models/enums/fields, relations, tenant integrity, uniqueness and indexes, labelled PROPOSED/NOT APPLIED, plus migration/backfill risks.
5. Pure posting examples and tests showing balanced debit/credit effects and exactly-once expense/return handling.
6. The precise remaining owner/accountant decisions and a bounded enablement/rollback plan.

Purchase of inventory, supplier settlement, internal transfers, tax liabilities and owner movements must not be counted again as operating expenses on top of recognized cost of sales. Do not change the chart, valuation, opening balances, D7/D8 or accountant-review disposition by assumption.

Implement/test safe pure helpers and disabled/read-only presentation where useful. Do not wire unapproved posting logic into production paths. Continue4A and other independent work if4B awaits a real decision.

## Acceptance and truthful status

Verify missing/inactive/foreign categories, archive/rename snapshots, permissions, duplicate submission, drawer/custody restrictions, expense return limits and transactional audit failure on disposable data. Reconcile allowed P&L outputs to existing source totals and test missing-cost/unconfigured/unmapped scenarios, including screen/export consistency.

Record4A implementation status and4B policy/enablement status separately in STEP-4-HANDOFF.md. A working screen does not close the financial gate. Provide the actual preview, files/checks, and a short actionable approval packet only after completing the concrete preparatory work.

Step5 may proceed with independent integration verification while unresolved financial policy remains explicitly gated. Stop after this step.

Final status: COMPLETE / PARTIALLY COMPLETE / BLOCKED / NEEDS OWNER DECISION, with4A/4B sub-statuses.

---

<!-- Standalone source: 05-verify-and-integrate.md -->

# Step 5/5 — Final verification and reviewable original-checkout integration

Recommended Codex model: GPT-6.1 Sol. Thinking: High.
Roadmap: inspect four handoffs → resolve remaining defects → verify integrated flows/build → prepare safe source integration → deliver preview and owner-switch packet.

Complete STEP 5 of the NEXT CUP update roadmap. Read PLAN.ar.md and STEP-1 through STEP-4-HANDOFF.md in the same task worktree. Continue from the actual implemented source, preserving every completed step. Do not rebuild modules, repeat the earlier ERP integration or redo unchanged vendor research.

This message authorizes final local fixes, focused verification, explicit local commits, and a concrete reviewed source-integration candidate for the original checkout. If safe, integrate the reviewed source on a new local codex/ feature branch in the original checkout, preserving all owner work; never move/merge main or overwrite another writer's changes. If the original checkout has conflicting live work, prepare the exact patch/commit manifest and resolve only authorized conflicts instead of forcing a checkout or reset.

It does NOT authorize interrupting the owner app, switching its database, applying migrations, changing financial policy/opening balances, editing .env, PostgreSQL control, package installation, pushes or deployment. The owner ERP on3110/database5433 stays running until a separately authorized concrete switch. Preserve its currently served build output; use a separate build directory for the candidate.

## 1. Establish the final candidate

Verify branch, HEAD, staged/unstaged changes, original-checkout state and active writers. Preserve pre-existing AGENTS.md/history/migration differences. Inventory only the files relevant to these five steps.

Check that there is one shared UI system, one canonical source for each metric, no parallel ledger, no duplicate table/recipe module and no accidental permission broadening.

Read relevant installed Next.js docs for any remaining code/build changes. Reuse installed dependencies and the verified task-specific disposable database. Prove its identity and real HTTP correspondence before runtime checks. Do not disable original guards, purge retained financial fixtures or fall back to5433.

## 2. Review the complete user journeys

On the final candidate, verify:
- Cashier, Sales, Finance, Reports, Recipes and Tables share the identity while preserving appropriate task layouts.
- Original POS order/payment/receipt flow still works on synthetic fixtures.
- Tables: create/edit, duplicate number refusal, occupied-table protection, race behavior, archive/restore and historical preservation.
- SKU report: stable identities,40% example, correct denominator despite search/pagination, refunds/revisions, unmapped history and reconciliation bridge.
- Shift report: cross-midnight identity, sale-versus-collection/refund attribution, drill-down and provisional/open-shift states.
- Updated Step2 screenshot-derived scope: Sales/Reports hierarchy, All Sales vs POS source filtering, invoice details, and all six sales reports. Verify payment-leg attribution, staff role basis, distinct table sessions, purchase-vs-sale meaning, missing brand/cost coverage, mobile drill-down and explicit page/full-filtered exports. Use SALES-REPORTS-REFERENCE.ar.md and the actual Step2 handoff; no duplicate money/stock effects from joins or report actions.
- Recipe export/edit/preview/import/export: Arabic, leading-zero SKU, variants/add-ons, row errors, stale state, retry result and no unrelated stock/price/history change.
- Expense category selection/administration and snapshot preservation.
- P&L data coverage and existing posting gates. If Step4B remains unapproved, prove its disabled/unconfigured behavior and report it as an unresolved gate, not a passed financial feature.
- Owner/manager/cashier or other relevant restricted roles; API authorization as well as navigation visibility.
- Report screen/export/print agreement and active-session checks.
- Keyboard, focus, visible labels, RTL, numeric fields, loading/error/empty states and representative desktop/tablet/mobile widths.

Fix demonstrated defects narrowly, with meaningful regressions for behavior changes. Do not add speculative features or rewrite working code during closeout.

Keep planned sales-workflow slice2D and optional additions6–9 separate from the five-step completion claim. Addition8 has the owner's confirmed shared-LAN topology (cashier+kitchen+QR). Addition9 provides editable cost-based menu-pricing suggestions and requires its own selected publication/verification; recipe import or core verification must not silently reprice the menu. Do not implement/deploy those later additions or label them verified merely from the core Step5 run.

## 3. Verification scope

Run a fresh final relevant combined test set once after actual changes settle, plus strict typecheck, targeted lint and the production build. Use explicit process-local disposable settings for commands that load the application/Prisma. Keep typechecking enabled and application/tests within scope.

Preserve archived artifacts without allowing old source copies to contaminate the current build; reuse the reviewed bounded configuration and a distinct output directory. Do not overwrite the active owner build. Use local executables and existing font/assets rather than installing/downloading replacements.

Do not replay all baseline migrations or rerun unrelated historical suites when the schema and relevant inputs have not changed. A failure, new source change or unresolved shared concern can justify additional verification. Record actual commands, exit codes, distinct counts and skips; do not count repeated tests as additional coverage.

Schema changes are not expected for these bounded steps. If any were separately approved in the session, verify their exact authorized scope on disposable data; do not infer owner application permission.

## 4. Prepare integration and a concrete switch packet

Prepare a per-file/commit manifest from the task branch to the current original source. Preserve original owner changes with a reviewed comparison; no blanket overlay, reset, clean or broad staging.

For any local original-checkout integration, use a new codex/ feature branch, preserve the currently served build and confirm the integrated source matches the reviewed candidate. Do not push or merge main. A prepared candidate is distinct from activating it for real users.

Prepare ORIGINAL-SWITCH-PACKET.md with:
- Candidate commit/source/build identifiers and exact changed files.
- Existing owner app/process identity, new candidate preview identity and exact URLs; do not confuse disposable data with original data.
- Exact startup command and required environment-variable names without secrets.
- Schema compatibility assessment and any separately approved pending change; do not claim compatibility solely from source files.
- Unsaved-session/draft handling, the exact owned process proposed for replacement, and a small maintenance window if needed.
- Backup/recovery requirements appropriate to the actual change. No extraction, stop/start, migration or restore without its existing explicit authorization.
- Rollback to the preserved previous source/build and the limits of any data rollback.

If approval for the exact owner switch is already recorded in the session, follow it without asking again. Otherwise finish the complete reviewable candidate and request only that final operational approval. Never fabricate receipts or edit old source pins to bypass a launcher. Preserve old evidence and create genuine release-specific proofs for the new candidate.

## 5. Final deliverables

Write STEP-5-HANDOFF.md and one concise final report containing:
1. Working, correctly labelled preview URL and demonstration steps.
2. Per-step implemented/verified/pending status, especially Step4A versus4B.
3. Files and local commits, original-checkout integration state and preserved owner changes.
4. Actual verification results and material limitations.
5. The exact owner-switch packet and remaining owner actions, if any.

Do not claim the updated original ERP is live until it has actually been started against the correct original database and verified within authorized scope. Do not call financial policy, human UAT, devices or production readiness approved by inference.

Final status: COMPLETE / PARTIALLY COMPLETE / BLOCKED / NEEDS OWNER DECISION. State separately whether original activation, owner-database changes, push/main merge and deployment occurred.

---

<!-- Standalone source: 06-self-service-qr-ready-alerts.md -->

# Additional Step 6 — Optional self-service QR ready alerts

Recommended Codex model: GPT-6 Astra. Thinking: High.
Roadmap: inspect QR/settings/status flow → add secure tracking and acknowledgement → foreground sound → consented background push/outbox → verify supported devices and hand off.

Implement the optional NEXT CUP self-service pickup feature described below. The owner explicitly requested BOTH an alert inside the customer's tracking page and background notifications where the device supports them. This is an addition to the five-step update roadmap; preserve their implemented work and handoffs.

This message authorizes isolated local implementation, focused tests, schema/migration preparation and application of this feature's reviewed migration only to a positively verified task-owned disposable database. It does not authorize applying migrations or enabling the feature on the owner's real database, controlling PostgreSQL, changing financial policies, interrupting the real ERP, push/main merge or deployment.

## Current system and boundaries

Original checkout: C:/Dev/cafe-operations-system-3. Recorded live owner ERP3110/database5433 must remain protected. Continue the same isolated feature worktree where appropriate, read AGENTS.md, PLAN.ar.md and the latest step handoffs, and preserve unrelated owner work. Do not repeat the completed ERP integration or change .env.

Read relevant installed Next.js docs. Reuse the current architecture and installed dependencies. There is no currently identified Web Push/service-worker/outbox implementation to reuse; verify that before adding one. If a sender library is necessary, this step narrowly permits adding one maintained Web Push package and required TypeScript types/lockfile changes in the isolated worktree, after verifying its current official API/version and compatibility. Do not install into a dependency directory shared with the running owner app, hand-roll Web Push encryption, or upgrade unrelated packages. Document the exact dependency diff.

Use process-local test credentials. Never commit/log VAPID private keys, guest tokens or full push endpoints. Document environment-variable names only; owner environment configuration remains a separate operational action.

Inspect:
- src/components/customer-menu/customer-menu-page.tsx and types.ts
- src/app/api/qr/[branchId]/orders/route.ts
- src/app/api/orders/[id]/status/route.ts and all other READY transition producers
- src/lib/qr-approval.ts, cafe-settings.ts, idempotency.ts and protected transactions/audits
- Existing settings API/UI and public-menu data projection
- Order, CafeSettings and existing relations in prisma/schema.prisma.

Proposed focused new files, subject to the repository conventions verified above: src/app/pickup/[ticketId]/page.tsx, src/components/customer-menu/pickup-tracker.tsx, src/lib/qr-pickup.ts, src/lib/qr-pickup-push.ts, public/qr-pickup-sw.js, a pickup-scoped manifest/landing page and scripts/qr-pickup-dispatcher.ts. Reuse equivalents if present. Keep the worker scope as narrow as the supported pickup/PWA flow allows, and keep all staff/accounting fetches outside caching.

Verified facts: public QR orders use source=QR_MENU; legal status transitions and staff authorization already exist; Order.readyAt is available; Order has the composite unique [id,cafeId,branchId]. The current QR success screen does not implement secure live tracking. Order numbers and phone numbers are not authentication.

## Product behavior

1. Add an owner-authorized operating setting “الاستلام الذاتي — Help Yourself”, default OFF. Prefer the existing workflow-switch/settings framework rather than a new workflow engine. Public clients see only the needed effective boolean/instructions, not private settings.
2. Eligibility is derived server-side from this setting and source=QR_MENU at order placement. Do not force DINE_IN into TAKEAWAY or alter payment, waiter approval, routing, kitchen, table-session, loyalty or inventory rules.
3. Eligible customers receive a private tracking page with order number, safe status and pickup instructions. Show a direct button “تفعيل تنبيه جاهزية طلبي”. Ordering remains possible without audio/push permission. Do not introduce a mandatory phone number; retain any separately configured existing loyalty requirement.
4. After a genuine committed READY transition, an opted-in open page repeats a short chime, proposed cadence every10 seconds, while that readiness notice is active and unacknowledged. Display a prominent “طلبك جاهز للاستلام” card and “هستلم الطلب” button.
5. Acknowledgement persists server-side and stops that notice on other tabs/devices. It is NOT physical handover, payment or SERVED. Actual delivery remains the existing authorized staff action with all payment/custody/stock guards.
6. Provide an accessible mute control. Muting/closing a notification is not acknowledgement. Unsupported sound or refused permission must leave a useful visual tracking flow.
7. Default changes apply to new eligibility/tickets. Turning the feature OFF stops further alerts/jobs immediately without deleting orders, acknowledgements or audit history. Existing normal QR behavior remains unchanged when disabled.

## Browser capability contract — do not promise impossible ringing

- Audio must be unlocked by a customer gesture. Handle rejected play()/AudioContext activation and show an actionable fallback; do not attempt to bypass autoplay restrictions.
- Foreground repeat sound and OS background notifications are separate capabilities. Browser/OS permission, silent/Focus settings, battery rules and suspension affect delivery/sound. No guarantee of continuous ringing while the screen is locked or the browser is closed.
- Background delivery requires an active service worker, supported Push/Notifications APIs and a secure reachable origin. localhost on the ERP computer is not a phone-reachable test URL. Do not expose the owner server or create a tunnel/deployment without approval.
- On iOS/iPadOS, test the supported Home Screen web-app flow and user-gesture permission requirement. Prove that the installed app can access the SAME customer's order securely; do not assume browser/PWA storage handoff. Supply a safe one-time handoff or an honest supported ordering flow if needed.
- Use service-worker persistent notifications on mobile, not an unsupported Notification constructor. A service worker cannot provide a guaranteed endless audio loop. Do not rely on requireInteraction/renotify as a universal guarantee.
- Proposed background policy: an initial ready notification, up to two reminders at60/120 seconds while unacknowledged, and15-minute job expiry. Keep the unacknowledged tracking state visible afterward. Treat these as documented configurable/safe defaults, not an invisible claim to ring forever.
- Notification body/click opens the protected tracking page. Mark acknowledgement only after the explicit customer action. Distinguish push-provider acceptance, device display where observable, and actual customer acknowledgement.

## Proposed reference schema — new, not an existing/applied migration

Verify current schema names and reusable equivalents first. If no equivalent exists, the following is the bounded reference design. Validate it with the installed Prisma version and prepare a migration; do not modify old migrations or deploy to owner data.

Add to CafeSettings:

```prisma
selfServicePickupEnabled Boolean @default(false)
```

Add the reverse relation to Order:

```prisma
pickupTicket QrPickupTicket?
```

New reference definitions:

```prisma
enum QrPickupPushJobStatus {
  PENDING
  CLAIMED
  SENT
  CANCELLED
  EXPIRED
  FAILED
}

model QrPickupTicket {
  id             String   @id @default(cuid())
  orderId        String   @unique
  cafeId         String
  branchId       String
  guestTokenHash String   @db.VarChar(64)
  createdAt      DateTime @default(now())
  expiresAt      DateTime
  revokedAt      DateTime?
  order          Order    @relation(fields: [orderId, cafeId, branchId], references: [id, cafeId, branchId], onDelete: Restrict)
  notices        QrPickupNotice[]
  subscriptions  QrPickupPushSubscription[]
  @@unique([id, cafeId, branchId])
  @@index([guestTokenHash, expiresAt])
  @@index([cafeId, branchId])
}

model QrPickupNotice {
  id             String   @id @default(cuid())
  ticketId       String
  cafeId         String
  branchId       String
  readyAt        DateTime
  acknowledgedAt DateTime?
  createdAt      DateTime @default(now())
  ticket         QrPickupTicket @relation(fields: [ticketId, cafeId, branchId], references: [id, cafeId, branchId], onDelete: Restrict)
  jobs           QrPickupPushJob[]
  @@unique([ticketId, readyAt])
  @@unique([id, ticketId, cafeId, branchId])
  @@index([ticketId, acknowledgedAt])
}

model QrPickupPushSubscription {
  id           String   @id @default(cuid())
  ticketId     String
  cafeId       String
  branchId     String
  endpoint     String   @db.Text
  endpointHash String   @db.VarChar(64)
  p256dh       String
  auth         String
  expiresAt    DateTime?
  revokedAt    DateTime?
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt
  ticket       QrPickupTicket @relation(fields: [ticketId, cafeId, branchId], references: [id, cafeId, branchId], onDelete: Restrict)
  jobs         QrPickupPushJob[]
  @@unique([ticketId, endpointHash])
  @@unique([id, ticketId, cafeId, branchId])
  @@index([ticketId, revokedAt])
}

model QrPickupPushJob {
  id             String   @id @default(cuid())
  noticeId       String
  subscriptionId String
  ticketId       String
  cafeId         String
  branchId       String
  reminderIndex  Int      @default(0)
  status         QrPickupPushJobStatus @default(PENDING)
  dueAt          DateTime
  expiresAt      DateTime
  claimedAt      DateTime?
  lockedUntil    DateTime?
  sentAt         DateTime?
  attempts       Int      @default(0)
  lastErrorCode  String?
  createdAt      DateTime @default(now())
  notice         QrPickupNotice @relation(fields: [noticeId, ticketId, cafeId, branchId], references: [id, ticketId, cafeId, branchId], onDelete: Restrict)
  subscription   QrPickupPushSubscription @relation(fields: [subscriptionId, ticketId, cafeId, branchId], references: [id, ticketId, cafeId, branchId], onDelete: Restrict)
  @@unique([noticeId, subscriptionId, reminderIndex])
  @@index([status, dueAt])
  @@index([lockedUntil])
}
```

Ticket existence records eligibility for that order. readyAt identifies a readiness generation; if the application has a stronger existing generation/version mechanism, reuse it rather than creating competing meanings. A stale acknowledgement must not suppress a newer notice. Do not introduce a new legal order transition merely to test re-readiness.

## Guest security and APIs

Use a cryptographically random, at least256-bit browser guest capability issued via an HttpOnly/Secure/SameSite cookie before eligible submission, and persist only its hash. Bind ticket creation atomically to the actual QR order and that guest. A shared guest hash may authorize that customer's own multiple tickets; it must never authorize another guest's order.

Preserve withIdempotency and QR throttling. Replayed order creation must retain correct ticket access without leaking guest secrets through cached response bodies, URLs, logs or audits. Do not use phone number, sequential order number or an ordinary orderId as proof of ownership.

Proposed protected public-customer endpoints, following repository conventions:
- POST /api/qr/[branchId]/guest-session — establish the guest capability with origin/rate guards.
- GET /api/qr/pickup/[ticketId] — minimal owned-order tracking, no private customer/staff/payment data.
- POST /api/qr/pickup/[ticketId]/acknowledge — Zod notice identity, stale-generation/state checks, exactly-once persisted acknowledgement and replay receipt.
- POST/DELETE /api/qr/pickup/[ticketId]/push-subscription — bounded validated subscription and revocation.

Scope every endpoint to the guest, ticket, order, cafe and branch; return non-enumerating refusals. Require same-origin/CSRF protection for cookie-authenticated mutations, expiry/revocation checks and suitable per-guest throttles without penalizing a whole café Wi-Fi unnecessarily. Responses must not be publicly cached.

Validate HTTPS push endpoints against reviewed trusted provider hosts, with no private/internal destinations or redirects; prevent SSRF through forged subscription data. Store endpoints/keys as secrets with bounded retention. Keep notification text minimal; never expose phone numbers, private notes or financial details on a lock screen.

## Transaction, worker and UI integration

Create notice/outbox rows only as part of a successful READY transaction and required audit. Unique keys must prevent duplicate events/jobs after staff retries. Do not send network push inside the order transaction. Handle subscription after READY by creating only the missing appropriate job.

Run a bounded task-owned dispatcher with atomic claims/leases, retry backoff, expiry, provider-error handling and revoked/404/410 endpoint cleanup. Recheck owner setting, order state, acknowledgement and expiry immediately before sending. Cancel pending reminders after acknowledgement/terminal state. An already in-flight push can arrive late; opening it must fetch current state and must not restart an acknowledged alert.

Use existing realtime infrastructure if suitable; otherwise bounded authenticated polling with visibility-aware backoff is sufficient for foreground tracking. Coordinate tabs to avoid multiple simultaneous chimes. Multiple orders must remain independently acknowledgeable. Clear timers/listeners and audio on unmount, acknowledgement, terminal state or feature disable.

A minimal service worker may handle push/click and required public assets. Do not cache authenticated ERP pages, finance endpoints, customer tracking responses or mutable order/payment APIs. Do not introduce an offline order/payment path.

Use the shared Arabic/RTL/green UI. Staff kitchen/pickup views show ready, customer acknowledged and actual served distinctly, with a pending-ack list. Customer acknowledgement must not award loyalty, collect money, decrement stock, close a table or mark SERVED.

## Acceptance and honest completion

Use only synthetic disposable fixtures. Test feature OFF compatibility; QR-only eligibility; preserved approval/payment/serving behavior; guest isolation, guessing, expiry, CSRF, SSRF, revoked subscriptions and absence of secrets in logs; READY transaction rollback and duplicate delivery jobs; duplicate/stale acknowledgement; pending/in-flight reminder races; cancelled/served state; multiple tabs/orders; refresh/reconnect; denied permission/autoplay and unsupported push.

Perform genuine foreground browser checks with a user gesture. Test Android Chrome and an iOS Home Screen app, including background/locked screen, only on available consenting test devices and a secure phone-reachable test origin. Mocks do not prove real background delivery or hardware behavior. Record the exact browser/device and whether the notification was accepted, observed, audible and acknowledged. If these checks cannot run, report background/device verification as incomplete.

This new schema/status/security feature requires a fresh affected regression set and final build for the Step6 source; the pre-Step6 Step5 build is not automatically current. Preserve prior proofs and bind new genuine source/build/migration receipts. Do not rerun unrelated investigations without cause.

Finish STEP-6-HANDOFF.md and a concrete activation packet: tested migration/checksums, dependency diff, required environment-variable names, dispatcher command, actual preview URL, capability/device matrix, privacy/retention defaults and owner maintenance/backup/switch actions. Do not enable this on real cafés or deploy its migration until that exact operational approval exists.

Final status: COMPLETE / PARTIALLY COMPLETE / BLOCKED / NEEDS OWNER DECISION. Report foreground, background, physical-device and owner-activation statuses separately.

Primary platform references, verified during prompt preparation:
- [MDN autoplay and user activation](https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Autoplay)
- [MDN Push API](https://developer.mozilla.org/en-US/docs/Web/API/Push_API)
- [MDN Notifications API](https://developer.mozilla.org/en-US/docs/Web/API/Notifications_API)
- [WebKit: Web Push for iOS/iPadOS Home Screen apps](https://webkit.org/blog/13966/web-push-for-web-apps-on-ios-and-ipados/)

---

<!-- Standalone source: 07-owner-device-backups.md -->

# Optional addition 7 — Owner-device backups from ERP Settings

Recommended Codex model: **GPT-6 Astra**. Thinking: **High**.
Roadmap: tenant-data inventory and versioned archive → encrypted manual backup and local verification → daily/weekly scheduling while ERP is open → independent offline inspection and isolated restore drill → evidence and handoff.

## Confirmed product request

Add **Settings → النسخ الاحتياطي واستعادة البيانات** for each authorized cafe/restaurant owner. Provide **نسخ احتياطي الآن** and an optional schedule **متوقف / يوميًا / أسبوعيًا**, saving on that owner's computer.

The owner explicitly confirmed on2026-11-03: automatic backup only needs to run while ERP is open on the computer. No native helper, OS service, mobile background guarantee or closed-browser scheduling is requested. The WhatsApp comparison concerns simple settings; do not integrate WhatsApp or its cloud storage.

Step1/1B implementation is already done. The original Steps2–5 and optional QR addition6 retain their numbering. This is a separate planned addition, normally after the five core steps; executing it does not mean those steps or production readiness are complete.

The owner subsequently requested offline operation and synchronization as separate addition 8; see [its prompt](08-offline-working-and-sync.md). A cloud archive cannot claim to cover unsynchronized device commands. When that feature exists, expose separate central/local coverage markers and an explicitly verified encrypted pending-work recovery component. A recovered pending bundle is quarantined for authorized reconciliation using original command identities, never blindly replayed or cloned into another active device. Do not expand this backup implementation into offline sales merely from this cross-reference.

This document is an implementation prompt for later explicit invocation. Recording it in the roadmap is not permission to run it now.

## Execution scope when invoked

Use only the NEXT CUP implementation worktree path and branch explicitly identified in the invoking instruction or its approved current handoff. If neither identifies an approved target, finish read-only planning and request that missing target before editing; branch inspection alone does not authorize selecting another checkout. Within that target, reuse existing architecture, installed dependencies, permissions and UI identity. Verify the actual branch/HEAD/current work and read the latest handoff; do not assume the previous recorded deployment state is current. Read `AGENTS.md`, section12 of `C:/Dev/cafe-operations-system-3/docs/research/2026-11-02-erp-experience/PLAN.ar.md`, the current schema and relevant installed Next.js guides first.

Local implementation, focused tests and reviewed local commits are authorized by explicit invocation of this prompt. No push, merge, deployment, owner-database operation, PostgreSQL control, provisioning, global seed/reset or .env change is authorized. Testing and restore writes require positively verified dedicated disposable targets with real server/database correspondence. Preserve existing fixture receipts and historical guard code/pins. If an isolated restore target is unavailable, finish independent code/pure checks, prepare its exact setup request and report the restore drill unverified.

## 1. Settings and honest status

Extend the existing `src/app/(app)/settings/page.tsx` using an owner-only shared-style settings card. Suggested component: `src/components/settings/backup-card.tsx`. Add a session-level coordinator in the existing authenticated shell so scheduling continues on other ERP pages, not only while Settings is visible. Respect existing feature gates and user/tenant changes.

The card includes:

- **نسخ احتياطي الآن**, **اختيار/تغيير مجلد الحفظ**, and **فحص نسخة محفوظة**.
- Automatic frequency OFF by default; daily or weekly, time, IANA time zone, and weekday for weekly schedules. Display **يعمل أثناء فتح ERP على هذا الكمبيوتر مع توفر الاتصال** beside the control.
- Device-specific destination/capability/permission state, schedule, next due slot, last archive generated, **last file saved and verified on this device**, and the archive's actual data coverage time. Never conflate these timestamps.
- States: idle, preparing, receiving, encrypting, saving, verifying, saved, overdue, failed, needs permission, needs recovery-key unlock, unsupported and offline. Keep percentages indeterminate if total work/bytes are unknown.
- Retain multiple dated archives. Never overwrite the only good backup. Any retention pruning needs explicit owner opt-in, affects only manifest-owned files in the selected directory, follows successful new-file verification, and cannot remove the last known good copy or unrelated files.
- A clear recovery-key setup and reminder. The key must work without the live service. The reference flow keeps the unlocked encryption material in session memory; after reload/logout or loss of that material, show the locked state and require owner unlock. Never silently report scheduled backups as active while the required key is unavailable.

Do not upload the owner's filesystem path, directory handle or recovery secret to Railway. Local preferences/history are namespaced by cafeId, ownerId and this browser/device. Do not show one owner's folder/history after another owner logs in. Logging out stops in-flight coordination safely and releases in-memory secrets; it must not delete existing backup files.

## 2. Saving on a supported computer

Feature-detect and test File System Access on desktop Chrome/Edge over a secure context. The owner selects a directory through an explicit user action. Persist a supported directory handle in device-local IndexedDB; check actual permission before every scheduled write. Renew permissions only through an appropriate owner click. A timer cannot summon a directory picker or bypass a denied prompt.

On unsupported browsers, retain a clearly labeled manual download fallback. Disable automatic folder saving with an explanation. A requested browser download is not proof that a file reached durable owner storage; distinguish download-started from a save that the application can actually verify.

Write a uniquely named new archive, finish/close the write, reopen and verify the saved bytes/manifest before recording local success or pruning. Handle cancellation, revoked permissions, full disk and truncated files. Leave previous verified archives intact. Temporary/incomplete files must never appear as valid completed backups.

Primary references: [MDN directory picker](https://developer.mozilla.org/en-US/docs/Web/API/Window/showDirectoryPicker), [Chrome File System Access](https://developer.chrome.com/docs/capabilities/web-apis/file-system-access).

## 3. One tenant-consistent, portable archive

Inspect the actual current Prisma relations and define an explicit export inventory before coding. Include the cafe's branches, catalog/products/variants/add-ons, recipes, stock and movements, counts/handovers, suppliers/purchases, orders/invoices/items/revisions, collections/refunds, customers/loyalty, shifts, treasury, expenses, accounting/journals where present, settings and necessary business history. Include relevant owned attachments or explicitly identify unavailable/missing items. A link to an online attachment is not an independent copy of its contents.

Use only authorized cafe-owned rows and required safe reference data. Do not expose a shared database dump. Exporting a complete cafe requires cafe-wide owner authority: deny a branch-restricted/lower-role request rather than presenting a partial export as a complete backup. Resolve cafeId from the authorized session, not a client-supplied tenant ID. Maintain tenant scoping through every relation, including attachment reads and historical actors.

Exclude passwords/password hashes, session cookies, API tokens, customer tracking/bearer secrets, provider/Railway credentials and other authentication secrets. Preserve necessary historical actor references through safe non-login metadata; document the separate controlled authentication bootstrap needed for a recovered installation. Do not change users' current credentials to make an archive restorable.

Generate the relational dataset under a bounded, consistent PostgreSQL read snapshot, using appropriate read-only/repeatable-read semantics. Avoid independent page queries taken at different financial moments. Never mix another tenant into the archive. Keep Decimal and bigint values exact as strings and timestamps explicit; never round-trip financial values through binary floating point. For attachments outside PostgreSQL, pin immutable object versions or verify the staged bytes against the manifest; changed/unavailable bytes cannot silently become a complete backup.

The versioned manifest records archive/format/schema/application versions, cafe identity, coverage/snapshot time, module/table inventory and row counts, relationships, attachment inventory/checksums, omissions and payload integrity checks. Define supported size/time limits and test representative larger datasets; fail visibly at limits instead of silently dropping older records or attachments. Bound memory, snapshot duration and transfer resources.

Inspect current route/auth/client patterns. Proposed endpoint: `GET /api/backups/archive`, using dedicated binary/stream handling rather than the small JSON-report reader's default deadline. Authenticate and authorize server-side, rate-limit exports and use appropriate private/no-store responses. No public reusable download URL or URL-embedded access secret. Cancellation of this read must not alter business records or money-command recovery. Safe export audit metadata may use the existing audit mechanism, separately from the read-only data snapshot; a server export event is not proof of local saving.

Proposed Prisma models, enums, relations and indexes: **NONE for the confirmed browser-open design**. Device schedule, directory handles, unlock state and local save history stay device-local. Reuse current cafe, user, business and audit structures. This is a proposed reference architecture, not an already verified migration. If a material schema change becomes necessary, present the precise reason/schema separately before applying it; do not manufacture a second ledger or silently expand this scope.

## 4. Encryption and key ownership

Store an encrypted portable archive using a reviewed authenticated-encryption construction and maintained platform/library primitives. Document key generation/derivation, authenticated metadata, randomness/nonces, format versioning and tamper/truncation rejection. Use Web Crypto/established implementations appropriately; do not invent a cipher or unreviewed streaming-crypto protocol. Inspect available dependencies before proposing an addition.

The owner controls a recovery key/secret and is shown how to keep it separately from the archives. It must not depend on a Railway secret that becomes unavailable during an outage. Do not persist a plaintext recovery secret in localStorage, logs, source, URLs or the service database. Do not promise key recovery that has not been designed and verified. Wrong/lost keys and damaged archives fail safely without overwriting data.

This is business-data protection, not a guarantee against a compromised owner computer or a specialist cryptographic signoff. Complete an explicit security review and actual recovery tests before calling the feature release-ready. References: [OWASP cryptographic storage](https://cheatsheetseries.owasp.org/cheatsheets/Cryptographic_Storage_Cheat_Sheet.html), [MDN Web Crypto](https://developer.mozilla.org/en-US/docs/Web/API/Web_Crypto_API).

## 5. Daily/weekly while ERP is open

Validate preferences with Zod: frequency OFF/DAILY/WEEKLY; a valid local HH:mm; valid IANA zone; weekday0–6 required for weekly mode; device-local retention choice if supported. Keep proposed client DTOs separate from verified server contracts. Disabling the schedule stops future scheduled work, not existing stored files.

Check due work on authenticated app start, visible/focus resume and network return, plus an appropriate while-open timer. Use local calendar slots in the selected time zone, handling DST, clock changes and missed windows. On return from sleep/offline/closed ERP, perform at most one current catch-up backup and record its actual coverage/save time; do not invent a file for every missed day.

Deduplicate manual/scheduled and multi-tab attempts for the same device/cafe/due slot with a robust lock and generation/identity checks. Use capability detection and a tested fallback if the preferred browser locking API is unavailable. A lease/lock or an export response alone is not a completed backup. Do not persist a slot as successful before file verification.

Failures are retryable with bounded backoff only while prerequisites remain valid. A revoked permission/locked key requires owner action, not repeated popups. Stop on logout or changed owner/cafe; late async work must not update the next owner's status. Device scheduling is not a Railway cron job and does not rely on Periodic Background Sync for exact delivery. [Browser periodic-sync limitations](https://developer.mozilla.org/en-US/docs/Web/API/Web_Periodic_Background_Synchronization_API).

## 6. Railway outage and recovery

Previously saved archives must remain usable without the original Railway service/account. Deliver a version-matched independent local inspection/recovery kit with the first backup and test it without network access. An authenticated page served only by the unavailable ERP is insufficient. The kit must inspect/decrypt/validate the archive locally without uploading its data or key, show coverage/content/omissions and support documented recovery into an authorized isolated target. It must not require a production secret or contact a CDN to display essential data. Treat archive contents as untrusted input; no executable HTML, unsafe extraction paths or unlimited decompression.

Restore is a separate, explicit operation: preflight key/integrity/version/tenant/relationship checks → preview → isolated test target → exact data reconciliation. Restore records inertly through a controlled importer, not by replaying sale/payment/stock/posting APIs. Preserve history and exact relationships/values; do not create new financial events, send messages, activate jobs or duplicate inventory usage. Never merge/overwrite live owner data automatically. A real restore needs its own authorization and rollback plan.

Explain in Arabic: saved copies protect data up to their recorded coverage time. A new server-derived backup cannot be produced while the server is unavailable. A backup does not make offline POS sales or synchronization available; those remain separate features.

## 7. Verification and delivery

Use meaningful targeted tests and a verified synthetic cafe, never owner data. Required evidence:

1. Manual export → encrypt → save on a real supported computer → reopen/decrypt/validate; exact row counts, identities, relationships, Decimal/bigint values and relevant attachment bytes. Test concurrent synthetic business changes during export and changed/missing attachment bytes: the archive represents one consistent snapshot or fails/declares incompleteness explicitly. Show representative settings and saved-file states.
2. Two cafe owners plus a limited user: no cross-tenant data, no credential leakage and no branch-limited export mislabeled complete.
3. Daily/weekly/OFF, time/zone/DST, missed-slot catch-up, app navigation away from Settings, reload/locked key, two tabs, overlapping manual backup, logout/account change and late responses.
4. Network/Railway outage, denied/revoked folder permission, unsupported browser, disk full, interrupted/truncated/tampered file, wrong recovery key and safe retention behavior. Never record success without a valid saved file.
5. Open the independent recovery kit with network disabled; test a separately authorized isolated restore. Reconcile business totals and references, with zero extra collections/postings/stock deductions/messages. Publish omissions/size/support limits and device/browser results.

Finish local source and focused verification before asking for any deployment/setup approval. Deliver a short `BACKUP-STEP7-HANDOFF.md` with changed files, format/key/recovery instructions, exact checks, synthetic proof, screenshot evidence, tested support matrix and remaining gates. Distinguish implemented code, verified local saves, verified recovery and owner acceptance. Do not mark the backup feature complete or reliable merely because an archive downloaded or unit tests passed.

---

<!-- Standalone source: 08-offline-working-and-sync.md -->

# Planned addition 8 — Shared LAN operation and automatic cloud synchronization

Recommended Codex model: **GPT-6 Astra**. Thinking: **High**.
Roadmap: branch authority and local-QR design → shared venue runtime and durable transactions → ordered cloud reconciliation → real multi-device outage/restart/recovery acceptance.

## Confirmed owner choice — 2026-11-03

The owner explicitly chose: **cashier, kitchen and QR ordering must keep working together through the venue's local network when Internet fails**, with local saving and automatic synchronization after Internet returns. This supersedes the earlier proposed independent-browser-only architecture. Do not ask the same topology question again or implement isolated browser queues as if they satisfied it.

This addition is separate from owner-device backup addition 7. Its browser-open-only choice applies to backup scheduling, not to the shared venue runtime. Core Step1/1B is implemented; Steps2–5 and additions6/7 keep their numbering. No application implementation, local service setup or deployment occurs merely by saving this prompt.

**Invoke 8A first.** This is a larger architecture change, not a service-worker checkbox. An explicit 8A invocation authorizes bounded design/protocol work and pure simulations in the worktree/branch identified by that invocation or its approved current handoff. Verify the actual HEAD, source and ownership; without an identified target, finish read-only preparation before requesting it. Further slices use the reviewed 8A handoff and their actual authorized environment; recording all slices here does not execute them automatically.

Read AGENTS.md, the latest Step1/1B/2 handoffs, PLAN.ar.md section13, current Prisma schema, protected transactions, order creation/status/collection, stock freezes, shift/custody/approval rules, reporting and output definitions. Read installed Next.js guides, including progressive-web-apps.md, before selecting a client/worker integration. In the inspected source there are server IdempotencyKey reservations and sessionStorage retry keys, but no implemented shared offline branch runtime.

Preserve owner source/data, .env, existing SQL and fixtures. No owner database operations, PostgreSQL control, provisioning, installation, seeds/resets, push, merge, deployment, external messages or live financial-policy changes are authorized by this planning prompt. Local runtime and networking setup must be concrete and separately scoped before execution; never commandeer an existing database/listener or weaken safety pins. Reuse any already documented applicable authorization rather than repeatedly requesting it.

## 1. Chosen topology and proposed authority design

**Confirmed topology:** an on-site coordinator on an owner-designated always-available venue computer/device, serving cashier, kitchen and customer QR clients over the functioning LAN. Its local transactional datastore persists accepted work through a client/browser restart. Cloud hosting remains the central cross-branch service and reporting destination.

**Engineering proposal, not yet an owner-approved financial-policy change:** for an enabled branch, route its operational writes through one enrolled branch coordinator in both connected and disconnected modes. Synchronize its committed facts to the cloud with durable identity and provenance. This avoids an uncontrolled failover in which the cloud and local coordinator both accept independent writes to the same branch's cash drawer, orders or stock. Validate this authority model in 8A before activation; if current business workflows cannot support it, present the precise alternative and tradeoff rather than silently choosing dual writers.

The local coordinator must run the same reviewed domain behavior and protected transactions, not a simplified second POS or ledger. A PostgreSQL-specific Prisma/schema/locking implementation cannot silently become an unrelated local storage engine; identify a supported packaging/datastore approach and prove Decimal, transaction, locking and durability equivalence. Select venue hardware/OS/runtime, capacity, startup/restart and data-directory requirements in the 8A handoff. Do not assume this developer machine, owner database5433 or disposable5434 is the customer's production coordinator.

Define branch/device enrollment, branch authority epoch, allowed writer, revocation and safe replacement. Enforce the authority boundary on every branch write path, including cloud POS, QR, admin changes, payments, table operations and background jobs. Remote/cloud orders for an edge-enabled branch must reach the active coordinator, or remain explicitly unaccepted/pending. A successful cloud payment or order acknowledgement cannot be invented while the venue has not durably accepted the corresponding operation.

During a partition, the cloud must not automatically appoint a second branch writer. Replacement/failover needs a proven fencing and pending-data recovery protocol; an old coordinator cannot reconnect as a second live writer. Stale epoch operations retain reviewable evidence but do not silently mutate current state. Do not promise automatic cloud failover and concurrent strict local authority without a demonstrated coordination protocol.

The LAN and coordinator need power and local connectivity. Internet loss is distinct from router/LAN failure, coordinator failure, device failure and cloud outage. Show distinct states and support limits. A standalone browser queue may retain an unsubmitted intent during a brief client-to-hub loss, but it must not show kitchen delivery, table reservation, payment confirmation or a shared order as accepted until the coordinator has durably committed it.

## 2. Local QR, guest access and browser origins

A new customer's phone must be able to open the local menu and submit a QR order over venue Wi-Fi during a WAN outage; success cannot depend on that phone previously caching the cloud app. Define and demonstrate the QR link/discovery path, stable local origin, routing/DNS strategy, trusted TLS/certificate provisioning/renewal, guest Wi-Fi routing and any browser local-network permissions.

Do not assume the current Railway public URL automatically reaches a private LAN server, that mobile data reaches the venue LAN, or that localhost on a customer's phone names the cashier computer. Identify when a venue-local QR or onboarding link is required and the user-facing switching flow. If one printed QR is required for connected and disconnected modes, prove its local/public resolution design and certification on the supported devices before claiming it.

Prefer a directly served, trusted local web origin for venue clients. Do not rely on bypassing certificate warnings, browser security flags, permissive global CORS, or disabling Wi-Fi isolation across the entire network. Expose only reviewed application endpoints to guest devices; never the local database port, owner admin interface or sync credentials. Tenant/branch/table identity and short-lived tracking capability remain server-validated; a table number in a URL is not authorization.

Secure-context/service-worker, local-network and origin/storage behavior must be tested on real target browsers. A page's public-to-private network access and WebSocket permissions may differ from direct local navigation; do not assume universal compatibility. Read primary guidance: [MDN secure contexts](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Secure_Contexts), [MDN local network access](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Local_network_access).

QR orders still follow current waiter/approval/preparation rules. Kitchen updates, readiness and customer acknowledgement use the local coordinator while LAN-connected. Addition6 sound may work in the open local tracking page after required interaction; Internet-dependent push, SMS, email and provider payment are not promised during WAN loss. Reconnection must not send an old ready event as a fresh repeated notification. Preserve the distinction between customer acknowledgement, actual service, payment and stock consumption.

## 3. Shared operational scope and UI

Add **Settings → العمل عبر شبكة المكان والمزامنة**, with owner-authorized enrollment/activation, coordinator identity and health, connected devices, LAN/cloud status, local storage health, last committed local sequence, last cloud-acknowledged sequence, pending/conflict count, update state, recovery and safe disabling.

Use the shared app shell and Step1B identity. Staff see **متصل بالمكان / يعمل محليًا — الإنترنت مقطوع / مزامنة السحابة / تعذر الاتصال بجهاز المكان / يحتاج مراجعة**. A working LAN may have no Internet. Expose a useful retry/sync center without an ordinary delete-pending-work button. Do not mislabel “accepted by the local coordinator” as “confirmed in the cloud”.

Publish a capability matrix before activation:

| Area | Required venue continuity | Explicit boundaries |
|---|---|---|
| Cashier, menu, orders | Shared prepared catalog, order creation, allowed cash collection, local receipt and protected order lifecycle | One domain transaction/command identity; cash received is not automatic SERVED |
| Kitchen | Receive coordinator-accepted tickets, update preparation/ready state, reconnect/recover history | No duplicate ticket or state loss after restart |
| QR and tables | Guest local menu/order/tracking, staff approvals, shared table sessions and visible occupancy | Phone must reach the venue LAN/local origin; preserve guest/table scope |
| Shifts, cash and stock | Current local authoritative custody, stock policy/freezes and permission gates | No relaxed stock enforcement, false shift opening/closure or fabricated approval |
| Sales/SKU/shift/table reports | Coordinator-local accepted data with clear coverage and pending-cloud marker | Cross-branch consolidated cloud reports may lag; do not add local rows twice after sync |
| Expenses/purchases/recipes/counts | Explicit reviewed support matrix and safe drafts/views, then scoped local commands | Do not call all ERP modules offline-ready before their authoritative domain paths are proven |
| Treasury/accounting/remote owner approvals | Preserve current protected behavior and clearly state which authority is available locally | Accountant/D7/D8 and live-posting gates remain; no second ledger |
| Card/wallet, cloud integrations and background push | Show genuine provider capability and pending/unavailable state | No invented offline charge approval or retry that charges twice |

All clients share state through the coordinator rather than inferring it from independently cached copies. Concurrent cashiers must see shared accepted table/order/stock state. Keep permission changes, catalog/policy updates and remote approvals versioned and ordered; do not overwrite local active work with a newer cloud catalog mid-transaction.

## 4. Durability, authorization and identity

Persist the complete local business write, audit, replayable command result and cloud-bound outbox event atomically in the coordinator's transactional datastore. Return accepted only after that durable commit. A network send, client toast, printed ticket or IndexedDB insertion alone is not a shared local commit. Test power/process failure at the acknowledged-commit boundary; document remaining hardware/filesystem limits.

Client commands have immutable UUIDs, payload hashes, actor/device/cafe/branch/authority-epoch context, causal dependencies and protocol versions. Online and offline paths reuse the same logical identity, including “coordinator committed, response lost, client retries after reconnect”. Two intentional identical baskets have different logical command IDs. Deduplicate concurrent clients/tabs and retry exactly the same command; do not key business identity only by basket hash.

Local staff authentication must remain available through Internet loss and coordinator/client restart using a reviewed, bounded offline-capability policy. No plaintext staff passwords, exported cloud password hashes, server signing secrets or reusable cloud bearer tokens in browsers. Define enrollment, local unlock/authentication, expiration, current role/custody checks, audit, local key ownership and emergency lockout. A cashier cannot become owner or approve their own refund because cloud approval is unreachable.

Immediate remote revocation cannot be learned across a disconnected network. Bound offline authority and define the unavailable-approval path; reconnect validates current cloud/device authority without erasing already committed local cash evidence. Distinguish expiry of permission to accept new commands from synchronization of older durable facts. Neither user-supplied times nor a device clock rollback extends authority. No fake historical backdating or reassignment of offline cash to a different actor/shift.

Preserve exact financial snapshots, Decimal/minor-unit arithmetic, units, discounts/tax/service, revision/return semantics and actual service-time stock deduction. The local coordinator needs a coherent authoritative copy of current custody, stock, freezes and pricing; “last browser snapshot” is insufficient for shared strict operations. Persist occurred-at-local, coordinator sequence/commit time and cloud-received time separately. No new fiscal receipt/numbering guarantee without reviewing the applicable existing invoice contract.

Keep a stable branch-wide local order number plus a globally unique order identity and documented cloud mapping. If statutory/final invoice numbers require another allocation rule, resolve that before activation. Never renumber a customer's existing receipt invisibly or use a new operation ID during recovery.

## 5. Cloud synchronization and split-brain prevention

Use an ordered durable outbox on the coordinator and authenticated, cafe/branch-scoped cloud ingestion. Define bounded batches, contiguous committed sequence, authority epoch, event UUID, schema/protocol version, canonical payload hash, dependencies and approved replayable receipt. Sign/authenticate transport with rotatable coordinator identity kept out of browsers. Establish server-side scope from enrollment, not a user-supplied cafeId.

Cloud synchronization acknowledges an event only after its permitted effects and immutable ingestion receipt commit atomically. A lost acknowledgement causes replay of the same event/hash and returns the old receipt; a changed hash or sequence collision is a conflict. Never acknowledge a high sequence across missing predecessors. Apply independent branches separately, while preserving causal order within a branch epoch.

Define the actual replication mapping in 8A: authoritative local entity IDs and snapshots, central references/projections, current business invariants, finance/inventory audit preservation and conflict handling. It must neither blindly upsert arbitrary client database rows nor call ordinary “create order/collect payment/serve” APIs again as if the sale were new. Do not re-execute an external charge, stock deduction, loyalty redemption or accounting posting to synchronize an already committed effect. Where a central policy cannot accept an authoritative fact, quarantine it with its original evidence and expose review rather than deleting it or falsely marking synced.

Use existing Order, Payment, Shift, stock, accounting and audit structures as canonical business models; the sync outbox/receipts are transport provenance, not a parallel ledger. Review cross-branch references, local-vs-central IDs and conflict outcomes explicitly. No silent financial-policy change is authorized to make replication convenient.

Cloud-to-coordinator changes need their own reviewed order/version/checkpoint contract. Remote order submissions, catalog changes, permission updates and remote approvals cannot mutate a second independent copy of active branch stock/cash. Reject stale writes or queue explicit commands for the coordinator; no last-write-wins for money, stock, table occupancy or custody.

Reconcile on actual API recovery, authenticated startup/resume and bounded retries with backoff/jitter. Internet and cloud failures must not stop LAN operations. Retain data through long outages, cloud deployment and protocol upgrade; support negotiated versions or a recoverable paused sync rather than deleting pending work. Keep immutable dedupe evidence for the supported replay/recovery window. Exactly-once transport is not promised; durable identities and transactional deduplication prevent repeated business effects.

## 6. Proposed reference schema — not an applied migration

8A must inspect current schema/IDs and finalize the exact schema before any implementation slice applies it. Starting reference names and constraints are below. No new JournalEntry/Payment/Order replacement is proposed. Any migration needs its explicitly permitted disposable environment; planning does not authorize owner migrations.

| Proposed model/enum | Exact starting fields | Relations and required constraints |
|---|---|---|
| BranchEdgeNode | id UUID PK; cafeId String; branchId String; enrolledById String; label String(100); state EdgeNodeState; publicKeyId String; enrolledAt DateTime; revokedAt DateTime? | Cafe, Branch, User with restrict deletion of retained provenance; unique(cafeId,branchId,id); index(cafeId,branchId,state). Private key remains outside this table/client |
| BranchEdgeAuthority | id UUID PK; cafeId String; branchId String; nodeId UUID; epoch BigInt; grantedAt DateTime; revokedAt DateTime?; cloudAckSequence BigInt default0 | Composite node relation(cafeId,branchId,nodeId); unique(cafeId,branchId,epoch); unique(cafeId,branchId,nodeId,epoch); index(cafeId,branchId,revokedAt). A reviewed PostgreSQL partial unique active-authority constraint per branch is also required, not approximated by nullable uniqueness |
| EdgeIngestReceipt | id UUID PK; cafeId String; branchId String; nodeId UUID; epoch BigInt; sequence BigInt; eventId UUID; payloadHash String(64); protocolVersion Int; committedAtLocal DateTime; receivedAtCloud DateTime; result Json | Composite authority relation(cafeId,branchId,nodeId,epoch); unique(cafeId,branchId,nodeId,epoch,sequence); unique(cafeId,eventId); index(cafeId,branchId,receivedAtCloud). Persist atomically with accepted central effects |
| EdgeNodeState | ACTIVE, REVOKED | Admission state only; never an Order/Payment financial status |
| LocalEdgeOutbox — coordinator-only persistence | eventId UUID PK; branch/epoch/sequence; command identity; protocolVersion; payloadHash; immutable payload; createdAt; state; retryAfter; acknowledgedAt; cloud receipt | Transactionally linked to the actual local domain write; unique(branch,epoch,sequence), unique(command identity and effect kind); pending/review entries cannot be pruned. Final Prisma-vs-local table placement follows the reviewed packaging model |

These are **proposed reference definitions**, not a validated Prisma migration. 8A must supply compilable Prisma relations/back-relations, exact SQL constraints, auth scopes, strict Zod schemas and route/event contracts after validating the packaging and authority model. Do not apply an unverified schema or create a second business datastore merely from this table.

Proposed route families: local authenticated /api/edge/commands and /api/edge/health; local public /api/qr/... with existing scoped tracking semantics; cloud owner-only node/authority administration; node-authenticated /api/edge/sync/push, /pull and /receipts. Inspect existing routes and reuse conventions; these are not currently implemented endpoints. Validate bounded batches, decimal strings, UUID/sequence/epoch, hash, protocol version and operation allowlist; input may not supply arbitrary SQL/model mutations.

## 7. Backup, recovery, updates and administration

Addition7 cloud backup coverage and coordinator-local backup coverage are different. A venue-local transaction not yet acknowledged by the cloud is absent from a cloud-only backup. Show central/local sequence watermarks, cloud acknowledgement, pending/review counts and actual snapshot coverage. Owner-device backup must identify its source and include any explicitly selected local data/outbox consistently.

Provide reviewed encrypted coordinator backup and restore/recovery procedures that do not depend on Railway being online. Preserve command/event IDs, branch epoch, provenance and acknowledgement state. A restored clone starts quarantined: no second active coordinator, automatic reenrollment or replay using fresh IDs. Reconcile cloud receipts and safely fence a lost/replaced node before activating a recovery target.

Cover coordinator process restart, machine restart, interrupted writes, corrupt/partial archive, wrong key, low disk and LAN/WAN recovery. Do not claim backups from a file download without restore evidence. Browser persistence remains useful for prepared assets/unsubmitted drafts, not the sole authoritative venue database.

Updates must preserve active orders, compatible clients, local keys, pending outbox and old protocol support. No cache cleanup, factory reset or logout that destroys accepted/unsynchronized work. Expose nontechnical owner health/recovery instructions, supported capacity/hardware and safe rollback. Keep DB ports, platform credentials and infrastructure controls outside product guest flows.

## 8. Delivery slices and real acceptance

**8A — Architecture/protocol proof first:** current-route/permission/custody inventory, venue hardware/runtime proposal, LAN QR origin/TLS/guest-network design, branch write-authority and failure matrix, exact schema/routes/Zod/event/transaction contracts, report/backup watermarks, upgrade/recovery protocol and pure fault simulations. This slice does not claim live offline readiness or authorize installing services. Obtain review of the concrete design before code/setup slices that change operational authority or financial behavior.

**8B — Shared venue runtime:** explicitly authorized isolated coordinator environment, local staff/guest auth, cashier+KDS+QR/table flows, protected domain transactions, durable results and receipt/ticket recovery. Existing policy and UI identity remain.

**8C — Cloud sync and wider modules:** scoped ordered ingestion/pull, dedupe/fencing, reports and backup reconciliation, then the explicitly supported additional ERP module commands. No automatic owner migrations/deployment.

**8D — Integrated acceptance and recovery:** physical multi-device WAN isolation, coordinator/client restarts, network and cloud partitions, safe restoration, owner usability acceptance and separately authorized production activation.

Required evidence on verified synthetic environments:

1. One coordinator, cashier client, kitchen client and a real phone on venue Wi-Fi. Disconnect the actual WAN while LAN stays up; on a phone that never cached the app open the local QR, order, receive/approve it at the venue, prepare/mark ready, view customer tracking and acknowledge pickup. Record cash separately and actual service through current rules. Show shared table/order state on another client.
2. At least10 distinct orders, including two identical baskets, concurrent cashiers and repeated submissions. A local acknowledged order survives a coordinator restart; a client retry after a lost response creates one order, expected payments, exact service-time stock effects and one kitchen ticket.
3. Restore Internet/cloud; reconcile exact order/payment/stock/report counts and local/cloud watermarks. Repeat synchronization and replay old receipts/bundles: zero duplicate collection, stock deduction, loyalty redemption, posting or customer notification.
4. Crash before/after local transaction, after central commit/before acknowledgement, and during checkpoint update. Test gaps/reordered batches/hash mismatch, expired/revoked authority, old node reconnect, cloned restore, coordinator replacement and simultaneous cloud/edge submissions. No split-brain writer and no high acknowledgement over an unapplied predecessor.
5. Test cashier/guest/manager authorization, wrong cafe/branch, reused QR tracking capability, guest Wi-Fi isolation, TLS/certificate expiry/renewal, Android/iOS/browser permissions and phone on mobile data rather than venue Wi-Fi. State unsupported paths honestly; no security-warning bypass.
6. Test shift/custody changes, stock freeze/strict enforcement, price/revision changes, permission expiry/revocation, partial cash collection/refunds where supported, prepared/unserved vs served orders, midnight/Cairo reporting and remote owner approval unavailable. Preserve original evidence and current finance policy.
7. Test low/full disk, interrupted local write, LAN loss, WAN-only loss, cloud-only outage, power/process restart, long outage, app/protocol update with pending work and independent encrypted restore. Router/coordinator failure must not be disguised as normal working Internet-offline mode.
8. Demonstrate screen/CSV/Excel/print, reports by SKU/shift/table and cloud cross-branch views at known checkpoints; distinguish pending local coverage and avoid duplicate aggregate results. Hardware receipt printing and background notifications need their own real-device evidence.

Run meaningful pure/targeted runtime, security/concurrency, build and production-mode browser checks appropriate to each slice. Do not provision a missing target or use owner data as fallback. Final handoff includes exact supported device/network/module matrix, source changes, reviewed schema/protocol, setup/health/recovery instructions, tests and failed/unverified paths, preview topology and rollback preserving pending work. Final status must distinguish planned architecture, implemented shared LAN behavior, verified synchronization/recovery and production authorization.

Primary references: [MDN secure contexts](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Secure_Contexts), [MDN local network access](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Local_network_access), [MDN Service Workers](https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API), [MDN storage durability](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria). Use installed framework guidance and actual domain code as primary implementation context.

---

<!-- Standalone source: 09-optional-cost-based-pricing.md -->

# Planned addition 9 — Optional cost-based menu pricing with editable final prices

Recommended Codex model: **GPT-6 Astra**. Thinking: **High**.
Roadmap: verify cost and target-price contracts → optional settings and editable suggestions → guarded selected-price publication → POS/QR/variant/branch reconciliation and handoff.

## Owner request — 2026-11-03

Add optional automatic pricing for menu creation/repricing. The owner can enter a SKU's cost directly or use its ingredient/recipe cost, choose a selling-price multiplier such as ×2 or ×3, and keep the resulting price column editable. Example: cost16.25 ×2 proposes32.50; the owner can enter35.00 before publishing. Fractional prices remain valid when deliberately chosen; do not ban them globally.

This is a planned addition, not an instruction to run it merely because the file was saved. Preserve implemented Step1/1B, remaining core Steps2–5 and additions6–8. Explicit later invocation authorizes bounded local code/tests/reviewed local commits in the worktree path and branch named by that invocation or its approved current handoff. Verify HEAD and actual work; without a named approved target, finish read-only preparation and request it before edits. No automatic execution of other prompts.

Read AGENTS.md, PLAN.ar.md section14, the latest handoff, actual schema and installed Next.js route-handler/form guidance. Inspect src/lib/money.ts, pricing.ts, costing.ts, recipes.ts, product/variant/branch price write paths, menu page, product-cost report, recipe confirmation and branch ingredient resolution. Use current permissions, audit/idempotency and protected transaction patterns. Do not repeat broad ERP research or rebuild Step1/Step3.

No owner-database write, real-menu repricing, PostgreSQL control/provisioning, dependency installation, .env edit, push, merge or deployment is authorized by preparing/invoking this bounded development prompt. Schema application needs an explicitly allowed verified disposable target. Preserve accountant/D7/D8 and existing valuation, posting, receipt, order revision, custody and stock policies. This feature changes selected future menu prices; it does not restate historical COGS, profit, invoices or inventory valuation.

## 1. Product behavior and clear defaults

Add **Settings → التسعير حسب التكلفة**, owner-controlled and OFF by default. Enablement shows pricing controls; it must not reprice the menu itself. Provide ×2, ×3 and a validated custom multiplier, plus optional rounding defaults. Also expose **احسب السعر من التكلفة** in the existing product editor and a bulk **تسعير / إعادة تسعير المنيو** workspace for permitted products/categories and price targets.

The engineering default is calculation → editable review → explicit publication of selected rows. The owner did not request unattended background price changes. Editing an ingredient cost, importing recipes, enabling the feature, opening the report or changing a multiplier may refresh suggestions but must not silently publish prices. If future unattended repricing is requested, design it separately rather than inferring permission here.

Per row show: selection, SKU/product/variant, target branch/global scope, separate reference-cost branch, cost source and status/time, cost per sold unit, multiplier, raw calculated price, optional rounded suggestion, current effective price, **editable final price**, manual-override state and difference. Cost breakdown is available to authorized readers. Keep this usable on mobile, with labeled inputs, decimal entry, keyboard navigation, visible errors and Arabic RTL identity from Step1B.

Changing cost/multiplier/rounding updates an untouched final-price draft. Once the owner edits final price, mark it **تعديل يدوي — محفوظ** and do not overwrite it during refresh, bulk recalculation, ingredient-cost updates, navigation/reload recovery or a new preview. Show the new suggestion alongside the retained manual value. Provide an explicit **استخدم المقترح من جديد** per row and a separately chosen reset for selected manual rows. Do not default-select pinned rows for a later automatic bulk overwrite.

Keep manually edited catalog prices outside this feature protected too: compare against last applied price/fingerprint and require explicit review when another authorized editor changed a target. User-scoped draft recovery must not expose another cafe's costs or auto-publish on restoration. Disabling the feature leaves all published menu prices intact. Manual catalog price editing continues to work under its existing permission even without a usable automatic-cost source.

## 2. Cost sources and exact calculation

Require an explicit cost source per target: **DIRECT** or **RECIPE**. Do not silently replace a missing recipe cost with direct cost, sum the two sources, or reuse one size's cost for another size without an explicit supported inheritance rule.

- DIRECT: reuse Product.costPrice as the product-level direct pricing cost where applicable. Label its scope and origin. A scoped variant/branch direct-cost override may be stored in the proposed rule only when explicit; do not copy it into stock costs or replace the global product cost from a branch row. Saving a pricing estimate is not an inventory revaluation.
- RECIPE: use the effective product/variant recipe, explicit appliesToAllVariants semantics, branch ingredient costs, compatible units and existing waste treatment. The inspected costing path rounds ingredient contributions to2 decimals before summing; preserve the approved rule using shared Decimal math for this new pricing path. Do not activate unused six-decimal valuation helpers or refactor historical financial arithmetic.
- Recipe source scope is independent of price target scope: global product/variant prices require an explicit authorized **reference-cost branch** before calculation. For a branch target use that same branch initially. Never pick the first branch, guess cafe-wide average costs or sum branch costs. Persist sourceBranchId separately from the target branch, display it, and bind it plus ingredient identities/versions to the preview fingerprint. For DIRECT, sourceBranchId is null; any scoped direct override is explicitly entered for the price target.
- Reuse strict completeness/confirmation rules. Missing ingredient costs, invalid/incompatible quantities, stale/unverified recipes, inactive ingredients or ambiguous branch mapping cannot become zero-cost ingredients. A structurally computable unverified recipe may show a clearly labeled draft estimate; it is not an eligible automatic publication source until reviewed under existing rules. Do not auto-verify a recipe as a side effect of pricing.
- Resolve ingredients through the reviewed cafe/branch identity mapping, not unscoped name matching or an arbitrary first match. The inspected configurationFinancials/withBranchIngredientCosts implementation must be checked for tenant scope, ambiguity and transaction-aware reads before reuse; do not treat a display helper as a proven publication boundary.
- FINISHED_GOOD reference costs come from their explicit existing stock binding if offered as a separately labeled supported reference source; do not silently substitute one while the user selected RECIPE or DIRECT. No current purchase price is automatically realized historical COGS.
- Cost and supplier/recipe detail visibility require current cost-read authority in addition to menu/price-write authority. Never leak cost columns in JSON, export or DOM to an unauthorized cashier.

Formula: **rawSuggestedPrice = eligibleUnitCost × multiplier**. ×2 means multiply by2, not “add200%” and not “200% margin”. Do not change tax/service treatment: show the configured existing menu-price basis and apply the multiplier on that basis without adding or removing tax twice. Any conversion needed for a different tax-inclusive/exclusive policy requires an explicit compatible contract; do not infer it.

Use money.ts Decimal and canonical decimal strings for new money inputs/outputs, preserving compatible existing API types. Initial multiplier validation is finite, greater than0 and at most100, supporting up to3 decimal places; money inputs/final prices obey existing currency precision/range. Reject NaN, Infinity, invalid signs, excessive precision and overflow. Cost unavailable/nonpositive produces no automatic suggested price; the existing manual price path remains available.

Rounding is optional: NONE, NEAREST or UP to a positive increment, with common choices1,5,10 in cafe currency. NONE is the initial default; the owner may instead type any valid final price. Define NEAREST ties toward positive infinity for nonnegative prices and UP as the mathematical ceiling to the increment. Calculate using Decimal before the final currency normalization; do not round the raw price before finding its increment multiple.

Examples to verify:16.25 ×2 =32.50; UP to5 =35.00; NEAREST to5 at32.50 =35.00; NONE retains32.50; manual final35.00 remains35.00 after multiplier changes until explicitly reset. Do not force a chosen manual price back onto the rounding increment. Show any below-cost or lower-than-target outcome transparently, preserving existing catalog policy rather than adding an invented financial prohibition.

These are current pricing estimates and proposed menu prices, not realized margin or official P&L. Preserve Step2 historical-cost coverage and Step4 accounting gates.

## 3. Real product, variant and branch targets

Reuse Product.basePrice, ProductVariant.price and ProductBranchPrice.price; do not create a parallel live-price table. Use pricing.ts unitPriceExact as the authoritative effective-price contract for POS, server orders and QR.

In the inspected source, variant.price is absolute and a product branch override shifts every variant by (branchBase − globalBase). Consequently, editing one base price can change effective variant/branch prices the owner did not select. Preview the full affected target set and its old/new effective prices before accepting a change. Show prices as stored-field changes and effective customer-facing changes, not only the target field.

For a product with active variants, global/branch base fields are offset anchors rather than a separately sold SKU. They cannot inherit the first/cheapest variant's recipe cost. Initial automatic proposals target the actual global variants with their own eligible costs; base/branch anchors remain explicitly unsupported for cost-derived proposals unless a separate real cost/target contract exists. A product without variants can use its actual base-SKU cost. Existing manual anchor editing still uses the current price editor and a complete affected-price review.

Only publish a selection whose requested prices can actually be represented by the existing price model and whose full effective impact the owner explicitly accepted. A global base/variant change with hidden consequences, or a branch variant price that would require a different offset for each variant, is a conflict/unsupported scope, not permission to overwrite other sizes/branches. Never silently modify protected/unselected target prices to force a fit.

If independent per-branch variant prices are necessary, prepare that exact central pricing-model extension separately and verify every consumer before enabling it; an arbitrary branch-variant target cannot be smuggled into the current one-offset model. Keep the initial tool functional for supported product/global-variant/branch-base targets with clear capabilities and affected-price preview.

New products may calculate a draft before first save, using normal product validation and a stable local draft identity; an unsaved row cannot call a publication endpoint as an existing product. Editing ingredients in the recipe workflow or Step3 bulk import only invalidates suggestions. Actual prices change only through the reviewed price publication action.

## 4. Proposed persistent settings/rule schema — reference only

Validate against current schema before implementation. These are new proposed definitions, not verified/applied migrations. Reuse current CafeSettings, Product, ProductVariant, Branch, User, IdempotencyKey and AuditLog patterns. Add named reverse relation arrays as appropriate; enforce cafe/branch/product/variant consistency server-side and in suitable constraints. Do not introduce a duplicate ledger or persist private preview/customer data unnecessarily.

```prisma
enum MenuPricingCostSource {
  DIRECT
  RECIPE
}

enum MenuPricingRounding {
  NONE
  NEAREST
  UP
}

enum MenuPricingTarget {
  PRODUCT_BASE
  GLOBAL_VARIANT
  BRANCH_BASE
}

model MenuPricingRule {
  id                          String                @id @default(cuid())
  cafeId                      String
  productId                   String
  variantId                   String?
  branchId                    String?
  sourceBranchId              String?
  target                      MenuPricingTarget
  targetKey                   String                @db.VarChar(256)
  costSource                  MenuPricingCostSource
  directCostOverride          Decimal?              @db.Decimal(12, 2)
  multiplier                  Decimal               @db.Decimal(8, 3)
  roundingMode                MenuPricingRounding   @default(NONE)
  roundingStep                Decimal?              @db.Decimal(10, 2)
  manualOverride              Boolean               @default(false)
  lastAppliedPrice            Decimal?              @db.Decimal(10, 2)
  lastAppliedInputFingerprint String?               @db.VarChar(64)
  revision                    Int                   @default(0)
  updatedById                 String
  createdAt                   DateTime              @default(now())
  updatedAt                   DateTime              @updatedAt
  cafe                        Cafe                  @relation(fields: [cafeId], references: [id], onDelete: Restrict)
  product                     Product               @relation(fields: [productId], references: [id], onDelete: Restrict)
  variant                     ProductVariant?       @relation(fields: [variantId], references: [id], onDelete: Restrict)
  branch                      Branch?               @relation("MenuPricingTargetBranch", fields: [branchId], references: [id], onDelete: Restrict)
  sourceBranch                Branch?               @relation("MenuPricingCostBranch", fields: [sourceBranchId], references: [id], onDelete: Restrict)
  updatedBy                   User                  @relation("MenuPricingRuleActor", fields: [updatedById], references: [id], onDelete: Restrict)

  @@unique([cafeId, targetKey])
  @@index([cafeId, productId])
  @@index([cafeId, branchId, manualOverride])
  @@index([cafeId, sourceBranchId])
}
```

Proposed CafeSettings fields: autoPricingEnabled Boolean defaultfalse; autoPricingDefaultMultiplier Decimal(8,3) default2.000; autoPricingRoundingMode MenuPricingRounding defaultNONE; autoPricingRoundingStep Decimal(10,2) nullable. Settings do not publish prices. Initial settings/rule APIs remain owner-only plus current cost/menu/price authority; do not invent new implicit permissions for cashiers.

Server constructs canonical targetKey from target/product/variant/branch IDs, never trusts a client-supplied key. Add exact SQL CHECK constraints for target shape: PRODUCT_BASE has no variant/branch; GLOBAL_VARIANT requires variant/no branch; BRANCH_BASE requires branch/no variant. Constrain multiplier to greater than0 and at most100, nonnegative optional direct cost, and roundingStep absent for NONE/positive for NEAREST or UP. RECIPE requires sourceBranchId and no directCostOverride; DIRECT requires no sourceBranchId. A branch-target RECIPE source must match its target branch in the initial contract. Scope keys plus constraints prevent nullable-unique duplicates. directCostOverride is an explicitly scoped pricing estimate, not a second product/stock-cost source or an automatic copy of Product.costPrice. Add distinct named Branch back-relations for target and source, and verify both belong to the authorized cafe.

Persist manualOverride and last-applied provenance atomically with the relevant price update. Current externally edited catalog price/revision preconditions still need checking; this model alone does not protect against other catalog editors. Ordinary rule/settings saves require expected revision/concurrency checks and transactional audits. A separate publication receipt model is not proposed: reuse IdempotencyKey and audited results.

## 5. Preview, publication and transaction boundaries

Proposed routes, adapted to conventions: GET/PATCH /api/menu-pricing/settings; POST /api/menu-pricing/preview; POST /api/menu-pricing/apply. Proposed UI may extend the menu workspace with a shared component rather than introduce an unrelated page. Use strict Zod schemas, operation allowlists, bounded selections (initial maximum100 target rows), exact values and safe source/target IDs. Reuse compatible current product input types; do not broadly rewrite old APIs.

Preview is read-only: resolve current actor/tenant/branch, settings/rules, products/variants/branch overrides, eligible costs and all affected effective prices under a coherent read snapshot. Return per-row suggestions/errors, current/final price, dependencies, coverage and a server-authenticated preview token/fingerprint bound to actor/scope/inputs/versions/expiry. Do not mark an estimate eligible just because the browser posted a cost. Validate tamper, expiry and selection identity on apply.

Apply receives selected final prices and their stable intent key; manual final values are intentionally allowed to differ from suggestions and rounding. Revalidate their precision/authority/target and every relevant preview precondition, including costs/recipe verification, product/variant/branch prices, policy, settings/rule revision and active state. Define the acceptance read/lock point and compare against the preview there. A changed dependency before acceptance requires refreshed review; later cost changes generate future suggestions rather than rewriting an accepted publication.

Use the existing protected transaction and current canonical price-update helpers with deterministic locking/optimistic concurrency appropriate to their write paths. Review interactions with existing menu PATCH mutations, not just new-route concurrency. The selected bounded batch, rule/manual-override updates, before/after audit including effective impacts, and replayable idempotency outcome commit atomically. Any conflict rolls back that selected batch with actionable row errors. Unselected invalid/unavailable rows are not silently included or changed.

Same intent key and canonical payload replay the same result after a lost response/reload; changed payload with the same key is refused. Do not publish one row twice, duplicate audit effects or create new keys after an uncertain commit. If a large menu requires multiple batches, show per-batch receipts and partial completion honestly instead of claiming whole-menu atomicity.

Target updates must not delete/recreate unrelated variants, stock bindings or other branch prices through the broad existing product-edit payload. Invalidate current menu caches appropriately and reconcile effective server/POS/QR prices. Existing placed orders retain historical item/charge/cost snapshots; carts/orders follow their existing price/revalidation contract. No automatic amendment of open invoices, payment/refund, stock write or accounting entry.

Under planned shared-LAN addition8, catalog pricing writes must obey the branch/coordinator authority contract. Do not permit the cloud pricing tool to become a second live branch writer. Until that integration exists, do not advertise disconnected publication; prepared suggestions can be drafts, not an accepted shared price change.

## 6. Delivery and meaningful acceptance

**9A:** explicit cost sources and target-impact contract, optional settings, exact pure math and editable draft UX. **9B:** preview and selected publication with persistent manual overrides, idempotency, authorization/concurrency and audit. **9C:** POS/QR/variants/branches, recipe-import interaction, owner visual acceptance and exact supported-scope/coverage handoff. No automatic Step3/4/8 execution, live repricing or deployment.

Required evidence on synthetic verified disposable data only:

1. OFF has no pricing effect; ON alone has none. Cost16.25 ×2 proposes32.50, editable final35.00 publishes35.00; manual35 remains after recomputation/refresh/draft recovery until explicit reset. A different deliberately chosen decimal final remains allowed.
2. DIRECT versus RECIPE, explicit override scope, variants/inheritance and branch ingredient identities produce the right cost. Global pricing with two different branch costs requires and uses the chosen reference branch, not an arbitrary branch/average. Cost-derived pricing for a variant offset anchor is refused unless its own supported cost contract exists. Missing/unverified/inactive/ambiguous ingredients cannot become zero. Recipe quantity unit conversion/waste/per-line rounding agrees with reviewed current rules; invalid precision/overflow fail.
3. Multiplier2/3/custom, NONE/NEAREST/UP and increment/tie boundaries use exact expected values. Final manual price is never forced to the rounded suggestion. Cost/reference estimates are not written as historical inventory/COGS.
4. Existing branch overrides and multiple variants expose their full effective impact. An unsupported independent branch-variant target or an unselected/protected sibling change cannot be silently applied. POS, API order pricing, QR and the published menu agree.
5. Cost/recipe/price/policy changes between preview and apply, two publishers, manual edits outside this tool, expired/tampered preview and double/lost-response retries produce safe conflicts or one committed batch/receipt, never partial hidden repricing.
6. Two cafes, branch-restricted users and cashiers prove read/write/cost isolation on routes, details, exports and direct URLs. Old orders/receipts/revisions/payments/stock/accounting retain exact prior values.
7. Recipe save/import, cost updates, disabling/re-enabling, report opening, navigation and app restart never publish prices by themselves. Test mobile/desktop editing, keyboard, loading/error states, selection preservation and real before/after price preview.

Run targeted pure/authorization/runtime checks plus types/lint/build/browser checks proportionate to shared price-write changes. Do not use owner data or provision/restart databases when a target is unavailable; finish independent work and identify the unverified portion. Handoff includes exact source/target/rounding contracts, price-impact examples, manual-override behavior, schema proposal/application status, data-source gaps, batch receipts, tests, preview and rollback using guarded new edits rather than blind historical reset.

Final status: COMPLETE / PARTIALLY COMPLETE / BLOCKED / NEEDS OWNER DECISION. Distinguish documentation, implementation, disposable verification, owner acceptance, actual menu repricing and deployment.
