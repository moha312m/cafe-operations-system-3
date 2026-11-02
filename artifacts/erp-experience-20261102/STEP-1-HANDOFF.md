# Step 1 - verified continuation (2026-11-02)

Current status: **COMPLETE for the authorized local Step 1 scope**. The earlier partial handoff below is preserved as historical evidence. No owner activation, push, main merge, deployment, Step 2, or production-readiness signoff is included.

## Authorization, preview and database

The owner explicitly approved one start of the existing disposable cluster and completion of Step 1. PostgreSQL on5434 was started once from `C:/Dev/_nextcup_test_postgres/pgdata`; its postmaster is18820. It remains running. No reset, provisioning, migration, seed, dump/restore or owner-database operation was performed.

The exact disposable identity remains system7693368256609479860, database `cafe_ops_test_integr20261101_replay_66515e42c85e8ec4`, OID65538, the exact disposable marker, and91 completed checksummed migrations. The historical guard/config/source pins are unchanged. The task-only source manifest now contains947 files, SHA256 `2f97888756e1f4ea679105d3f53bdbc1e2c671c291b983bd5c69791d58ef6c23`.

**Verified preview: http://localhost:3113/tables/setup** (Finance: http://localhost:3113/finance). Parent15088/child22276 serve this exact checkout and disposable database. Actual public-menu nonce/SQL correspondence passed again after the final UI fix (`correspondence.json`). The task-created IAB tab2 is retained for the owner; owner tab1 on3110 was not operated.

Synthetic login only: `workspace20261102-1949053d4248-owner@example.invalid`, test-only password `workspace-retained-synthetic-only-20261102`. Never use owner credentials or change passwords.

## Changes during this continuation

- `tests/experience-step1-tables.test.ts`: warm the owned PATCH route before measuring lock queues; keep race table identifiers within the existing20-character limit; validate the positively verified `wr_` synthetic ID namespace before test-hook SQL. No lock assertion, rollback assertion or historical guard was relaxed.
- `src/components/pos/category-tabs.tsx`: give the selected-category label a full row on small phones. Browser acceptance exposed its former collapse between two fixed-width buttons. This is one responsive class change; product selection, permissions and payment logic remain unchanged.
- This handoff and `STEP-1-PLAN.md`: record completed acceptance. Operational logs and receipts remain local.

## Fresh verification

| Check | Actual result |
|---|---|
| Guarded table/sales runtime | **9 TAP tests passed,0 failed,0 skipped** (7 leaf cases plus2 parent tests). `runtime-resume-20261102T173200.log` |
| New cases | Rename/session serialization in both real PostgreSQL queue orders; forced create/edit/archive/restore/bulk audit failure rolls back effects and audit rows. |
| Existing cases | Duplicate/nullable/bulk/branch/history; occupied-table refusals; revoked/tenant/branch/permission denials; archive/session races both orders; payment filter and snapshot/export consistency. |
| Hook cleanup | Zero `step1_audit_` triggers and functions left. `runtime-closeout.json` |
| Focused cashier tests after responsive fix | **10 passed,0 failed,0 skipped**. These overlap the retained51 pure tests; do not add the counts as distinct tests. `cashier-mobile-fix.log` |
| Final focused ESLint | Exit0, no diagnostics, both changed source/test files. `lint-resume-final.log` |
| Final TypeScript | Installed `tsc --project tsconfig.integration.json --noEmit --incremental false`: exit0. `types-resume-final.log` |
| Whitespace/source review | `git diff --check` passed; continuation changes only the two files named above plus handoff/plan. |
| Retained prior verification |51 pure/static passes and stylesheet compilation remain historical passes; unchanged suites were not needlessly rerun. |

The initial resumed runtime run failed because its test identifiers exceeded the production Zod limit and its fixture-ID assertion excluded the verified underscore namespace. Those failures and earlier logs remain retained. The corrected guarded rerun above passed. Expected intentional audit-failure errors in the preview log belong to the rollback test.

## Browser acceptance and retained evidence

