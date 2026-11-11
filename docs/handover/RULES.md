# Handover workstream rules

## SAFETY
- Test DB (5434) and test server (3100) only. Never write to the owner DB (5433). No destructive SQL without owner approval.
- Never merge or push to main, never deploy. Phase PRs target `handover/integration` and are merged only after the owner writes "approved".
- Never remove or weaken a constraint, guard, permission check or existing test to make something pass.
- Do not touch other worktrees or their uncommitted work. If a change overlaps the finance track (expenses, supplier payments, treasury, advances), stop and tell the owner.
- Before adding a migration, find how this repo allocates migration numbers across worktrees (handover-005 reads `.migration-allocation.json`) and follow it. If unclear, stop and ask.

## ENGINEERING
- Handover already has working code and tests. Verify what exists before building. Change only what the SPEC marks CHANGE or ADD. No rewrites of working modules, no new dependencies, no cosmetic redesign.
- Every money or stock mutation: one transaction, idempotent on duplicate submit, safe against two devices, actor recorded, audit row written. Corrections by reversing entry, never by deleting rows.
- Never auto-retry a financial action whose server outcome is unknown.
- UI: Arabic RTL, phone-first, wording consistent with existing screens.

## TESTING
- Before any run confirm 5434 and 3100 are up. Never run browser checks and a regression run against the same server at the same time.
- Exit code 4 or a dropped connection is an interrupted run: rerun the suites that did not execute. It is neither pass nor fail.
- Known environment guards, not code failures: `acc01b-retained-accounting` (needs DB `cafe_ops_test_finf5`), `handover-005` (needs `.migration-allocation.json`), `integration-002` (needs its own config). Any other failure must be explained with evidence, compared against the unchanged base where needed.
- Report each check as PASS / FAIL / NOT TESTED / BLOCKED. An unrun test is never a pass.

## COMMUNICATION
- The owner is an accountant, not a developer. Explain results and questions in plain language; keep technical detail in the docs.
- Ask the owner only for business decisions, approvals, or destructive actions. Otherwise proceed.
- End every task by updating `docs/handover/STATUS.md` and reporting: CURRENT STATE / FIXED / TESTED / CHANGED FILES / COMMITS / BLOCKERS / REMAINING RISKS.
