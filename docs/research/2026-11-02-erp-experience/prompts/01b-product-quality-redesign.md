# Step 1B — NEXT CUP product-quality redesign after owner rejection

Recommended Codex model: **GPT-6.1 Sol**. Thinking: **Extra High**.
Roadmap: verify the existing checkout and preview → establish one workspace system → redesign POS, Sales and Treasury as the reference screens → apply it to the remaining scoped modules → verify populated/error/mobile journeys → deliver comparison screenshots for owner acceptance.

## Task and authority

Implement this correction to Step 1. The owner reviewed the preview and rejected the visual/product result as insufficient. Retain the valid transaction and regression work, and reopen visual acceptance. The screenshots below are evidence of problems, not target designs. Green buttons, small class changes, passing tests and an absence of horizontal overflow are insufficient evidence of the requested redesign.

Pasting this prompt authorizes bounded local application changes, focused tests, task-owned disposable preview/fixtures and explicit local commits for this correction. Routine design and implementation choices within this brief are delegated. Complete a working, reviewable implementation; do not stop after another audit, a component gallery or a static mockup. Preparing this prompt did not itself execute or authorize deployment.

## Starting point and evidence

- Original checkout: `C:/Dev/cafe-operations-system-3`; owner ERP3110/database5433 remain protected.
- Reuse the task checkout `C:/Users/Acer/.codex/worktrees/nextcup-workspace-redesign/cafe-operations-system-3`, branch `codex/nextcup-workspace-redesign-20261102`. Last recorded HEAD: `0513bcd1693b74c011d208df1b0383b18a4c5457`. Verify the current branch, HEAD and dirty files; preserve later owner/agent work instead of resetting to this recorded hash.
- Read the current `AGENTS.md`, `artifacts/erp-experience-20261102/STEP-1-HANDOFF.md`, `final-state-resumed.json`, and the original roadmap `C:/Dev/cafe-operations-system-3/docs/research/2026-11-02-erp-experience/PLAN.ar.md`. The historical completion record is technical evidence, not current owner approval of the design.
- Read `C:/Dev/cafe-operations-system-3/docs/research/2026-11-02-erp-experience/STEP-1B-REVIEW.ar.md`.
- Owner screenshot1: `C:/Users/Acer/AppData/Local/Temp/codex-clipboard-f2eb47e9-5fc0-4a80-98ce-a20f0e5dfdcc.png` (Treasury).
- Owner screenshot2: `C:/Users/Acer/AppData/Local/Temp/codex-clipboard-7bbcd1f7-9c92-4352-8bea-5a19d8944036.png` (POS).
- Open the images through an image-viewing tool. If these temporary files have disappeared, use the retained review and current preview, disclose the missing original images, and continue independent implementation. Do not pretend to have inspected missing images.
- Existing preview: `http://localhost:3113`. Re-prove source/process/database correspondence before authenticated runtime work. Existing disposable database is on5434, `cafe_ops_test_integr20261101_replay_66515e42c85e8ec4`, OID65538, system identifier7693368256609479860, directory `C:/Dev/_nextcup_test_postgres/pgdata`, exact disposable marker and91 completed migration checksums. These recorded values alone are not fresh proof.

## What the evidence establishes

The Treasury screenshot shows a narrow centered workspace, several stacked bordered regions and filter-heavy presentation without a strong information hierarchy. Both captures show small-looking type, a crowded sidebar and an oversized recurring warning relative to the working content. POS is shown without usable populated product content. A screenshot cannot establish whether this last state came from a temporary load, a filter, permissions, tenant identity or genuinely absent products.

Verified source findings: Treasury uses a local `max-w-6xl` centered wrapper and native form/list composition; Sales still uses long document disclosure rows and a large report-period explanation. `useTreasuryData` in `src/components/treasury/treasury-client.tsx` calls the shared `api()` helper, and the inspected fetch in `src/lib/client.ts` has no explicit read deadline/cancellation signal. This can leave a hung GET pending; it does not prove the cause of the captured loading state. Diagnose the actual data path rather than filling an empty screen with invented figures.

