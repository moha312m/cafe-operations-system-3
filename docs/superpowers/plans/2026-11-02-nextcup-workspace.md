# NEXT CUP workspace redesign implementation and progress

Goal: deliver Finance, Sales/dining tables and Reports in that order on codex/nextcup-workspace-redesign-20261102, based on 7c4e1ae. Owner specification: C:/Users/Acer/.codex/attachments/d3e793d3-bb86-45e6-b24b-36e53617c68d/Pasted text.txt. References are the three supplied Nov2 screenshots. Owner confirmed no other editor.

Architecture: extend existing routes/components and canonical backend read models. Arabic RTL/green identity; compact summaries, searchable lists, explicit form dialogs, no promotional panels. No parallel financial ledger or schema additions. Existing bookmarks remain. Use a new Finance landing and Report center; retain operational screens.

Constraints: no owner5433 writes, app interruption, .env edits, packages, schemas/migrations/seeds, policy changes, cutover, main merge/push/deployment. Worktree has no .env; installed node_modules junction only. Preview3113 if free, guarded existing disposable5434 only, retained unique synthetic fixtures. No historical-helper guard weakening or financial purge.

## Feature map
| Reference area | Existing | Required work |
| --- | --- | --- |
| Sales | invoices/details/receipts/amendments, search, pagination, date/branch/cashier/status filters, signed outputs | clearer workspace and New Sale, payment filter, recognition/collections/import distinction |
| Finance | expenses/categories, treasury accounts/transfers/statements, journal/ledger/trial balance | landing/navigation, modal forms instead of stacked creation, searchable scoped lists, named account selection, readonly configured statements |
| Reports | canonical sales/inventory/operational reports, signed current-session print/export | categorized center, connect real views, focused missing reads where existing data supports them |
| Dining tables | CafeTable single/bulk/edit/archive/restore, grid/list, QR, ordinary selector | discoverable management; occupied protection with shared session-creation lock and transactional audit |
| Quotations/shipping/promotions | separate business workflows | outside this request; do not add decorative links |

## Review focus
- Unknown openings remain unknown; SHADOW/unconfigured never become available cash or configured books.
- Branch readers never receive cafe-wide statements; every API and output rechecks auth/current-session.
- Concurrent new table session cannot race archive/deactivate/renumber; one shared parent lock order.
- Failed commands retain input, retry key and version; close dialog does not lose unresolved money commands.
- CSV formulas and Arabic, timezone boundaries and filtered export use canonical server results.

## Tasks
- [x] Targeted source/authority review; native worktree isolation and installed Next client/route docs. Original owner live record read; root has only14 original tracked dirty paths. No source edits there.
- [x] Checkpoint1 Finance: add permission-aware /finance landing; statement API consumes accountingScope, get existing entity READ ONLY then calls existing functions; cafe-wide balance/cashflow reject branch scope. Add meaningful denial/unconfigured/export tests before implementation. New statement UI uses backend result plus signed existing print/CSV. Treasury dialogs preserve existing command lifecycle; add backend search/filter/pagination; expenses categories discoverable. Focused strict checking/lint and relevant tests.
- [x] Checkpoint2 Sales/Tables: payment-method filter extends salesFilters/listSales shared selection and output; New Sale existingPOS. Table mutation protectedTransaction parent branch lock plus current-session check and auditInTransaction; all session-opening paths participate in same lock. Existing uniqueness/contracts/permission split retained. Regression tests for occupied operations/concurrency/duplicates/archive/restore. Improve table management navigation/state displays.
- [x] Checkpoint3 Reports: permission/feature-aware categorized /report-center connects existing canonical views; scoped missing read-only reports only if data already supports them. Reuse existing report-output signed snapshots/current-session print/export with safe formula handling. Tests scope/filter/export/auth.
- [x] Verify existing disposable identity/marker/migrations and separate server correspondence before fixture writes; no fresh bootstrap or migration replay. Start owned3113 only after free-port proof; browser owner/restricted roles, responsive/RTL/green, financial values/canonical results, table journeys. Retain receipts.
- [x] Final whole-branch review, smallest justified fixes and rechecks; final source/owner-process preservation proof. Deliver actual preview/demonstration, exact file/check results, missing reference items, concrete integration plan preserving owner edits/drafts. No integration or live switch here.