Sales, Finance, Treasury, Expenses, Daily reports, Recipes, Tables and POS were inspected at representative mobile/tablet/desktop widths. Measured CSS widths were389,820 and1440; the phone case is a slightly narrower representative of390, not a claim of exactly390. Temporary viewport and CDP metrics overrides were cleared. No page-level horizontal overflow was observed; wide data tables retain their own horizontal scrolling.

Verified table creation/search, a long identifier in grid/list, overlength failure retaining all values, edit-dialog initial focus, Shift+Tab containment, Escape close, archive and inactive restore. Opened/dismissed finance and expense dialogs without creating accounts or posting expenses. UNKNOWN balances, unavailable recipe costs and SHADOW/uninitialized accounting remain explicit.

A synthetic12.50 EGP takeaway was entered through the POS UI. Invoice25 (`cmvzffc2a004vhl6spottt21m`) has one confirmed CASH collection12.50, remaining0 and its original shift. UI sales detail and a guarded read both agree. It remains CONFIRMED, not SERVED; no stock-deduction or kitchen-lifecycle acceptance is claimed. Its receipts and all earlier fixtures are retained. One product/category/recipe fixture was added to this owned synthetic cafe solely for the POS test (`ui-product-fixture.json`); no existing stock balance was overwritten. A second mobile cart was exercised and cleared before submission.

Screenshots, browser acceptance and owner process proof:
`C:/Dev/cafe-operations-system-3/artifacts/erp-experience-20261102/test-db-recovery/`
(`browser-acceptance.json`, `step1-preview-final.jpg`, `pos-mobile-fixed.jpg`, `pos-tablet-fixed.jpg`, page screenshots, `owner-closeout.json`, one-start authorization/receipt).

Cold compilation caused some browser navigation timeouts; subsequent page states were verified. One browser-tool reset occurred and saved evidence was retained. This was not an approval denial or a reason to switch browser surfaces. The earlier approval rejection's missing correspondence condition was resolved before opening this preview.

## Preservation and limits

Fresh checks preserved all921 original source pins, AGENTS, historical SQL, owner utilities, original tracked changes/index/HEAD/main (`preservation-resume.json`). Owner PostgreSQL17800 and ERP25068 retain the exact recorded executable/command/creation milliseconds; original login3110 returns200. No owner SQL query or business write occurred.

No production build, physical-device/hardware test or human UAT is claimed. Stage1 exceptions, accountant review and D7/D8 remain open; production remains NOT AUTHORIZED / NOT READY. Keep3113/5434 available for synthetic preview. Do not restart PostgreSQL again under this one-start approval. Stop after Step1; Step2 requires its own implementation instruction.

---

# Historical handoff before the approved recovery

# NEXT CUP — Step 1 handoff

Date: 2026-11-02 (Africa/Cairo). Final status: **PARTIALLY COMPLETE**. Source implementation, independent review, local source commit and static/pure checks are complete. Current browser/POS and database mutation acceptance remain open.

## Checkout and source

- Worktree: `C:/Users/Acer/.codex/worktrees/nextcup-workspace-redesign/cafe-operations-system-3`.
- Branch: `codex/nextcup-workspace-redesign-20261102`.
- Implementation HEAD captured for this handoff: `c4bd90f3ac457294d4e3477238e2912c1e56361e`. The subsequent documentation commit adds only this handoff and its plan; identify it with `git log -1 --format=%H -- artifacts/erp-experience-20261102/STEP-1-HANDOFF.md`.
- Baseline/upstream: `f4ff365c472f55fca101250bc4ed897f8175b4d6`, checked equal before changes. Reused the existing task worktree and preserved its completed work and evidence. No reintegration, reset or push.
- Original checkout remains HEAD `7c4e1ae936dc3f508778c9a55626da1f79224450`; main remains `5314becf8a26385c2ada7e2993293e7188904142`.

## Delivered behavior and contracts

