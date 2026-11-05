# Step 4/5 — Operating-expense categories and trustworthy P&L

Recommended Codex model: GPT-6 Astra. Thinking: High.
Roadmap: category UX → coverage/mapping assessment → read-only P&L presentation → guarded verification → concrete financial approval packet.

Implement STEP 4 ONLY on the same isolated worktree/branch. Read PLAN.ar.md and STEP-1/2/3-HANDOFF.md. This message authorizes scoped local implementation, focused tests, read-only reporting, a draft accounting design and explicit local commits. It does not authorize adopting new financial policy, enabling previously blocked postings or applying owner-database/schema changes.

## Protect the running system

Original checkout: C:/Dev/cafe-operations-system-3. Real app3110/database5433 must remain running and unchanged. Preserve .env, owner work, historical migrations, permissions, money precision and posting gates. No PostgreSQL control, package install, real-data seed/import, opening-balance adoption, retrospective posting, push, main merge or deployment. Read relevant installed Next.js guides. Runtime verification uses only the task's positively verified disposable database/app with identity/correspondence proof and retained evidence.

Finish all independent authorized work before asking for a financial decision. Existing explicit approvals remain valid for their exact scope; never ask again for a decision already recorded. The past approval for two startup migrations does not authorize this new policy or schema work.

## Current foundations to inspect

- src/components/expenses/expense-workspace.tsx
- src/lib/expense-rules.ts, expenses.ts, expense-api.ts and expense-authorization.ts
- src/app/api/expenses/ and categories/ routes
- ExpenseCategory, OperatingExpense and OperatingExpenseReturn
- src/lib/accounting/chart.ts, ledger.ts, queries.ts, statements.ts and shadow-projection.ts
- AccountingEntity, AccountingAccount, JournalEntry, JournalLine and existing policy/opening records
- Treasury coverage and current P&L/accounting configuration states.

categoryId is already required, expense category labels are snapshotted, and the existing path represents drawer-funded operating expenses. Shadow projection currently holds OPERATING_EXPENSE and OPERATING_EXPENSE_RETURN for unapproved posting alignment. Do not remove that safeguard as a UI fix.

## Part4A — operating-expense categories and entry

Rename the user-facing workspace to “مصروفات التشغيل”. Reuse the existing category model and routes.

- An authorized expense recorder must select an active category from a searchable list. No free-text substitute or silently created “Other”.
- Authorized category administrators can create, rename and archive categories. Preserve existing permission boundaries; “anyone entering an expense” does not mean everyone gains that permission.
- Preserve category snapshots and referenced history. Archive rather than delete used categories.
- Keep amount, description, reference, branch, funding/custody and return controls consistent with current contracts. Do not relabel a bank-funded/rent/accrual event as a drawer expense to fit the form.
- Suggested category drafts for review: RENT, ELECTRICITY, WATER, INTERNET, MAINTENANCE, CLEANING, MARKETING, SERVICE_FEES and OTHER. Do not seed real data. Require a clear description; accountant-approved grouping controls wages/taxes/fees.
- Empty categories should produce a useful setup action for authorized users and a clear explanation for others.
- Preserve numeric JSON, exact two-decimal money, transactional audits, retry keys, original-shift custody restrictions and refund limits.

Proposed Prisma changes for4A: NONE. Keep the existing categoryInput/expenseInput Zod contracts unless a reviewed UI-compatible correction is necessary; validate all fields server-side.

## Part4B — P&L presentation and policy packet

Reuse the existing ledger and incomeStatement calculation. Create or improve a canonical read-only P&L page under the accounting/reporting route conventions; link it from Finance and Reports. Do not create another financial ledger or duplicate calculations in the client.

Present approved net sales, recognized cost of sales, gross profit, approved operating expenses and other approved groups, with drill-down and source coverage. Preserve SHADOW/unconfigured labels and branch restrictions. Missing cost or unposted expenses must not produce a misleading complete profit number.

Keep distinct:
- A ledger-based financial statement.
- An explicitly labelled management preview of available operational sources, if useful.

Do not mix both into one undisclosed total. If coverage is incomplete, expose missing/unmapped items and withhold a complete net-profit claim. Preserve the existing expense-posting gate unless an exact approved policy is already present.

Prepare a concrete FINANCE-DECISIONS.md containing:
1. Category→existing AccountingAccount mapping with actual verified IDs/codes and unmapped categories.
2. Recognition date, source/funding coverage, refund treatment and effective/cutover date.
3. Treatment of historical items and explicit prohibition of silent retrospective reclassification.
4. Proposed schema changes, if necessary: exact reference Prisma models/enums/fields, relations, tenant integrity, uniqueness and indexes, labelled PROPOSED/NOT APPLIED, plus migration/backfill risks.
5. Pure posting examples and tests showing balanced debit/credit effects and exactly-once expense/return handling.
6. The precise remaining owner/accountant decisions and a bounded enablement/rollback plan.

Purchase of inventory, supplier settlement, internal transfers, tax liabilities and owner movements must not be counted again as operating expenses on top of recognized cost of sales. Do not change the chart, valuation, opening balances, D7/D8 or accountant-review disposition by assumption.

Implement/test safe pure helpers and disabled/read-only presentation where useful. Do not wire unapproved posting logic into production paths. Continue4A and other independent work if4B awaits a real decision.

## Acceptance and truthful status

Verify missing/inactive/foreign categories, archive/rename snapshots, permissions, duplicate submission, drawer/custody restrictions, expense return limits and transactional audit failure on disposable data. Reconcile allowed P&L outputs to existing source totals and test missing-cost/unconfigured/unmapped scenarios, including screen/export consistency.

Record4A implementation status and4B policy/enablement status separately in STEP-4-HANDOFF.md. A working screen does not close the financial gate. Provide the actual preview, files/checks, and a short actionable approval packet only after completing the concrete preparatory work.

Step5 may proceed with independent integration verification while unresolved financial policy remains explicitly gated. Stop after this step.

Final status: COMPLETE / PARTIALLY COMPLETE / BLOCKED / NEEDS OWNER DECISION, with4A/4B sub-statuses.
