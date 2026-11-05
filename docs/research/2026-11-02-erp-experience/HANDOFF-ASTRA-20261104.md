# NEXT CUP ERP — handoff report for GPT-6 Astra (2026-11-04)

Written by Claude (Sonnet 5.5) at the owner's request, after the owner said the current work is accepted. Everything below was checked in this session unless marked **not verified**. Where a fact lives only in a file, the path is given so you can re-read it rather than trust this summary.

## 0. Read first

1. This is **not** the Next.js you know (Next 16). `AGENTS.md` in the worktree says: read `node_modules/next/dist/docs/` before writing code.
2. Worktree: `C:\Users\Acer\.codex\worktrees\nextcup-workspace-redesign\cafe-operations-system-3`, branch `codex/nextcup-workspace-redesign-20261102`, HEAD `203cc48` (committed locally, not pushed). Do not work in the root checkout `C:\Dev\cafe-operations-system-3` except to read/write the docs folder (see §7).
3. **Hard limits still in force** (the owner has never lifted them): no writes to the owner's real database (port 5433), no production or 3110 changes, no push, no merge to main, no deployment, no activation of expense/return posting, no `.env` changes, no acting on the owner's real handover. Disposable database 5434 only.
4. "Accepted by the owner" in this session means: the owner reviewed the current screens (handover workspace/report and, last, the stock-count dialog fix) and said "its accepted". The owner did **not** list scope. See §2 for what that does and does not cover.

## 1. State of the repository

Commits on this branch, newest first:

| Commit | What |
|---|---|
| `203cc48` | Dialog width fix: stock-count/handover detail dialogs `sm:max-w-4xl` |
| `bbbed42` | 4B.2 closeout: mapping guard hardening migration `20261105090000`, group/sub-account creation, edit locks, XLSX/CSV chart export, tests `accounting-012…015` |
| `3ea7c9b` | Step 5: handover journey, branch signing, readiness, activity timeline, XLSX/print report, revised R-A1 |
| `a6fa68b` | 4B.1 read-only chart of accounts + 4B.2 owner account/mapping administration (migration `20261104120000_expense_category_account_mapping`) |
| `184a8ac` | Sales report toolbar compaction |
| `8bc652a`, `9386026` | Step 4A expense workspace + category management |

**Committed after the owner's go-ahead (2026-11-04):** the 4B.2 closeout (`bbbed42`) and the dialog fix (`203cc48`), as two separate commits. Before committing: `tsc` clean, eslint clean on the changed files, `accounting-012…015` 15/15 pass on 5434/3100, `ui-008` and `ui-014` pass. The migration file is LF in the git blob (the working tree shows CRLF); compare checksums against the blob.

**Still uncommitted, the owner's own edits — do not touch, do not stage:** `src/app/globals.css`, `src/components/app-shell.tsx`, `src/components/expenses/expense-workspace.tsx`, `src/components/reports/sales-report-workspace.tsx`, `src/lib/sales-report-server.ts`, `docs/superpowers/plans/2026-11-02-nextcup-workspace.md`.

Untracked noise: `artifacts/erp-experience-20261102/**` (screenshots, logs, scripts) and `.next-integration/`. Not for commit.

### The last fix (this turn)
The stock-count dialog (`StockCountDetail` → `DetailFrame`) was 384px wide on desktop because `DialogContent` in `src/components/ui/dialog.tsx` sets `sm:max-w-sm`, and a bare `max-w-4xl` does not override a `sm:`-prefixed class. The table's left columns were cut off. Fixed in `detail-frame.tsx` (`sm:max-w-4xl`, `sm:max-w-md`). Confirmed: the built CSS contains `.sm\:max-w-4xl` and the DetailFrame chunk uses it. **Not verified by eye**: I did not open the dialog in a browser after the rebuild; the owner's "accepted" came after the rebuild, so treat it as owner-verified.

**Known sibling defect, not fixed:** about 50 other `DialogContent` usages use a bare `max-w-*` (POS shift controls, staff, purchases, inventory, orders, branches, approvals, menu, customers' loyalty, refund dialog and more) and are very likely clamped to 384px at ≥640px the same way. `grep -rn '<DialogContent className="[^"]*max-w-' src` lists them. Options: fix each to `sm:max-w-*` after looking at it on screen, or make the base dialog let `max-w-*` win. The second changes every dialog at once. The owner has not decided.

## 2. Roadmap status (source of truth: `PLAN.ar.md` and the files in §7; the table below is my reading of them)

