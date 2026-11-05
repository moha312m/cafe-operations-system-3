# NEXT CUP professional accounting roadmap and Step 4B.1 prompt

Claude Code model **Sonnet**, effort **Medium**. Use focused High effort if a later approved accounting change requires detailed reconciliation.

Implement Step 4B.1 only in the current approved NEXT CUP worktree. Read `AGENTS.md`, the relevant installed Next.js App Router guidance, the current Prisma schema, and the latest Step 4 handoff. Read the roadmap and mapping draft in the main workspace:

- `C:/Dev/cafe-operations-system-3/docs/research/2026-11-02-erp-experience/PLAN.ar.md`
- `C:/Dev/cafe-operations-system-3/docs/research/2026-11-02-erp-experience/STEP-4B-CHART-REVIEW.md`

## Roadmap and checkpoints

| Stage | Deliverable and checkpoint |
|---|---|
| 4A | Operating expense categories and filters. Implemented locally per handoff, with visual acceptance tracked separately. |
| 4B.1 | Read-only chart of accounts with a ledger link and draft expense-category mapping. Verify on the existing disposable preview and present for owner review. |
| 4B.2 | Account administration and persisted category mapping. Prepare the exact schema, permissions, change history and effective-date rules for separate review before implementing writes. |
| 4B.3 | Expense and return posting through the current journal service. Start after accountant approval and applicable D7/D8 decisions. Verify balanced entries, period handling, source traceability and exactly-once behavior on disposable data. |
| 4B.4 | Reconciled general ledger, trial balance, P&L, balance sheet and branch analysis. Verify each report against posted source entries and state missing coverage explicitly. |
| 4B.5 | Cash and bank reconciliation. Verify matched and outstanding items against balances and source documents. |
| 5 | Verify and integrate the reviewed release scope. Track any independent work and open accounting decisions explicitly. |

## Implement 4B.1

1. Add **المحاسبة ← دليل الحسابات** using the existing accounting shell and `AccountingAccount` hierarchy. Provide a clear Arabic RTL view with code, name, type, parent, active status and posting status. Show parent groups, use a readable search by code or name and offer a link into the existing ledger for eligible accounts. Reuse shared navigation, labels and styling. Handle loading, empty, denied and error states.
2. Reuse the existing scoped account query where appropriate. The current account selector is designed for postable accounts. If the tree needs a separate query or GET route, preserve the selector contract, reuse accounting scope and validate any new URL parameters with Zod. Use the actual resolved accounting entity and existing permission rules, including for direct URLs. Keep ledger links within the permitted scope.
3. Prepare a draft table mapping actual expense categories and account references when visible in the authorized preview. Include cleaning, maintenance, wages, utilities and rent. Treat 5400–5450 as proposals and identify existing codes or conflicts. Mark unmapped categories and unresolved payroll recognition clearly. Use the operational category for expense filtering and explain that ledger analysis will use the account on the posted entry. Leave salary entry and payroll recognition to the existing approved workflows.

**4B.1 data contract.** Prisma model, enum, relation and index additions are zero. Account and mapping writes are outside this phase. Use read-only queries and existing authorized preview data. There are no new write transactions, concurrency controls or idempotency keys for this phase. Preserve the expense and return posting gates, historical category snapshots, and existing report and export behavior. Use the guarded disposable environment for verification. Keep service control, migrations, production data changes and release actions within their existing authorization boundaries.

## Verify and hand off

Run focused checks for the changed entry points. In the disposable preview, verify hierarchy, search by name and code, inactive and non-postable states, authorized ledger navigation, denied access and tenant isolation. Confirm that the expense category filter and historical labels behave as before. Capture the chart with representative synthetic accounts at desktop and phone widths. Record evidence separately for source checks, runtime verification and owner visual acceptance.

Update the accounting tracking table in `PLAN.ar.md` from actual results. Report the current stage, changed files, checks, verified preview URL, open decisions and the next stage in a short handoff. Keep later phases marked planned or awaiting their decision until verified. Stop after 4B.1 for review of the chart and draft mapping.
