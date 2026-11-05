# NEXT CUP — project context and roadmap for Argon

Updated 2026-11-04, Africa/Cairo. Read this first, then the current task prompt. Older roadmap entries are historical. Reported verification is distinguished from independent inspection.

## Product and workspace

NEXT CUP is an Arabic RTL café/restaurant ERP covering POS, table/QR service, shifts and handovers, recipes, inventory, purchasing, expenses, treasury, accounting and reports. The owner wants consistent, readable interfaces and reliable multi-branch operation.

Implementation worktree: `C:/Users/Acer/.codex/worktrees/nextcup-workspace-redesign/cafe-operations-system-3`.
Branch: `codex/nextcup-workspace-redesign-20261102`.
Canonical planning docs: `C:/Dev/cafe-operations-system-3/docs/research/2026-11-02-erp-experience/`.

Read applicable local instructions and installed Next.js guides. Reuse the existing architecture, permissions, transaction locks, exact money/unit calculations, audit and idempotency. Inspect current HEAD and changes before starting.

Independently observed Git history in this review:
- `203cc48` — desktop dialog width correction.
- `bbbed42` — accounting 4B.2 closeout, mapping hardening and chart editing/export.
- `3ea7c9b` — handover journey/report.
- Earlier `a6fa68b` — chart view and initial account/mapping administration.

The newest direct-handover/cash-disposition implementation remains uncommitted. Its three migration files and new direct-handover test were observed untracked. Preserve all existing work, including owner modifications to globals.css, app-shell.tsx, expense-workspace.tsx, sales-report-workspace.tsx and sales-report-server.ts.

## Approved direct handover behaviour

Outgoing staff enter closing payment amounts and required ingredient counts once, allocate counted physical cash and submit a closing summary. Incoming staff review and press “فتح ورديتي واستلام العهدة” once, accepting the physical handover. This records acknowledgement without inventing independent counts. Existing applicable place/equipment requirements still govern operational readiness.

Physical cash may be retained in the drawer or declared delivered to a named owner/manager, including split allocations. Example: 3,000 counted, 2,000 to owner, 500 to manager, 500 retained. Incoming opening cash is exactly 500. Electronic payments remain payment reconciliation data. Allocations reconcile to counted cash; expected-versus-counted discrepancy is separate.

Named recipients confirm their deliveries themselves. Pending confirmation remains a traceable obligation and does not block the incoming employee's retained-cash acceptance. Delivery disputes and handover issues retain history. Branch custody/overnight handover keeps its applicable opening verification. No automatic financial posting or interpretation of owner receipt as drawings.

## Current evidence and limitations

Latest report: `C:/Users/Acer/.codex/attachments/cca5df08-8f81-48ad-905c-297b65637cc2/Pasted text.txt`.
Prior partial report: `C:/Users/Acer/.codex/attachments/ac295acf-67ed-457c-b45e-c873ea853766/Pasted text.txt`.

Latest Argon report claims official Prisma generation, three disposable-only migrations, 34 direct tests and 291 regressions/checks passing, browser journeys, production build and screenshots. A fixture test was intentionally skipped in a regression suite. These checks were not rerun in this roadmap review.

Observed files exist under worktree `artifacts/erp-experience-20261102/direct-handover/`, including verification-summary.json, desktop/mobile screenshots, handover-report.html, .pdf and .xlsx. Presence alone does not verify their content or final-source correspondence.

Three migration directories reported and observed:
- 20261106090000_direct_handover_cash_disposition
- 20261106100000_handover_issue
- 20261106110000_handover_direct_flag

The report says 96 migrations are applied to disposable cafe_ops_test on 5434. Confirm from actual identity and migration records when testing. It says the 3160 task server was stopped and 3113 remains older. The named `scripts/preview-server-3113.mjs` could not be found in either checkout's scripts directory during this review. Discover the real launch/guard chain and preserve identity/source/checksum verification.