| Stage | Status | Gate to move on |
|---|---|---|
| 1–3 identity, reports, recipes | delivered earlier | per-part reconciliation at integration |
| 4A expenses workspace | committed | owner visual acceptance (open) |
| 4B.1 chart of accounts (read-only) | committed, owner approved 2026-11-04 | — |
| 4B.2 account admin + mapping | committed in `a6fa68b`; closeout committed in `bbbed42` (hardening, group/sub-account creation, edit locks, XLSX/CSV export) | owner visual acceptance; accountant confirming codes 5400–5450 |
| **Step 5 handover workflow + report** | **committed `3ea7c9b`; owner says accepted** | opening the XLSX in Excel/LibreOffice and a physical-device check were never done (see §4) |
| 4B.3 expense/return journal entries | **blocked** | accountant approval of posting policy; decisions D6, D7, D8 |
| 4B.4 statements and branch analysis | planned | depends on 4B.3 coverage |
| 4B.5 cash and bank reconciliation | planned | — |
| 5 (plan numbering) integration/verification | `prompts/05-verify-and-integrate.md` | — |
| 6–9 QR self-service, owner backups, LAN/offline sync, cost-based pricing | planned, prompts in `prompts/06…09` | each section's own acceptance in `PLAN.ar.md` §11–14 |
| 10A–C design system, 11A–C branches/tasks, 12A–C CRM | planned in `REDESIGN-CRM-TEAM-ROADMAP-20261104.md` | owner approves real mockups first |

`PLAN.ar.md` is **stale on one point**: its header says the 4B.2 closeout prompt "is awaiting a result". The result exists (uncommitted work above). Update that paragraph from the real evidence when you next edit the plan.

Note the plan's own model table suggests GPT-6 Astra for stage 4B (journal mapping/P&L after financial decisions) and Sol for the rest; that is a recommendation in the plan, not something I decided.

## 3. Decisions the owner has made — do not re-ask

- 4B.2 D1–D5 accepted: codes 5400–5450 provisional until the accountant confirms; accounts created by an explicit setup action; mapping is append-only and effective-dated; approval reference mandatory; no re-parenting of accounts with lines in closed periods; no automatic fallback to 5900.
- 4B.2 migration approved and applied to the **disposable** DB only.
- Handover R-A1 reversal approved (2026-11-04, "Let #7 continue"): converting a handover to branch custody re-decides an already-waiting next shift to `AWAITING_OPENING_VERIFICATION` instead of leaving it deadlocked. Audited as `SHIFT_CUSTODY_GATE_REDECIDED`.

## 4. Still open (owner or accountant, not yours to invent)

- **D6** payroll recognition source/basis (needed before posting wages), **D7** actual accounts for credit/bank/wallet flows, **D8** cutover date and opening balances (D8 also bounds mapping `effectiveFrom`).
- Accountant: confirm 5400–5450 numbering; 5460/5495 treatment; statutory treatment.
- Handover: who besides managers may sign for the branch (server requires `handover.accept` + `handover.exception` today); which permission key guards the report export (today `handover.view` + `reports.export`); whether "exempted items" need a real concept (no exempt flag exists; the filter shows *uncounted* lines); whether the place check may run before the stock handover completes in every configuration (server allows it today).
- Never done: the handover XLSX was parsed with SheetJS but not opened in a spreadsheet app (none installed); the print PDF was produced (A4 landscape, 4 pages) but its pages were not rendered to images; no physical-phone testing (375px width was emulated); journeys A, D, F, G, H were covered by server suites, not re-driven by hand in the UI.
- The 4B.2 closeout still has no owner visual acceptance recorded.

## 5. Evidence that exists (so you do not redo it)

All against the disposable database, serially (`--test-concurrency=1`):

- Handover: `handover-023` journey model 7; Step 5 tests inside `handover-010-branch-custody` (needs `HANDOVER_KEEP_FIXTURE=1` only for browser fixtures); `handover-008` 70, `009` 36, `007` 76, `016` 11, `010` 34 (+1 skipped fixture), `010b` 33, `018` 9, `overnight-002` 11, `place-001` 5, `021` 1, `custody-004` 5, `014` 5; UI static suites `ui-001/002/003/004/008/014/016` green after re-pinning.
- Accounting 4B.2: `accounting-007…011` and `012…015` (15/15 re-run before the closeout commit).
- `tsc` clean and `eslint` 0 errors at the Step 5 commit.
- **Known failing, not mine:** `ui-017` (light-theme tokens) fails because of the owner's uncommitted `globals.css` edit. Don't "fix" it by editing the owner's CSS.
- After the dialog width change: `tsc` clean, `ui-008` and `ui-014` pass. The wider `ui-0xx` set and the full handover suites were not re-run for that one-class edit.

## 6. Environment — how to run things here

