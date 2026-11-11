# Handover workstream status

Integration branch: `handover/integration` (worktree `C:/Dev/cafe-ops-handover-integration`), created 2026-11-11 from `fix/handover-s1-guards` (30c40cc) because PR #5 is not yet merged. All phase branches start here and their PRs target this branch, never `main`.

| Phase | Branch | PR | State | Tests run | Open blockers |
|---|---|---|---|---|---|
| Setup (rules + status docs) | handover/integration | none yet | Committed locally, not pushed | None (docs only) | None |
| S1 dead-end fixes | fix/handover-s1-guards | #5 (into main) | Open, not merged | Not re-run in this task | Owner decision: let it stay as the base of this branch, or merge it to main first |
| Count-variance books sheet | feat/count-variance-books-sheet | none yet | Owner browser-tested. Committed 92fb794; PR #5 merged in c4bc4f4 (stock-count screen keeps both behaviours) | count-variance-books PASS 3/3 on 5434 (server 3101). Wider count/handover/accounting run INTERRUPTED (server stopped mid-run); its partial failures (count-002, count-008, handover-001/002/003/004/005) not yet compared to base — NOT TESTED | Owner: PR target (main or handover/integration); rerun wider suites |
| P1 shift-open custody block | handover/p1-shift-open-custody (worktree C:/Dev/cafe-ops-handover-p1) | none yet | Part 1 done: opening warning now predicts what the open will do (`predictOpeningBlocker`). Recovery for stuck branches waits on owner decisions | On 5434, server 3102 (this tree): handover-p1-opening-preview 3/3 PASS; shift-opening-custody-lifecycle, custody-001..007, shift-004/005/006, handover-010, shift-carryforward-002 PASS (133 pass, 1 known skip). pos-conc-005 FAIL 4/4 on base and on P1 alike: the shared demo branch on 5434 is itself in the stuck state (D1a) | Owner decisions Q1–Q3 (see AUDIT D1); repairing the 5434 demo branch needs a DB write (approval) |
| Audit (read-only) | handover/integration | none | docs/handover/AUDIT.md written | None (code reading only) | Owner's problem statement still blank; findings D1–D6 to prioritise |

## Notes
- Migration numbering: `.migration-allocation.json` only indexes M12–M22 (created by `scripts/migration-preflight.mjs`, which targets `seif-work`). Migrations after those (latest here: `20261106131000_finance_currency_follows_cafe`) are plain timestamps with no allocation file in this tree. The file is not committed in this worktree; handover-005 will report BLOCKED here. Rule for new migrations is unresolved: ask the owner before adding one.