Ruling: implement directly from the detailed owner specification and continue each checkpoint without another design approval pause; the request explicitly says targeted review then implement. No schema change or financial-policy choice is delegated by that.

Progress 2026-11-02: Finance, Sales/Tables and Report Center source implemented. Independent review corrected the expense-dialog branch selector, unassigned-staff table access and unsupported MIXED payment-filter input. Strict project typecheck passed; initial combined new pure run27PASS/1runtimeSKIP, followed by14PASS Sales/Tables review-fix run. Runtime and browser work remain pending; do not promote skipped cases. Source changes confined to worktree; owner app25068/PG17800 remain unchanged. Main owner-live report confirms real3110->5433. Preview will use localhost:3113 to isolate its cookie from owner127.0.0.1. New task-specific source/SQL/identity/marker guard prepared; existing historical helpers/config/manifests unchanged. No new packages, schemas, .env, migration or owner writes.

Ruling: initial raw-byte changed-file comparison also selected unchanged Git files with EOL differences; its lint run had0errors/12inherited warnings. Git-derived changed-files-git.json is the accurate review list. An early shell-piped Python rewrite lost new Arabic labels; restored original forms and rewrote UTF-8 explicitly, then verified new workspace Arabic characters638/no question-mark corruption. No original-owner source was edited. One earlier typecheck-log redirect was denied by the sandbox before command execution; subsequent approved isolated log writes/checks passed. No automatic approval rejection occurred.

## Final delivery — 2026-11-02 (Africa/Cairo)

**Final status: COMPLETE for the requested isolated implementation and verification.** The original owner ERP was not switched or modified. Its existing application PID25068 and PostgreSQL PID17800 retained their exact executable/command/creation identities; owner login on127.0.0.1:3110 returnedHTTP200. The preview is a separate webpack development server on **http://localhost:3113/finance**, parentPID20568; its process tree is retained in final-process-preservation-v2.json. The localhost hostname isolates its login cookie from the owner's127.0.0.1 session.

### What works and how to demonstrate it

- **Finance — /finance:** nine permission-aware destinations for expenses/categories, treasury/bank/wallet accounts and statements, internal transfers, trial balance, balance sheet, cash flow, income, journal and ledger. Treasury lists have backend search, filters and pagination; account/transfer creation is in dialogs with existing retry/version behavior. Expense/category dialogs replace stacked forms, including a required in-dialog branch selector. Unknown treasury opening balances remain unknown; configured books remain SHADOW. Cafe-wide statements refuse branch-scoped access. New statement exports recheck current source/export permissions and signed cafe/branch scope.
- **Sales — /sales:** labeled search/date/branch/cashier/status/real collection-method filters and pagination; New Sale opens the existingPOS; invoice/receipt/amendment permissions and financial meanings remain. Unsupported MIXED filtering now returns400 rather than claiming one mixed payment row represents split tenders.
- **Dining tables — /tables/setup:** management is discoverable in navigation and from the table board. Single/bulk creation, names/areas/seats/order, grid/list, activation, archive/restore and occupied-state controls work. Remove means archive. Protected mutations and session attachment/transfer/default setup share the existing Branch lock; transactional audits and historical sessions/invoices are retained. Unassigned non-owner staff are refused before table access.
- **Reports — /report-center:** searchable six-category center with19 actual reports/records available to the synthetic owner. New purchasing view at /report-center/purchases supplies Cairo date, branch, supplier, status/payment-status/search filters,25-row pagination, scoped original invoice/payment details, and signed CSV/Excel/print from the same canonical query. Snapshot exports recheck current permissions, session and scope. Shared CSV handling protects formula prefixes after spaces/controls/BOM and retains Arabic text; accounting exports label inclusive accounting dates correctly.

