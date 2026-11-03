# NEXT CUP Step 4A handoff

The مصروفات التشغيل workspace is available from Finance and the Report Center. An authorized owner can create, rename, archive and reactivate categories. Expense entry searches active categories by name or code and requires a selection. Pending payments can still recover their original request. The branch filter and the branch selected for entry are independent.

The operational report uses the same Cairo payment date, branch and category scope as the receipt list. The breakdown groups gross drawer payouts by branch and category as recorded at payment. A category rename can therefore produce two historical labels under one category filter. The list links to the original expense and its return records. The returned amount at the top covers cash linked to matching payouts, regardless of the return date. These figures describe drawer activity.

## Step 4B decisions pending

- Accountant review of the category to account mapping, recognition and return dates, funding coverage and treatment of historical or unposted expenses.
- D7 covers the operating facts and actual account identities for credit sales, supplier advances, bank accounts, payment processors and wallets.
- D8 covers the cutover date and who prepares and signs the opening balances.
- The existing expense and return posting gate remains in effect pending explicit approval.

## Step 4A verification

Status **COMPLETE** for the local Step 4A workflow. Preview http://localhost:3113/expenses serves build YC4ni3GQ3GhLa3LTrOtAa. The unchanged guard verified disposable database OID 65538, the expected cluster and marker, 91 migration checksums and HTTP/database correspondence.

All 21 focused tests, lint, TypeScript and the production build passed. The guarded HTTP run verified owner create/rename/archive, manager denial, missing/foreign/archived category rejection, same-key recovery, drawer custody, return limits and an injected audit failure with rollback. The temporary audit hook was removed. Two source receipts totaled EGP 35.00 paid and EGP 4.75 returned, with historical labels retaining EGP 24.75 before the rename and EGP 10.25 after it. Cairo period, branch, category and page scope were checked. The browser showed the same breakdown, exposed the rename form, excluded the archived category from entry and opened the original receipt.

Step 4B awaits accountant review and D7/D8. Owner preview review is pending.