- Existing UI primitives now supply native finance field/action styles, including focus/disabled/invalid treatment. Sales uses a compact field variant; expense and treasury primary actions use the actual primary variant.
- Shared headers, state announcements, semantic sage/tide/caramel/clay accents, a green dark theme, and existing recipe preview Table primitives align the workspaces. Recipe import behavior is unchanged.
- Table management retains grid/list, search, creation/bulk, editing, areas/seats/sort, activation/archive/restore. Filters wrap, selected modes are announced, keyboard focus is visible, icons use the existing Lucide library, and long identifiers have constrained RTL/LTR presentation.
- Reused the baseline protected table mutations: Branch parent lock before effects; locked re-read; occupied rename/deactivate/archive refusal; same lock for session attachment/transfer; same-transaction business audits. No production backend/table contract change was necessary. Existing duplicate/scope/permission/history rules and custom legacy table numbers remain.
- Added an opt-in runtime suite for both rename/session queue orders and forced create/edit/archive/restore/bulk audit rollback. It requires the unchanged historical guard, exact Step 1 source pins, verified disposable identity and actual HTTP/database correspondence. Reversible uniquely named audit hooks are restricted to owned tagged synthetic records and removed in finally. **These cases have not run.**
- Decimal arithmetic, UNKNOWN/LIMITED/SHADOW states, finance opening/posting restrictions, pending-command payloads/keys, schema, permissions and API contracts remain. No SKU/shift-report, new recipe-import or expense/P&L policy work.

## Files modified

- `src/app/(app)/reports/page.tsx`
- `src/app/(app)/tables/setup/page.tsx`
- `src/app/globals.css`
- `src/components/accounting/accounting-shell.tsx`
- `src/components/cafe/ui.tsx`
- `src/components/expenses/expense-workspace.tsx`
- `src/components/recipe-import/recipe-exchange.tsx`
- `src/components/sales/reporting-controls.tsx`
- `src/components/sales/sales-workspace.tsx`
- `src/components/treasury/treasury-client.tsx`
- `src/components/treasury/treasury-details.tsx`
- `src/components/treasury/treasury-workspace.tsx`
- `src/components/ui/button.tsx`
- `src/components/ui/input.tsx`
- `tests/experience-step1-tables.test.ts`

This handoff and `STEP-1-PLAN.md` are the only additional committed documents. Operational manifests, logs and guarded resume adapters remain locally under this artifact directory; private configuration stays locally ignored in the existing workspace artifact directory.

## Actual checks

| Check | Result / evidence |
|---|---|
| Installed `tsc --project tsconfig.integration.json --noEmit --incremental false` | Exit 0, all native source/tests included; `types-commit.log`, `commit-checks.json` |
| Installed ESLint on the exact changed TS/TSX files | Exit 0, 0 errors/warnings; `lint-code-final.log`, final test-only `lint-runtime-final.log`. Earlier lint including CSS emitted one unsupported-file warning; CSS is checked separately. |
| `node --import tsx --test --test-concurrency=1` on workspace pure suites, treasury/expense intents, cashier component, Arabic and new opt-in suite | **51 pass / 0 fail / 1 skipped**; `pure-final.log`. Explicit unreachable datasource `127.0.0.1:1`; skipped case is the database suite, not a runtime success. |
| Installed Tailwind/PostCSS compile of `src/app/globals.css` | Exit 0, 145628 output bytes, zero warnings; `css.log`, `theme-compiled.css` |
| Changed-source Arabic placeholder scan, retained historical guard hash, diff whitespace | PASS; `verification-summary.json`; final staged source diff check also passed |
| Independent read-only review | No production table-lock/audit defect. Fixed discount overflow, conflicting primary styles and race-test promise/startup cleanup. No deferred findings. Runtime remains unverified. |
| Owner preservation | All 921 source pins, original AGENTS, 89 historical SQL files and owner utilities match retained hashes; original tracked dirty paths/index/HEAD/main preserved. `preservation.json` |
| Owner process identity and login GET | Exact PIDs17800/25068 executable/command/creation preserved; login HTTP200. `owner-processes-final.json`, `owner-login-final.json`. No owner SQL query or business write. |

