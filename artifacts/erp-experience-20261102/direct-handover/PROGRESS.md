# Direct handover continuation — progress (Africa/Cairo)

Owner choice 2026-11-05: implementation A (this tree) continues; B (`feature/hnd-cash-01`, `19425eb`, cafe-ops-finance-f1) parked, untouched.

## Phase 0 — DONE
- HEAD `7b39f98` (local save point, not pushed); tree clean except `.next-integration/`.
- 5 owner files (globals.css, app-shell.tsx, expense-workspace.tsx, sales-report-workspace.tsx, sales-report-server.ts) are inside 7b39f98: DO-NOT-TOUCH, never in new commits.
- `prisma generate` OK (no lock); `tsc --noEmit` clean.
- 5434 cluster started via `scripts/test-db.mjs up`; `cafe_ops_test` and `cafe_ops_test_integr20261101_replay_66515e42c85e8ec4`: sysid 7693368256609479860, marker present, 96 migrations, no drift for new objects.
- Other branches: only `20261105120000_hnd_cash_deliveries` (B) is absent here.

## Phase 2–4 — DONE (code), tested
- New migration `20261106120000_direct_handover_hardening` (single drawer partition triggers on ShiftCashDisposition/CashStorage; guard allows on-behalf CONFIRMED→DISPUTED by the named recipient only; confirmation facts immutable). Applied to `cafe_ops_test` only.
- overnight-cash: reverse partition check. close-checklist: `cash-deliveries` (blocking), `cash-deliveries-on-behalf` (warning).
- Ranked locks: lockHandoverRow 1.7, lockCashDelivery 9.1, lockHandoverIssue 9.2 (replaced 3 ad-hoc FOR UPDATE).
- All 7 mutating routes via withIdempotency (Idempotency-Key header; body key accepted only if equal). Services split into *InTransaction; acceptHandoverInTransaction added.
- Owner on-behalf confirmation restored as distinct exception (reason, own audit action, label «تأكيد نيابةً عن المستلم», recipient may dispute while period open). Self-resolved label.
- Report: on-behalf reason, declared/claimed/resolved + shortfall; open dispute marked as blocking period close.
- UI: Idempotency-Key header on all callers; on-behalf owner action + recipient note in cash-deliveries-panel.
- direct-handover-001 FULL: 42/42 PASS (3160, cafe_ops_test).

## Phase 5 — regressions (3160 → cafe_ops_test, serial)
- direct-handover-001: 42/42 PASS.
- 63 suites: 714 PASS / 17 FAIL (handover-008 re-run 70/70 after one dev-server manifest race).
- FAIL, not in this diff:
  - shift-003-blind-count: 0/10, "الشيفت مستني استلام العهدة". Pre-existing; this diff does not touch custody, shift opening or shifts.
  - treasury-003..006: 4, blocked by their own guard (pins the ACC-02A manifest and 89 migrations).
  - handover-001 #13: stale pin (migration 20261030170000 made the CASH_MISMATCH reason optional).
  - handover-004 / 005: one each; `.migration-allocation.json` (gitignored) is missing from this worktree.
- tsc clean; eslint on changed files: 0 errors, 7 warnings (existing effect patterns).
