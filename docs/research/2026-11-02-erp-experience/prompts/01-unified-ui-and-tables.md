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
