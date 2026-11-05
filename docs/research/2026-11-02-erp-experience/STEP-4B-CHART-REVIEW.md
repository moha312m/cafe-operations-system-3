# Step 4B chart of accounts review draft

NEXT CUP already stores expense categories and snapshots the category name and code at payment. The operating-expense workspace can filter by category, branch and Cairo payment date. The existing accounting entity has a chart with parent accounts, account types, system keys, postable accounts and journal lines. The account API currently serves postable accounts for filters. A chart management screen and an approved category-to-account mapping are the missing pieces for this workflow.

## Proposed operating expense group

Use the existing `5000` costs and expenses section. Reserve a proposed non-postable `5400` header for operating expenses and confirm code availability against the actual chart before saving any accounts. The codes below are working proposals for review. Match each category to its actual existing ID and each account to its actual account ID during preparation.

| Expense category | Proposed account | Scope to review |
|---|---|---|
| نظافة | 5410 — نظافة ومستلزمات نظافة | Routine cleaning and its consumables |
| صيانة | 5420 — صيانة وإصلاحات | Routine repairs and maintenance |
| رواتب وأجور | 5430 — رواتب وأجور | Payroll expense classification and the source used to recognize it |
| مرافق | 5440 — مرافق | Electricity, water and similar operating costs |
| إيجار | 5450 — إيجار | Rent expense and the recognition period |

The existing `5100` cost of sales, `5200` inventory loss, `5300` cash variance and `5900` other operating expense accounts retain their separate meanings. An unmapped category is visibly pending review. An approved catch-all mapping should be a deliberate choice.

## Workflow and release order

1. Expose the existing chart under **المحاسبة ← دليل الحسابات** with code, name, type, parent and account status. Show grouping headers in the chart and continue returning postable accounts in the existing filter selector. Use authorized entity scope and provide a drill-down to the existing ledger.
2. Add a separate category-to-account review step under expense category management. Cashiers select the operational category. The accountant reviews the active, postable expense account in the same accounting entity. The filter for operational expenses uses the original category ID, with historical labels displayed from their recorded snapshots. The ledger and P&L use the posted account and branch of each entry.
3. Prepare a sample expense and a linked return in the disposable environment. Reconcile operational payment amounts, proposed journals, trial balance and P&L coverage. Show missing mappings or incomplete posting coverage in the review. Keep the amount and the source reference traceable from each journal line. Specify effective dates and preserve account attribution on previously posted entries when a mapping changes.
4. Prepare the accountant decision packet for expense recognition and returns, payment source accounts, payroll coverage and treatment of old records. D7 covers actual accounts and business facts for credit sales, supplier advances, bank, processor and wallet flows. D8 covers the cutover date and preparation and signoff of opening balances. Existing expense posting and return approval gates apply to activation.
5. Extend professional accounting in separate verified slices using the same ledger. Connect journals and source documents, reconcile cash and bank balances, and verify trial balance, P&L and balance sheet. Use the existing branch as an analysis dimension and evaluate any additional cost centers only when a business use case requires them.

The first preview is read-only chart discovery and a draft mapping with sample reconciliation. Its schema changes are zero. A persisted mapping, account administration writes and live posting require their own reviewed design and a verified test environment.

References: [Odoo Chart of Accounts](https://www.odoo.com/documentation/19.0/applications/finance/accounting/get_started/chart_of_accounts.html) and [Odoo accounting workflow](https://www.odoo.com/documentation/19.0/applications/finance/accounting.html).