First verify application CSS sizes, browser zoom and actual CSS viewport dimensions separately. Do not compensate for screenshots by shrinking the app with CSS zoom, transforms or a reduced root font size.

## Research basis: one transferable capability per reference

These are ten selected references, not a global ranking or proof that NEXT CUP outperforms them. The adaptation and stage assignments are our design decisions. Retain one NEXT CUP identity and the existing financial rules.

| Reference / primary source | Selected documented capability | NEXT CUP use and boundary |
|---|---|---|
| [Foodics](https://help.foodics.com/hc/en-us/articles/7277288986652-Tills-Summary-Report) | Shift-level till transactions and shortage/surplus visibility | Make shift context legible now; implement the agreed shift reporting in Step2. |
| [Toast](https://support.toasttab.com/en/article/Product-Mix-PMIX-Report-Overview) | Product-mix analysis | Use its clear filter-to-results hierarchy; new SKU contribution calculations belong to Step2. |
| [Square](https://squareup.com/help/us/en/article/8114-create-and-manage-device-profiles) | Reusable modes/settings across POS devices | One component language with touch POS and denser management layouts; no new device-management system. |
| [Oracle Simphony](https://docs.oracle.com/en/industries/food-beverage/simphony/19.8/simcg/c_workstation_touchscreen_page_design.htm) | Reusable page templates across workstation platforms | Shared workspace/header/filter/table/form patterns in this correction. |
| [Lightspeed](https://resto-support.lightspeedhq.com/hc/en-us/articles/226404808-Advanced-Reporting) | Customizable report presentation | Readable result tables, available filters and matching exports; no general report builder. |
| [Restaurant365](https://docs.restaurant365.com/docs/gl-types) | GL types group financial statement accounts | Preserve readable financial groupings; posting/P&L decisions remain Step4 and accountant-gated. |
| [ERPNext](https://docs.frappe.io/erpnext/cost-center) | Cost-center analysis across business segments | Keep the existing branch/scope context explicit; no new cost-center schema. |
| [Odoo](https://raw.githubusercontent.com/odoo/documentation/19.0/content/applications/essentials/export_import_data.rst) | Stable-identifier export/edit/import | Make existing recipe exchange discoverable now; improve the exchange workflow in Step3. |
| [Apicbase](https://support.apicbase.com/help/how-to-use-sub-recipes) | Reusable sub-recipes | Retain as a later recipe extension, outside this correction. |
| [MarketMan](https://www.marketman.com/page/actual-vs-theoretical-food-cost-report) | Actual-versus-theoretical consumption/cost comparison | Retain as a later inventory/reporting extension; no fabricated cost/variance dashboard now. |

Use the retained research; do not spend the implementation turn repeating a broad ten-vendor survey. Recheck only a reference needed to settle a concrete unresolved interaction.

## A. Establish one actual workspace system

Improve the existing AppShell, cafe/UI and installed UI primitives rather than adding a parallel shell or unrelated template. Inspect relevant installed Next.js documentation before editing Next.js code. Reuse installed Lucide icons, font assets and dependencies.

Use NEXT CUP green, a dark green navigation surface and warm light neutral working surfaces. Limit ornamental boxes and avoid borders around every paragraph. Define semantic typography, spacing, controls, surfaces, states and density once; consume them across scoped pages.

Proposed design defaults, delegated for refinement after viewing the rendered screens:

- Arabic body/input text16 CSS px; management labels/table cells14–16; metadata12–13 only; page titles26–30. Body line height around1.5. Preserve browser/user font scaling.
- Management inputs/actions at least40–44 CSS px tall; primary POS targets at least48px. Keep keyboard focus visible, adequate contrast, proper labels and status text in addition to color.
- One page heading, a brief description, context controls and one dominant primary action. Place secondary actions consistently.
- Use most of the available management content width, with consistent24–32px desktop gutters and16px mobile gutters. Avoid a narrow form-width page wrapper around report/list workspaces. Forms may remain intentionally narrower in dialogs or dedicated detail pages.
- Use the same field, button, tab, status badge, table, empty/error state and dialog language. POS may use a larger touch density; it must still visibly belong to the same system.
- Sidebar: coherent installed icons, clearly grouped Arabic labels and a compact collapsed option. Show exactly one current leaf item, with an ancestor indicated separately. Preserve feature and permission gating, existing routes and full names through accessible labels/tooltips.
- Condense routine stale-order notices into an actionable compact strip/count with a way to inspect details. Keep urgent operational blockers, financial coverage warnings and unresolved-command notices visible where they affect the action. Do not silently dismiss or conceal them.
- Arabic RTL throughout; isolate numbers, dates, SKU and document identifiers where LTR is appropriate. Long names remain readable. A wide data table may scroll within its container; action controls and the page itself must not be clipped to manufacture an overflow pass.

## B. Redesign the existing tasks, not just the wrappers

### POS `/pos`

Keep order entry fast: clear category selection/search, a stable product grid with legible names/SKU/prices, a current-order area and an obvious total/collection action. Preserve variants, add-ons, item notes, quantities, discounts, service types, table selection and collection modes. Secondary customer/loyalty details can use progressive disclosure without losing values or focus.

On desktop, product selection and the current ticket remain visible together. On compact screens, product and cart views have an explicit switch, an accurate item count and a reachable total/review action; selecting categories must not compress their names into vertical letters. Normal use must not require scrolling past decorative content to reach products or checkout.

Provide distinct states for initial loading, no products configured, no search matches, no active branch, denied access and failed loading. Use an authorized setup action or clear-filter/retry action where applicable. An empty result must not be labeled as a successful populated demo.

### Sales `/sales`

Replace the current wall of document disclosures with a coherent operational sales register using existing results. Default columns: invoice number/time, branch/cashier where permitted, payment status, total, collected and remaining. Expose receipt/details and permitted operations from the selected invoice. On mobile use readable invoice cards or a deliberately scrollable table with reachable actions.

Put date/business-period mode and branch in one compact toolbar. Place cashier, payment method/status and other secondary criteria in a clearly labeled advanced filter panel. Show active filter chips, clear actions, matching result count and existing authoritative totals. Preserve the distinction between invoice totals, recognized sales, collections and returns. Report-period detail/audit explanations remain accessible without dominating the first screen.

Use server-supported pagination/filtering/sorting only. Do not compute a global total from the visible page or pretend that sorting one page sorts the whole result set. Existing CSV/Excel/print output must keep its current snapshot/scope semantics.

### Finance `/finance`, Treasury `/treasury` and existing details

Provide a legible financial work area with consistent navigation and clear task groupings. Within Treasury, make Accounts and Transfers actual peer tabs/views instead of two long filter-heavy panels stacked by default. Preserve direct account/transfer links, `#transfers` behavior and pending document recovery.

Account rows/cards show name, code, type, branch, status and truthful opening/coverage information. Transfer rows show source, destination, amount, channel, status and date, with a working detail path. Use a concise primary filter row and advanced filters when needed. Existing create/edit forms live in accessible dialogs/drawers or focused pages and retain failed inputs.

Show counts/financial summaries only when their source and full scope are available. Unknown opening or unavailable balance is an explicit unknown, never zero or an invented available balance. No decorative revenue/profit/balance charts backed by placeholder data. Preserve actual transfer states and confirmation steps; a draft is not a money movement.

### Reports `/report-center`, `/reports` and existing accounting views

Organize report discovery by business question using the shared layout. Move the unrelated top-of-page link stack into clear report navigation/cards/secondary navigation. Give the existing daily report a concise scope toolbar, existing verified summaries, readable result sections and clear drill-through/export actions.

Reuse current financial statement/ledger/journal pages with a coherent sub-navigation and explicit SHADOW/coverage status. Keep the uninitialized state meaningful. Do not initialize books while rendering a page. New SKU-share and shift-report engines remain Step2; show a report link only when its route actually exists and works.

### Recipes `/recipe-review`, Expenses `/expenses`, Tables `/tables/setup`

Apply the same header/filter/table/detail/form patterns, including existing recipe import preview. Keep existing Excel/CSV exchange behavior and stable identifiers. Make recipe quality, missing cost and required verification obvious without implying that every recipe is financially approved.

Keep operating expense category selection mandatory, with authorized category management separate from expense entry. Preserve the drawer-based scope and existing receipt/refund behavior. Do not change finance posting or claim a complete P&L.

Keep table grid/list, area/search/status, single/bulk creation, edit, active/archive/restore and occupancy/history safeguards. Existing20-character table-number limits and server-side uniqueness remain. Existing locking and transactional audit behavior already has runtime evidence; reuse it.

## C. Reliability is part of the redesign

For scoped read requests, implement explicit idle/loading/success/empty/error/refresh states and a bounded deadline (proposed20 seconds). On timeout, show an Arabic error and a usable retry action. Explain actual failures instead of leaving a permanent loading label. Cancel superseded GETs and ignore late responses by current identity/query/generation. Clear inaccessible data on user/tenant/branch changes; preserve allowed filter/form context during safe refreshes.

Any `AbortSignal`/deadline extension to `src/lib/client.ts` must be opt-in to the appropriate GET/read callers. Do not apply a generic timeout/retry rewrite to financial mutations. An interrupted write can have committed: preserve its original idempotency key/body, pending-command ownership, uncertain-outcome UI and explicit recovery process. Never mint a fresh key or replay a money operation to make the screen appear recovered.

No eager production data prefetch on every sidebar hover. Use existing request boundaries and measure actual ready-server/warm-navigation behavior. Record dev compilation separately from application/API response time. No unsupported claims of instant/offline operation or fabricated performance numbers.

## D. Data contracts, authorization and database boundary

Proposed Prisma models/enums/relations/indexes: **NONE**. Migrations/schema changes: **NONE**. Reuse verified existing `CafeTable`, `TableSession`, `Product`, `Recipe`, `Order`, `Payment`, `MoneyAccount`, `MoneyTransfer`, `MoneyMovement`, `ExpenseCategory`, `OperatingExpense`, `OperatingExpenseReturn` and accounting/journal models. Read their current definitions and existing Zod schemas before modifying callers.

Keep existing API request/response contracts, Decimal arithmetic, quantity/money precision, tenant/branch checks and permission catalog. Do not weaken Zod limits or introduce a second ledger/financial truth. Existing write routes, protected transaction/lock order and business audit boundaries stay intact. A proven read-path defect may receive a narrowly scoped fix with meaningful authorization/race coverage; do not refactor unrelated APIs.

Keep owner3110/5433 running and unchanged. No owner SQL, financial tests/imports, .env changes, PostgreSQL start/stop/provisioning, reset/refresh/global seed scripts, dump/restore, dependency installs/upgrades, push, main merge or deployment. The earlier one-start approval has been consumed; it is not restart authorization.

Use the existing disposable guard/adapters and refresh only this task's reviewed source manifest. Never edit historical guard code or loosen its pins. Do not bypass a browser approval rejection: supply missing source/process/database proof, or report the blocked check while completing independent work.

Reuse retained synthetic fixtures. If populated acceptance requires more variety, this prompt permits bounded tagged additions only in the already verified disposable tenant/branches through the existing guarded fixture mechanism: up to12 additional products,4 categories and8 tables. Reuse existing invoice/account/expense examples and create only the minimum extra owned fixtures needed for a specific missing state. Preserve all existing records, fixture receipts and identity markers. Do not rename the verified cafe/marker, copy owner data, globally seed a database or hardcode demo rows into production components. Preview labels must clearly identify synthetic data.

## E. Execution and evidence

1. Capture the current populated and empty POS/Sales/Treasury states at comparable actual CSS widths/zoom. Identify concrete deficiencies and preserve the baseline in a short checklist. Reuse completed investigations; do not redo integration history.
2. Establish the shared workspace patterns, then implement POS, Sales and Treasury as the three reference screens. Render and inspect them before spreading their patterns. Refine the working screens yourself against this brief; a new design approval is not required for each local iteration.
3. Apply the working patterns to Finance, Reports/Accounting, Recipes, Expenses and Tables. Every visible control must execute an existing authorized task or clearly explain why it is unavailable. Remove no business workflow to simplify a screenshot.
4. Test the actual user journeys below, correct failures and save before/after images and timings. Do not substitute a screenshot of a loading screen for successful acceptance.
5. Commit only scoped reviewed code/tests/docs locally. Leave a verified synthetic preview available and record its source and processes. Stop before Step2.

Required acceptance:

- Inspect POS, Sales, Finance/Treasury, Reports, Recipes, Expenses and Tables at actual measured CSS widths approximately390,820 and1440; include a short laptop height. Record actual values if the browser cannot produce an exact requested width. Keep zoom consistent between comparisons and restore temporary browser overrides.
- Compare information hierarchy, readable Arabic type, contrast, spacing, primary actions, matched controls and meaningful use of screen width. No clipped essential action, vertical category text, lost input or obscured total. Include keyboard/dialog focus, escape/return focus and long Arabic/LTR identifiers.
- Use representative synthetic products/categories and both empty/populated results. Exercise category/search → product/variant → quantity/cart → collection on disposable only. Verify the resulting invoice and exactly one collection, correct total and remaining amount. Retain the receipt; do not claim serving/stock deduction if only payment was exercised.
- Verify invoice search/filter → open details/receipt → correct existing snapshot/export; Treasury account/transfer list → detail → create-dialog open/cancel; a failed table/form submission retains values. Preserve permissions for narrower users and occupied-table refusals.
- Test a forced slow/hung/error GET: a bounded retry state appears, retry recovers, and an older filter/tenant response cannot overwrite the current result. Test finance pending-command/idempotency regressions if shared client code changes. Cancellation of reads must not clear an uncertain write.
- Run installed typecheck, focused lint, relevant component/pure tests and proportionate shared-shell/build verification. Run database mutation tests only after disposable/correspondence proof. Retain prior valid runtime evidence and rerun high-risk cases only when the relevant logic changes. No tests that simply assert literal colors or class names.
- Report ready-server/warm behavior separately from cold dev compilation. No pass claim without recorded observations. No broad claim of superiority to ten vendors based on local screenshots.

Write `artifacts/erp-experience-20261102/STEP-1B-HANDOFF.md`: branch/HEAD, changed files, working routes/tasks, before/after screenshots at comparable dimensions, actual checks/results, remaining limitations, process/database proof, verified preview link and existing synthetic login instructions. Preserve all earlier evidence, including failures.

Report implementation verification and owner visual acceptance separately. Owner visual acceptance remains **PENDING** until the owner reviews the redesigned screens. Passing technical checks must not be described as the owner accepting Step1 or as completion of the entire ERP roadmap. A blocked database/browser check remains unverified rather than passed.

## Remaining roadmap, unchanged

After this correction is reviewed: Step2 SKU contribution and shift reports → Step3 recipe bulk exchange → Step4 operating-expense categories and accountant-approved P&L mapping → Step5 verified integration/activation with the required separate authorization. Optional Step6 remains QR self-service ready alerts. Do not implement those deferred engines, new posting policies, sub-recipes, cost variance or push notifications in this correction.