Preview synthetic owner: workspace20261102-1949053d4248-owner@example.invalid. Test-only password: workspace-retained-synthetic-only-20261102. The retained preview tab is already signed in. These are disposable test credentials, not the owner's real account. For the populated shadow-statement demonstration use the same password with workspace20261102-1949053d4248-booksowner@example.invalid; income150 less expenses15 yields135, branch1 yields90 and branch2 yields45. Main preview cafe intentionally has unconfigured books and four treasury accounts with UNSET openings.

Suggested review: openFinance; inspect account search and Add Account/Add Expense dialogs; openSales; openTable Management and use the active UI-WINDOW-01 table (six seats, areaالصالة); openReport Center then the purchasing report. Its26 invoices total260, paid52, remaining208. CSV exports the25 displayed rows while retaining full-filter totals and period metadata. Actual browser download and formula protection were verified.

### Actual verification and retained evidence

All evidence below is in artifacts/workspace-redesign-20261102/ in this worktree.

| Verification | Actual result / evidence |
| --- | --- |
| Strict whole-project `tsc --project tsconfig.integration.json --noEmit --incremental false` | Exit0; checkpoint-types.log and expense-fix-types.log. Typechecking preserved; all native source/tests included. |
| ESLint on exact Git-derived changed paths | Exit0, no warnings/errors; final-lint.log, final-static-result.json. |
| Five new pure suites, `node --import tsx --test --test-concurrency=1` | **29PASS / 0FAIL / 0SKIP** in final-pure.log. Explicit unreachable datasource. No unchanged217-test/broad migration rerun. |
| Reports/statements runtime | **13PASS / 0FAIL / 0NOT_RUN**; reports-runtime-1793610964436.json. Includes canonical calculations, exact outputs, current-session/source-permission revocation, assignment narrowing and zero books/journal/projection creation onGET. |
| Sales/tables runtime | **Five scenario groups passed**; Node reports6 including parent wrapper,0fail/0skip. tables-runtime-first.log and retained runtime receipt. Includes real PostgreSQL archive/session races in both orders, duplicate/bulk/occupied/archive/restore/history, ordinary-selector access and management/tenant/branch/revoked/unassigned denials; canonical sales filter/count/totals/output agreement. |
| Finance runtime | **Five distinct workflow groups passed across initial and targeted resume.** Initial3PASS/2FAIL retained in finance-runtime-1793611412480.json; the two affected groups passed in finance-runtime-resume-1793611635493.json. Not relabeled as one all-green initial invocation. |
| Browser | Finance, failed-account value retention and metadata recovery, expenses/categories, Sales, table create/edit/archive/restore/reactivation, Report Center, actual CSV download, configuredSHADOW135, restricted Finance/table denial. Actual CSS widths390 and820 had no page overflow; viewport reset. browser-observations.json contains12 substantive observations plus2 explicit viewport-calibration records; screenshots retained. |
| Read-only final UI/database check | PASS; browser-db-proof.json. Exact six-seat table and transactional audit actions; purchase260/52/208; two expenses17.34; fourUNSET money accounts, zeroMoneyMovements; main books unconfigured, five balanced synthetic shadow entries in separate cafe, zero opening entries; test hooks restored. |
| Preservation and source correspondence | PASS; final-source-and-database-proof.json and final-process-preservation-v2.json. All946 current source pins, original921 owner-source pins, originalAGENTS/89SQL/owner utilities preserved; original14 tracked dirty paths and both empty indexes preserved; main unchanged. |

