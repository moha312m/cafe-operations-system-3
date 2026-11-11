# Handover workstream status

Integration branch: `handover/integration` (worktree `C:/Dev/cafe-ops-handover-integration`), created 2026-11-11 from `fix/handover-s1-guards` (30c40cc) because PR #5 is not yet merged. All phase branches start here and their PRs target this branch, never `main`.

| Phase | Branch | PR | State | Tests run | Open blockers |
|---|---|---|---|---|---|
| Setup (rules + status docs) | handover/integration | none yet | Committed locally, not pushed | None (docs only) | None |
| S1 dead-end fixes | fix/handover-s1-guards | #5 (into main) | Open, not merged | Not re-run in this task | Owner decision: let it stay as the base of this branch, or merge it to main first |
| Count-variance books sheet | feat/count-variance-books-sheet | none | Uncommitted, untouched (6 modified files + new files in its worktree) | Not run | Owner must confirm browser test of the count-variance buttons; then conflict with PR #5 in stock-count screen to resolve |

## Notes
- Migration numbering: `.migration-allocation.json` only indexes M12–M22 (created by `scripts/migration-preflight.mjs`, which targets `seif-work`). Migrations after those (latest here: `20261106131000_finance_currency_follows_cafe`) are plain timestamps with no allocation file in this tree. The file is not committed in this worktree; handover-005 will report BLOCKED here. Rule for new migrations is unresolved: ask the owner before adding one.
