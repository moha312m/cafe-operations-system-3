# Step 1 implementation plan

Goal: finish the accepted shared NEXT CUP identity and safe dining-table management in this existing isolated checkout.
Architecture: reuse cafe/ui and ui primitives, semantic theme tokens, existing protected Branch locking and transactional audits. No schema, finance policy or API contract changes.
Baseline: f4ff365c472f55fca101250bc4ed897f8175b4d6, codex/nextcup-workspace-redesign-20261102; upstream same commit, clean tracked source. Preserve existing untracked handoff and runtime evidence. Owner checkout remains 7c4e1ae with its existing dirty files.

- [x] Consolidate native finance fields/actions using existing UI styles; apply shared headers/states and semantic tones to Sales, Finance, Reports, Recipes and Tables. Fix table filter wrapping, readable identifiers and visible field labels. Keep touch POS and all money behavior.
- [x] Prepare guarded table runtime checks with rename/session serialization and forced transactional audit rollback. Reuse existing duplicate/scope/occupied/archive/history cases; preserve all old guard pins. Pure checks, strict types and focused lint pass; live mutation cases remain NOT RUN.
- [x] Verify disposable identity and fresh HTTP/database correspondence, restart only exactly identified retained task preview if unhealthy. Browser-check representative widths, RTL, dialogs/focus/error retention and POS on disposable only. Run new mutation checks only after guard succeeds.
- [x] Fresh whole-branch review, targeted fixes, local commit and STEP-1-HANDOFF.md with evidence and remaining gaps. Stop before Step 2.

Review focus: failed forms retain values; pending money commands retain keys; small-screen filter/identifier overflow; branch/scope and stale table reload under lock; audit failure rolls back business changes. No tests of literal colors/classes.

Ruling: reuse the existing published task worktree without resetting or replaying its completed changes. New commits are local only. The accepted roadmap and explicit instruction to execute supersede skill design/plan approval pauses.

Review: fresh independent reviewer found no production table safety defect. Fixed conflicting primary/outline variants, discount control overflow, and race-test startup/promise cleanup. Corrected two encoding defects before final checks.

Ruling: runtime/browser verification is deferred because the dedicated disposable server on5434 became unavailable after initial read-only identity proof. Do not control PostgreSQL or use owner5433. Cost: no current browser/POS or mutation/concurrency/audit-rollback acceptance.


Authorized continuation, 2026-11-02: owner approved one bounded start of the existing5434 cluster. Fresh correspondence and guarded runtime passed (9 TAP tests / 7 leaf cases). Browser/POS acceptance passed at measured389/820/1440 CSS pixels. Fixed the existing mobile category-label collapse and reran10 cashier tests, focused lint and complete typecheck. Original921 source pins and owner processes preserved. Earlier deferral above is historical and resolved for this local Step1 scope. See the current continuation at the top of STEP-1-HANDOFF.md. Stop before Step2.