| Thing | Fact |
|---|---|
| Disposable PG cluster | port **5434**, DB `cafe_ops_test`; start with `node scripts/test-db.mjs up`. It once stopped under memory pressure. Port **5433 is the owner's real data — never write**. |
| Test server | **3100**, `next start` (production build) with `DATABASE_URL=postgresql://postgres@127.0.0.1:5434/cafe_ops_test?schema=public`, any test-only `AUTH_SECRET`, `NODE_ENV=production`. Currently serving build `foR69WzzBICpZPuIDAA7N` (includes the dialog fix and the two small handover fixes). Log: `artifacts/erp-experience-20261102/step4b2/testserver-prod10.log`. Restarting it logs out anyone using it. |
| Build | `NEXT_TELEMETRY_DISABLED=1 NEXT_FONT_GOOGLE_MOCKED_RESPONSES="C:/Dev/cafe-operations-system-3/artifacts/integration-all-approved-20261101/continuation-20261101/cached-font-responses.cjs" node node_modules/next/dist/bin/next build --webpack` (~8–10 min). **Use `--webpack`**: Turbopack panics on this worktree's `node_modules`. |
| Preview 3113 | guarded copy serving `.next-integration` (build `qn1bSUb8Vk_jx3hXNkked`, source sha `dce2b052…`, 93 migrations) via `artifacts/workspace-redesign-20261102/workspace-guard-4b2.mjs` and `private-step5-config.json`. It does **not** include the dialog fix or the 4B.2 closeout; refresh only through the guard, and the guard pins migration count and source manifest, so a new migration needs a reviewed guard change. |
| Test running | `node --import tsx --test --test-concurrency=1 tests/<file>` with `DATABASE_URL` and `TEST_BASE_URL=http://localhost:3100` set. Parallel runs or a cold server time out without being broken. |
| `node_modules` | local overlay (junctions plus a copied `@prisma/client`) so `prisma generate` works here; the engine DLL cannot be replaced while any server holds it. |
| Prisma checksums | raw-byte SHA-256; this worktree is CRLF, production blobs are LF. Compare against LF blobs, not this working tree. |
| Shell traps | PowerShell `Get-CimInstance … -match` over command lines can kill your own shell: filter on `Name='node.exe'` and an exact command-line fragment. Quote `set X=1` in cmd. The first request after a DB restore to 3100 can 500. |
| Browser | built-in pane's hidden state blocks `requestAnimationFrame`, so Suspense pages look stuck; probe before blaming code. |

Memory files with more detail are indexed at `C:\Users\Acer\.claude\projects\C--Dev-cafe-operations-system-3\memory\MEMORY.md` (Claude's own notes; read them if you can access that path).

## 7. Documents (main checkout, untracked, authoritative)

`C:\Dev\cafe-operations-system-3\docs\research\2026-11-02-erp-experience\`

- `PLAN.ar.md` — master roadmap (Arabic), progress table, stages 1–14
- `REDESIGN-CRM-TEAM-ROADMAP-20261104.md` — stages 10–12 (design system, branch/team tasks, CRM)
- `STEP-4B-CHART-REVIEW.md`, `STEP-4B2-DESIGN.md` — accounting design, decisions D1–D8, coverage matrix
- `STEP-5-HANDOVER-WORKFLOW.md` — handover transition matrix, gaps fixed, evidence, open decisions
- `prompts/` — one prompt per stage plus `README.ar.md`

## 8. Suggested order for you

1. Commits are done (see §1). Do not stage the owner's own edits. Branch is local only; pushing/merging needs the owner's explicit say.
2. Decide with the owner whether to fix the ~50 bare `max-w-*` dialogs (§1). Check each on screen at desktop and 375px; don't mass-edit blind.
3. Do not start 4B.3 until the owner delivers the accountant's answers on D6/D7/D8 and the posting policy. Posting stays gated until then.
4. Meanwhile, work that is not blocked: owner acceptance round for 4A/4B.2 screens; spreadsheet-app check of the two XLSX exports; refreshing `PLAN.ar.md` from real evidence; stage 5 integration (`prompts/05-verify-and-integrate.md`) for the independent parts.
5. After the owner approves real mockups, stage 10A (design system) is the largest unblocked product item.

## 9. Rules I followed that you should keep

- Report outcomes as they are: if something was not run or not viewed, say so (this report lists those).
- Server services hold the business rules (`handover.ts`, `custody.ts`, `cash-close.ts`, `opening-readiness.ts`, `overnight-cash.ts`, `place-receipts.ts`, accounting setup/mapping with DB triggers). The UI reads them; do not copy rules into components.
- Idempotency through the shared `withIdempotency`; per-intent keys in the UI; audit events for every state change.
- Blind-count rule: no quantity is ever read from an audit event or shown to a blind counter.
- Disclose mistakes: earlier in this work I copied `schema.prisma` into the shared Prisma client once by hand; that was a mistake, fixed by the local `node_modules` overlay and an official `prisma generate`.
