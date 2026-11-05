# Step 2 closeout — Date-basis correction, live verification and owner preview

Recommended model: **GPT-6.1 Sol**. Thinking: **Medium**; use a focused High review on the same model only for an unresolved financial/authorization concern. Select these in the Codex UI. Do not delegate additional agents merely to finish this closeout.

Roadmap: preserve implemented source → correct the purchase-date inconsistency → recover the existing test environment → prove six reports/exports/permissions in a real browser → deliver a working preview and updated handoff.

This is a proposed execution prompt. Saving/preparing it does not run services or grant an actual approval. **When the owner explicitly submits it for execution**, the following bounded continuation and test-database startup are authorized. Do not ask for the same already granted startup authorization again merely because a previous start occurred; it applies to this Step2 closeout under the identities and limits below.

## Scope and baseline

Continue the existing worktree:
C:/Users/Acer/.codex/worktrees/nextcup-workspace-redesign/cafe-operations-system-3

Expected branch: codex/nextcup-workspace-redesign-20261102.
Reported source/test commit: 6bcdefb8965010143f5d16609e07a9baba077106.
Reported subsequent handoff commit: 7865392.

Verify actual Git state and read artifacts/erp-experience-20261102/STEP-2-HANDOFF.md and step2/verification.json. These commits are supplied by the owner/handoff; do not assume their current reachability or overwrite later work. Read AGENTS.md and the updated Step2 specification. Preserve all current changes, fixtures, financial receipts, old manifests and Step1/1B evidence.

Step2A–2C source is implemented. The handoff records43 pure tests, lint/types/build passing, but runtime/visual acceptance unverified. Do not rerun the implementation, start2D/3, add optional features7–9, or label those tests as fresh runtime proof.

## 1. Correct the demonstrated date-basis inconsistency

Read the actual current files and reproduce the mismatch before editing:

- src/lib/metric-definitions.ts defines confirmed purchases within the period by invoiceDate.
- The inspected new src/lib/sales-report-server.ts purchase-sales branch, around lines103–107, filters/displays confirmedAt instead.

Unless a later explicit owner-approved contract has already changed this, align the new comparison with the existing invoiceDate basis, including filter, displayed date, metric description, export snapshot and handoff. Keep status=CONFIRMED, source identities, exact amounts, authorizations and supplier paidAt settlement treatment intact. This restores existing reporting policy; it does not authorize a new recognition/valuation rule.

Add a meaningful regression using a confirmed invoice whose invoiceDate and confirmedAt fall in different periods: it belongs to its invoice-date period, while supplier settlement remains in its own paidAt period. Exercise the actual query/report path on verified synthetic disposable data, not a source-text assertion. Preserve any different explicitly documented reporting basis rather than silently changing financial policy.

Make only demonstrated bounded Step2 fixes. Run affected tests/types/lint and rebuild when source changes require it; do not repeat unrelated historical suites or migration replay.

## 2. Existing disposable database startup authorization

Authorized target only:

- PostgreSQL17 binary: C:/Dev/_nextcup_postgres/pg17/bin/pg_ctl.exe
- Data directory: C:/Dev/_nextcup_test_postgres/pgdata
- Loopback port:5434
- Expected cluster system identifier:7693368256609479860
- Expected database: cafe_ops_test_integr20261101_replay_66515e42c85e8ec4
- Expected database OID:65538
- Expected application preview port:3113

First verify executable/data-directory/cluster identity, actual process ownership and listener state. If the correct instance is already running, reuse it; do not restart it. If stopped and identity matches, start that existing cluster with its existing data and loopback5434 settings. This is bounded existing-test-cluster startup, not approval to provision another environment, stop an unknown process or control the owner cluster.

Preserve current data. No initdb, new database, drop/reset, migration/seed, dump/restore, package installation, .env edit, broad setup/refresh script or manual stale-PID deletion. A startup failure needs exact error/root-cause investigation, not repeated blind attempts. Startup authorization remains bounded to completing this Step2 closeout; unexpected identity, data, configuration or repair requirements need a concrete separate decision.

Owner database5433 and app3110 remain outside the task. Never use inherited owner-target environment settings or owner credentials as a fallback.

After startup, prove actual database name/OID/system identifier/disposable marker/schema correspondence through the existing unchanged guard. Refresh only the task-specific observed source manifest when code actually changes; never rewrite historical guards, receipts or old expected pins to force a pass. Keep secrets out of output.

Only after the guard passes, start/rebuild the owned Step2 preview on3113 with its dedicated configuration. Do not commandeer a listener. Establish fresh real HTTP/server/database correspondence before browser acceptance. If the owned app needs restarting after a source/build change, identify and manage only that app's processes. Do not claim an intended URL is live without this proof.

## 3. Complete the missing runtime and visual acceptance

Use retained synthetic fixtures and narrowly tagged additional fixtures only, preserving previous records. Verify:

1. All six reports and Sales/Reports hierarchy: products/SKU, shifts, sales payments, purchase/sale comparison, staff and tables; existing report routes still work.
2. Correct invoiceDate purchase comparison; exact SKU contribution denominator, refunds/revisions and reconciliation; creator/collector/server attribution; separate repeated table sessions; actual collection legs without join duplication.
3. Two cafes and restricted roles: real API/list/detail/export isolation, cost/customer-field gating, revoked or changed scope invalidating old output tokens. No owner data.
4. At least61 matching records: real paging and explicit page-versus-full filtered CSV/Excel/print, correct values, Arabic and leading-zero identifiers. Confirm export coverage limits rather than silently truncating.
5. Browser desktop and360/390px journeys: filters/URL/back, product/invoice/shift drill-down, focus, readable cards/tables, slow/error/empty/stale reads and no page-wide horizontal overflow.
6. Existing POS/receipt behavior remains intact on the dedicated synthetic setup; report reads/prints create no business money/stock records. No real provider charge, external message, tax submission or new price publication.

Use actual authorized browser tools after correspondence succeeds. Do not bypass denied access or substitute static-render screenshots for a live acceptance check. No hardware/printer success claim without physical evidence.

Capture actual runtime screenshots, source/build/database identifiers and concise reconciliation receipts. Distinguish technical acceptance from the owner's visual acceptance, which stays pending until the owner reviews it.

## 4. Handoff and stop

Update STEP-2-HANDOFF.md and verification results with corrected metric basis, actual fixes/checks, dates/times in Africa/Cairo, failures/skips, screenshot paths and working exact preview URLs. Preserve prior failed/unverified history and do not fabricate passing receipts. Record any reviewed local commits without broad staging of private configs, credentials or build output.

Keep the verified test preview available for owner review where permitted; document its actual availability and startup/recovery ownership. Do not mark Step2 fully accepted merely because the app starts or a login page responds.

No push, main merge, owner activation, Railway action or deployment. Stop after Step2 closeout; no2D/3 or optional features. Final report states implemented/fixed, runtime-verified, owner acceptance, current preview and remaining exact limitations. Separately state owner-database changes, push/merge/deployment status.