XLSX was parsed programmatically; desktop application inspection remains open. HTML screenshots are reported, but PDF page rendering/inspection is not established. Physical mobile testing remains open. The final build reportedly happened after browser verification, so correlate source and build evidence before declaring final-source runtime acceptance.

## Complete roadmap

| Stage | Purpose | Current position / next evidence |
|---|---|---|
| 1 | Unified identity and café tables | Previously delivered; reconcile acceptance and later local changes during integration |
| 2 | Sales/report hierarchy, SKU contribution, shifts, payments and readable exports | Previously delivered; preserve calculation/date/export fixes. 2D sales extensions remain separate backlog |
| 3 | Recipe/BOM import/export | 12-slot ingredient workbook delivered; preserve reference validation, units and retry safety |
| 4A | Categorized operating expenses | Delivered; compact list remains a local owner change; visual acceptance tracked separately |
| 4B.1–2 | Chart view, main/subaccounts, editing, effective mapping, XLSX/CSV | Saved through bbbed42; final owner acceptance/account-code review distinct |
| 4B.3 | Expense and return posting | Gated on accountant approval and D6/D7/D8 |
| 4B.4 | Statements and branch analysis | Planned; COGS/report classification and posting coverage required |
| 4B.5 | Cash/bank reconciliation | Planned; design and acceptance remain separate |
| 5 | Core integration and operational acceptance | Handover/report committed earlier; direct-handover extension local, awaiting final closeout and owner review. Entire stage is not closed |
| 6 | Optional self-service QR readiness alert | Planned; in-page alert and supported background notification, customer acknowledgement |
| 7 | Owner-device backups | Planned; manual plus optional daily/weekly while ERP is open, independent recovery verification |
| 8 | LAN operation and cloud synchronization | Planned; cashier, kitchen and QR share a local venue service during internet outage |
| 9 | Optional cost-based menu pricing | Planned; direct/recipe cost ×2, ×3 or custom, editable final prices and explicit publication |
| 10A | Visual design prototypes | Next independent design milestone after handover closeout; prototypes are presented for approval |
| 10B–C | Shared design components and incremental rollout | After accepted prototypes; populated runtime evidence per module |
| 11A–C | Branch/staff assignments, recurring checklists, evidence and review | Planned; employee submits, manager approves; overdue and blocked work traceable |
| 12A–C | CRM, customer history, complaints and follow-up | Planned; reuse Customer and link follow-up tasks, enforce privacy and branch scope |

The owner’s five visual references inform soft light cards, compact tables, restrained colour, clear status chips and mobile shortcuts. Dark module boxes remain in the sidebar. Arabic body text should remain readable; summary cards and compact transaction rows serve different purposes. See REDESIGN-CRM-TEAM-ROADMAP-20261104.md for the complete reference mapping and acceptance criteria.

Additional coverage proposals include maintenance tickets, operating procedures/onboarding and a shared action inbox. Inspect existing features before introducing new models. Attendance/leave, loyalty campaigns and integrations are separate optional scope.

## Open policy decisions and boundaries

D6: payroll recognition source/basis. D7: actual accounts for credit/bank/wallet flows. D8: cutover date/opening balances. Accountant confirmation of proposed account codes and reporting classification remains required. Preserve these decisions explicitly.

Owner database 5433 and application 3110 are outside disposable-test changes. No production writes, push, main merge, deployment or posting activation is authorized by the closeout prompt. New runtime actions require verified service ownership and applicable authorization. Do not infer permission from a script path or port number.

## Next sequence

1. Reconcile final direct-handover source, evidence and actual preview guard.
2. Provide an accurate, usable disposable review environment and complete outstanding report checks.
3. Owner reviews the simplified flow; prepare a precise separate commit scope.
4. Proceed to 10A prototype work when requested. Continue financial work only within its relevant decision gates.

Do not start all roadmap stages from this context document. The task prompt determines the current authorized scope.
