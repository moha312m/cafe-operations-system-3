<!-- 2026-10-29-S1-ACCEPTED-WITH-EXCEPTIONS -->
# Stage 1 - TECHNICALLY COMPLETE; ACCEPTED WITH EXPLICIT EXCEPTIONS

**Current status, recorded 2026-10-29 (Africa/Cairo): Stage 1 is TECHNICALLY COMPLETE and ACCEPTED WITH EXPLICIT EXCEPTIONS, based on the retained final technical review** ([report](artifacts/commercial-readiness/2026-10-09-stage1-final-review/REPORT.md): 10 PASS / 0 FAIL / 0 BLOCKED gates, finalized 2026-10-10). Recorded by Claude Code on the owner's explicit 2026-10-29 instruction, which confirms the disposition Codex selected under the owner's earlier delegation that day. Disposition record: [SIGN_OFF.md](artifacts/commercial-readiness/2026-10-10-owner-uat/SIGN_OFF.md).

Exceptions, all still open:
- No human UAT, fresh runtime tests or physical-device/hardware checks are claimed. Unchecked UAT items and blank scenario rows stay unchecked; none is promoted to PASS.
- Production readiness and deployment remain NOT AUTHORIZED / NOT READY.
- The original dated 2026-10-10 report and verdict are preserved unchanged.
- Accountant review and finance decisions D7/D8 remain open gates for any future finance-policy or live-posting change. They are not waived.

Authorized scope: Stage 2 Batch 1 only (inventory transfer and ordinary manual-movement idempotency, protected transactions, transactional audits and client retry-key coverage), in worktree `C:/Users/Acer/.codex/worktrees/stage2-inventory-integration/cafe-operations-system-3` on branch `codex/stage2-inventory-integration` (prepared baseline `bb0dba9812b6a4f3fe05679009abc7b6b74e341b`), per the [Batch 1 handoff](docs/research/2026-10-29-fb-erp/STAGE2-BATCH1-HANDOFF.md). Test writes are allowed only in an already available, positively verified, dedicated disposable test environment, never the owner database or the preserved Stage 1 database. Outside scope: all other Stage 2 modules, Stage 3, production/main-database actions, setup/refresh scripts, package installs, PostgreSQL provisioning/control, migrations/seeds, schema changes, another writer's unfinished handover work, pushes, merges into main and deployment. Preserve the historical Batch 5 evidence below and all owner work.

Additional authorization, 2026-10-29: **Phase 1B Batch A only** — purchase-confirmation transaction reliability. It covers `src/app/api/purchases/[id]/confirm/route.ts` and the new `tests/purchase-004-confirm-transaction.test.ts`, in the same worktree and branch (reviewed baseline `f2d2ceab1a19b19328c2a736d99b27801dc96179`), per the [Batch A handoff](docs/research/2026-10-29-fb-erp/PHASE1B-BATCHA-HANDOFF.md).
- Valuation, input contracts, units, schema, the response and duplicate-confirmation behavior stay unchanged.
- Tests may run only in the existing disposable `cafe_ops_test_stage2b1` on 5442, with the 3150 test server that this batch starts and stops. No PostgreSQL control.
- No staging, commit, push, merge or deployment.
- Phase 1B Batches B and C, other modules and production remain unauthorized. Accountant review and D7/D8 remain open.

Additional authorization, 2026-10-29: **Phase 1B arithmetic preparation only** — two new unused files in the same worktree and branch (reviewed baseline `f2fe6ed3580064227a53043d229b6d6fef1df057`): `src/lib/cost-math.ts` (pure bigint `roundHalf`, `lineTotalCents`, `weightedAverageMicro`) and `tests/cost-001-exact-integer-math.test.ts` (pure test: no database, server or Prisma).
- The module has no production consumers. `money.ts`, `weightedAverageCost`, routes, snapshots, audit serialization, UI, the Prisma schema, migrations and configuration are unchanged. No API contract, precision guard or six-decimal valuation is enabled.
- Approval to apply six-decimal valuation to financial records, the coordinated precision upgrade and its migration, the API contract, and any new `costUnavailableReason` remain open. Accountant review and D7/D8 remain open.
- No staging, commit, push, merge or deployment.

<!-- 2026-10-09-S1-BATCH5-FINAL-CLEANUP -->
## Historical (2026-10-09): Stage 1 Batch 5 - DONE; final Stage 1 review authorized

**Batch 5 DONE at 2026-10-09T15:45:20.617Z; Batches 1-4 DONE retained. Stage 1 OPEN pending the separate final review and owner acceptance; commercial readiness NOT READY.** Fresh supported inventory on Codex In-app Browser id 2 (iab, session 01a1214c-d958-7202-9522-ed72d5e52c01) and MCP Apps id 1 returns zero tabs/errors; the historical owned shifts tab/provider is absent. Inventory scope is the connected Codex surfaces; no disconnected/desktop-wide claim. No denied access retried, close action or workaround used. No hooks installed or introduced.

Fresh native cleanup proof at 2026-10-09T15:43:16.3119127Z: zero exact owned app/controller/worker IDs or matching task runtime commands; application listeners 3102-3105 absent. PostgreSQL remains observed on 127.0.0.1:5434 with the recorded executable/pgdata command; no database access or PostgreSQL control in this cleanup continuation. Retained all-81-table/catalog/identity cleanup PASS applies; no database cleanup or functional tests repeated. Fresh 670-input root/isolated correspondence and retained build z_oATUGlJcFKXZL0Zp8nv verified.