The actual code defect found at runtime was new expense search using the DTO name categoryName instead of persisted categoryNameSnapshot. The smallest fix uses the persisted field and an explicit Prisma where type; the same retained receipts now pass description/category/count/total queries. Separately, the transfer harness searched a tag also present in account names; its corrected resume searches the full note text. Initial failures remain intact. Sourcev1 SHA1561dc1f3b10cde88e6d212168d211ede6ccdaa5e8cc1db11f0ec50264973abb is retained; current sourcev2 SHAc7115584a703d03429b4df0dbc95568d718d9d31ac0d3448749d92ad301cb17e differs in exactly the expense route. Prior report/table inputs are unchanged; no unnecessary rerun was performed.

Native PowerShell process-array serialization was normalized explicitly in final-process-preservation-v2.json; it compares both concrete PID/executable/command/creation tuples. The earlier raw capture is preserved. Browser CSV verification independently confirms UTF8BOM, protected Arabic formula text and exactly WORKSPACE-2 throughWORKSPACE-26 as the displayed25 invoices.

### Scope, files and remaining limits

**43 code/test/script paths** changed; exact list: final-changed-files.json. They cover Finance/statements, treasury and expense interfaces/read filters, Sales filters, table configuration/locking, Report Center/purchasing queries/exports, shared output safety and six focused test/runtime files plus the report runtime script. This document is the sole progress/handoff record; operational evidence/harness files are separate. No staging or new commit was performed. Private runtime configuration/cookies are locally ignored; do not include them in a source-only commit or handoff.

No schema addition/migration, seed/reset/provisioning command, package install, .env edit, financial-policy/opening-balance change, owner-database connection/write, owner restart, push, main merge or deployment occurred. Existing disposable5434/OID65538/system7693368256609479860/directoryC:/Dev/_nextcup_test_postgres/pgdata was positively verified with exact marker and91 migration checksums before fixture writes. No database was created or dropped. Unique synthetic records and all financial receipts remain; no immutability trigger was disabled or financial history purged.

Reference quotations, shipments and promotions were not added: they are independent workflows needing business rules. Inventory and customer entries explicitly identify the existing current-stock/cumulative operational views, with their actual date/export limitations; this is not full Vendora parity or a custom report builder. No successful treasury dispatch/receipt was forced past UNSET opening-state policy. No physical printing, Excel-application, humanUAT or hardware claim. A full production build was not required/run for this redesign; the working preview is development webpack. A fresh isolated production build is a prerequisite for the later owner-app switch. Accountant review, D7/D8 and existing production gates remain open.

### Concrete integration plan — not executed

1. Review this preview and the43-path diff. Create a curated source-only snapshot/commit on the redesign branch; exclude all private configuration, cookies, runtime fixtures, generated build output and unrelated owner work.
2. Recheck the original checkout HEAD,946-candidate/source scope and its recorded14 owner changes immediately before applying anything. If someone has changed the original meanwhile, reconcile only overlapping approved paths in isolation. Preserve AGENTS, historicalSQL, owner utilities, .env and existing owner data. No schema migration is needed by these changes.
3. Prepare a fresh production build of the reviewed candidate against the verified disposable target in a separate output directory, never overwriting the running owner's build. Reissue source/build receipts from actual checks for the candidate; do not refresh old launcher hashes simply to bypass its refusal.
4. After explicit integration/restart approval, have the owner save all open forms/drafts and choose a short application-switch window. Apply only the reviewed source paths to the original integration checkout, then replace only the exactly identified owner application process/build and verify its existing5433 connection without changing .env or database policy. Keep its current application running until that approved switch; no restart or source copy was performed here. If the real cafe's Tables feature is disabled, enabling it through the existing super-admin settings is a separate owner-approved configuration action.
5. Keep current main/push/deployment untouched. Confirm owner login, permissions and normal navigation after the approved switch; retain the old verified build/source and evidence for application rollback. Preserve all owner sessions/work until the saved-draft switch; do not shut down PostgreSQL for this UI integration.

Final status: COMPLETE
Owner ERP/source/database switch: NOT EXECUTED
Push/main merge/deployment: NOT EXECUTED