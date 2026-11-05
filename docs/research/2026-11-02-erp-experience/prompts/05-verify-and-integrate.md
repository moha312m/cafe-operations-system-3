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