Pure files: `workspace-sales-tables`, `workspace-001-statements`, `workspace-002-treasury-filters`, `workspace-003-export-safety`, `workspace-report-center`, `treasury-002-intent`, `expenses-005-pending-intent`, `cashier-touch`, `ui-004-readable-arabic`, plus skipped `experience-step1-tables` (all under tests with their existing .test.ts/.tsx suffixes). Logs use Windows PowerShell UTF-16LE; the verification reader decodes them without altering the originals.

## Runtime, preview and ownership

Initial read-only disposable proof passed: `cafe_ops_test_integr20261101_replay_66515e42c85e8ec4`, host127.0.0.1, port5434, directory `C:/Dev/_nextcup_test_postgres/pgdata`, system identifier7693368256609479860, OID65538, exact disposable marker and 91 completed migration checksums. Evidence: `disposable-proof.json`.

The retained 3113 preview timed out. Restarting it used the retained task process identities. That first restart command encountered legacy `/Date(...)` parsing errors; the preceding independent native observation had matched its exact identities. The subsequent preview cleanup used fail-closed millisecond timestamp/executable/command/parent assertions. No owner process or PostgreSQL process was stopped.

The newly launched preview parent19988/child3412 was never promoted beyond SPAWNED_UNVERIFIED: disposable5434 subsequently refused connections and its recorded process was absent. Cause of that external disappearance is unknown. Both new preview processes were stopped by exact identity. See `process-closeout.json`; no active verified task preview remains.

**No verified disposable preview URL can currently be delivered.** Intended URL after guarded recovery: `http://localhost:3113/finance`; it is not a current runtime-success claim. Automatic browser approval rejected opening3113 because the new process lacked required correspondence proof. No alternate browser surface, bypass or owner-database fallback was used.

No fresh desktop/tablet/mobile visual, RTL overflow, dialog keyboard/focus, form-error retention, live POS entry, table duplicate/scope/occupied/history, real races or audit rollback is claimed. Earlier f4ff365 evidence remains historical. A production build was not run.

## Exact setup request and resume sequence

Owner action needed: make the **existing dedicated disposable cluster** at `C:/Dev/_nextcup_test_postgres/pgdata` on127.0.0.1:5434 available again, preserving the database/name/OID/system identifier/marker/migration checksums and all retained synthetic receipts above. If agent control is desired, explicitly authorize a bounded start of this existing cluster; this step itself forbids PostgreSQL control. No new database, reset, refresh, seed, replay, dump/restore, owner5433 access or dependency install is requested.

From this worktree, using installed executables only:

1. `node --import tsx artifacts/erp-experience-20261102/refresh-source.mjs` — binds reviewed current files to a new task-only manifest/config; historical guard/config/pins stay unchanged.
2. `node --import tsx artifacts/erp-experience-20261102/start-preview.mjs` — positively verifies disposable identity and refuses an occupied3113; retain its exact new process receipt.
3. `node --import tsx artifacts/erp-experience-20261102/verify-preview.mjs` — requires successful live SQL identity plus public-menu nonce correspondence; stop if it fails.
4. Only after successful proof: `node --import tsx artifacts/erp-experience-20261102/run-runtime.mjs` — runs existing duplicate/scope/occupied/archive/session tests and new rename/rollback tests serially. Retain financial evidence and fixture receipts. Record any hook-cleanup failure before further work.
5. Open the verified preview, use the retained synthetic owner (`workspace20261102-1949053d4248-owner@example.invalid`, test-only password `workspace-retained-synthetic-only-20261102`), and verify 390/820/1440 CSS widths, long table identifiers, keyboard/dialog focus, failed-form value retention, and an ordinary synthetic POS journey. These are disposable credentials; never use owner credentials or reset them.

Until those checks pass, Step 1 remains PARTIALLY COMPLETE. Stop after Step 1. No Step 2 starts automatically. No installs, .env changes, PostgreSQL control, schema/migrations/seeds, owner-data writes, push, main merge or deployment occurred. Stage 1 exceptions, accountant review and D7/D8 remain open; production remains NOT AUTHORIZED / NOT READY.
