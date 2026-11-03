# NEXT CUP Step 3

## Workbook and request contract

Start at /recipe-review. The menu workspace links to recipe review. Select products or add-ons for a focused workbook, export all saved recipes, or download a template. Selecting a product includes its stored default and size recipes. The workbook retains explicit default inheritance and does not expand inherited sizes into separate recipes.

The v2 workbook keeps the legacy Recipes columns and adds a hidden exportBaseline column with a signed version of the stored recipe. Products includes text SKUs and explicit variant references. Ingredients includes branch and storage unit. AddOns, Units and Instructions provide references. Only Recipes is imported. Edit ingredient IDs and their helper labels together with unit, quantity and waste. Keep SKU as text. Each included recipe group supplies its complete replacement list. Omitted groups are outside the import.

GET /api/recipe-import/export accepts repeated productId or addOnId query parameters. Omitting both exports all saved recipes. POST preview and commit accept optional acknowledgeLegacy for older workbooks without the baseline. Replace requires that acknowledgement for existing groups. A present baseline must match the current recipe. New-only still skips existing groups. The preview response adds before/after, action totals and row errors. Commit returns the existing counters and a review list.

The signed preview binds the actor, tenant, mode, acknowledgement, rows and catalog state. Commit repeats validation inside the serializable transaction. Recipe changes, per-recipe audit and the completion receipt commit together. Repeating the same signed request returns the recorded result, including after preview expiry while the audit receipt exists. A fresh preview is required for an expired request without a receipt. Import accepts up to 1,000 rows and the file picker accepts up to 5 MiB.


## Verification and preview

Local workflow complete on codex/nextcup-workspace-redesign-20261102. Preview http://localhost:3113/recipe-review uses build J-qH-L0bBOdcFcRb3xpG2. The unchanged guard verified disposable database OID 65538, cluster 7693368256609479860, 91 migration checksums and HTTP/database correspondence.

The full workbook contained five saved recipe rows. Selected export returned three rows across default, size and add-on scopes. The Products sheet retained text SKU 0012, and the selected recipes retained 00012. Editing the small size from 1.25 to 1.375 produced one replacement and two unchanged groups. Replaying confirmation returned the same receipt. The old export failed stale validation. Re-export returned the new quantity. Menu, size and add-on prices, inventory records, stock transaction count, order and revision counts, journal entry count and an unrelated recipe matched before and after.

All 24 parser and live integration tests passed, including permission denial, branch ambiguity, invalid values, stale preview and injected audit rollback. Empty, oversized and 1001-row inputs were rejected. The actual browser downloaded a selected workbook, uploaded the sample through the picker and displayed the before/after preview. It showed the invalid quantity on row 2 and disabled confirmation. The mutation was verified through the authenticated API. The workbook was edited programmatically for the round trip.

Sample workbook and captures are under C:/Dev/cafe-operations-system-3/artifacts/erp-experience-20261102/step3. When adding a line to an existing recipe, duplicate one of its rows to carry its scope and baseline, then edit the ingredient fields. Row numbering follows parsed data rows when the file has blank spacer rows. Owner visual acceptance remains pending.