Evidence: [browser inventory](closeout-browser-inventory.json), [native audit](closeout-native-proof.json), [record/source verification](closeout-records-verification.json) under the Batch 5 report directory; prior denied-access and recovery proofs preserved. Retained 135 distinct regressions, 4 HTTP journeys, 15 browser checks and separate Cairo boundary test remain PASS within their recorded scope. Older BLOCKED overlays below are historical. The newly authorized separate Stage 1 review follows this DONE closeout; no Stage 2/3, Git mutation, deployment or commercial signoff.

<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

<!-- BEGIN:working-rules -->
# Working Rules

## Session Start
- Briefly identify the goal and the minimum necessary steps.
- Mention missing information only if it would materially affect the result.
- Then proceed without unnecessary questions.

## Working Rules
- Inspect only files, modules, tests, logs, or documentation relevant to the task.
- Build on previous handoffs, findings, tests, and completed work. Do not repeat completed investigations.
- Search narrowly first; expand only when necessary.
- Make targeted changes and reuse existing project architecture, patterns, utilities, and tests.
- Do not refactor unrelated working code.
- Avoid unnecessary files, scripts, dependencies, reports, or repository-wide scans.
- Ask only when a real business/product decision is required, authorization is needed, or an action could be destructive.

## Verification
- Run the smallest reliable set of checks needed for the change.
- Use targeted tests first.
- Run broader tests/builds only when the change affects shared, high-risk, or cross-module behavior.
- Do not repeatedly rerun expensive checks when relevant source code has not changed.
- For financial, inventory, database, security, authorization, concurrency, migrations, or transactional logic, use stronger verification appropriate to the risk.

## Repository Safety
- Preserve existing owner work and unrelated changes.
- No destructive Git operations unless explicitly authorized.
- No writes to production/main databases unless explicitly authorized.
- Follow all project-specific restrictions in the current handoff.

## End-of-Task Report
1. What you changed or investigated.
2. Files modified.
3. Verification performed and results.
4. Remaining risks, limitations, or owner actions.
5. Final status: COMPLETE, PARTIALLY COMPLETE, BLOCKED, or NEEDS OWNER DECISION.
<!-- END:working-rules -->


<!-- 2026-10-29-PHASE1B-BATCHB-TWO-DECIMAL -->
## Additional authorization, 2026-10-29: Phase 1B Batch B only

The owner declined six-decimal unit costs and authorized two-decimal purchase arithmetic and input hardening, delegating routine implementation choices. Worktree `C:/Users/Acer/.codex/worktrees/stage2-inventory-integration/cafe-operations-system-3`, branch `codex/stage2-inventory-integration`, reviewed baseline `a0620af8c53933616f4a653ce07a531766252070`. Scope: `src/lib/purchases.ts`, purchase create/edit/confirm routes, purchases page, one focused shared purchase-arithmetic helper and focused tests. Preserve Decimal(12,2) costs/totals, Decimal(12,3) quantities, numeric JSON input, response and audit field types, sequential two-decimal weighted averages with ties toward positive infinity, combined-quantity fallback, negative-stock policy, Batch A protected transaction/lock order/DRAFT claim/transactional audits. Reject invalid or over-precise unit costs; normalize quantities and amounts before exact totals; align previews. Keep committed six-decimal helpers unused.

Tests may write only to positively verified existing disposable `cafe_ops_test_stage2b1` on 5442, data directory `C:/Dev/_nextcup_stage2b1/pgdata`, after identity, disposable marker and server/database correspondence checks. Batch B may start/stop its own server on 3150 only; no existing listener may be commandeered. No `.env`, PostgreSQL control, provisioning, schema/migration/seed/package/config changes, new database, dump or restore. Only owned fixtures and reversible test hooks may be created/removed; preserve prior fixtures, receipts and evidence. If unavailable, continue pure checks and report the runtime limitation.

Outside scope: other inventory input paths, manual movements/transfers, retry keys/fingerprints/reconciliation, physical returns, snapshots, recipes, unknown/free representation, accounting posting policy and other modules/batches. No staging, commits, pushes, merges or deployment. Stage 1 exceptions remain; production is NOT AUTHORIZED / NOT READY; accountant review and D7/D8 remain open. See [Batch B handoff](docs/research/2026-10-29-fb-erp/PHASE1B-BATCHB-HANDOFF.md). Earlier authorization records remain historical and are not rewritten.

<!-- 2026-11-08-REGISTER-REPORT-PHASEA -->
## Additional authorization, 2026-11-08: Register Report Phase A only

Authorized by owner plan approval on 2026-11-08: Vendora-style Register Report Phase A (read-only shift/register list enhancements, Register Details modal and API, payment breakdown, closing equation, products sold by SKU and by category per shift, and 80mm thermal print mode) in worktree `C:/Dev/cafe-ops-register-report` on branch `feature/register-report` (baseline `a2a5b44`).
- Read-only reporting only: no schema changes, no migrations, no new payment method enums (Phase B remains out of scope pending owner and accountant decisions D7/D8).
- Tests may run only against pure unit tests or the disposable test database on port 5434, never the owner database on 5433.
- Push to `main` and Railway deployment require separate explicit owner confirmation after local verification.
