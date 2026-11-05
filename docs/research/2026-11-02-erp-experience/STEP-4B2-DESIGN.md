# Step 4B.2 design packet — account administration and persisted category mapping

Status: **implemented locally on 2026-11-04; closeout, hardening, group creation and export added the same day (sections 13–18) after owner approval of the migration (disposable database only); see section 12 for what was built and where it deviates from this design.** Not committed, not merged, not applied to any owner or production database. Prepared 2026-11-04 after 4B.1 owner approval. Implementation starts only after the decisions in section 9 are answered.

## 1. Scope

In: creating and editing accounts in the existing chart; saving which account each operational expense category maps to, with effective dates and history.
Out: posting expenses or returns (4B.3, needs accountant approval and D7/D8), statements (4B.4), reconciliation (4B.5), opening balances, payroll recognition, reposting or reclassifying any posted entry. The existing expense and return posting gate stays closed.

## 2. What the source already guarantees (verified 2026-11-04)

| Fact | Where | Consequence for 4B.2 |
|---|---|---|
| Journal entries and lines are append-only; a line may only point at a **postable, active** account of the same entity | `ledger_append_only`, `journal_line_guard` in `20261028200000_accounting_ledger_core` | Deactivating an account cannot damage history; it only stops new lines. Mapping to an inactive/header account must be refused at write time too. |
| `AccountingAccount` itself has **no update guard** | schema + migrations (no trigger on the table) | Today `type`, `normalBalance`, `isPostable`, `code`, `parentId` could be changed under existing lines by any code path. Admin writes need a database guard (section 4), not just API checks. |
| Posting refers to accounts by `systemKey`, never by code | `chart.ts`, `PostingLine` | Accountants may renumber or rename non-system accounts freely; system-key accounts need their key and meaning protected. |
| `syncDefaultChart` never overwrites an occupied code; it reports a conflict. Only keyless headers are adopted by code | `chart.ts` | A manually created 5410 is safe from sync. Do **not** add 5400–5450 to `DEFAULT_CHART` until approved: `ensureAccountingEntity` runs on write paths for every café and would create them everywhere. Creation is an explicit setup action. |
| Entity row is locked `FOR UPDATE` by posting and by chart sync | `lockEntity`, `syncDefaultChart` | Reuse the same lock so account/mapping writes serialize with posting and sync. |
| Permission `accounting.setup` ("إعداد الدفاتر ودليل الحسابات") exists, is sensitive, and **no route uses it**; templates give it to the owner only ("setup, reversal and closing stay with the owner") | `perms/catalog.ts`, `perms/templates.ts` | No new permission key is needed. Accountants hold view/export/project/reconcile but not setup. |
| `ExpenseCategory` has no account link; `OperatingExpense` snapshots category code and name | schema | The mapping must key on `categoryId`, never on code or name. |
| Shadow projection lists `OPERATING_EXPENSE` and its return as "approval of posting alignment required" | `shadow-projection.ts` | An approved mapping is a prerequisite for 4B.3, not a trigger for it. |

## 3. Proposed data model (reference only)

Two new tables. No change to existing columns.

```prisma
// Append-only. Effective mapping for date D = the row with the greatest effectiveFrom <= D.
// accountId = null means "unmapped from this date" (an explicit end), so nothing is ever updated or deleted.
model ExpenseCategoryAccountMapping {
  id            String   @id @default(cuid())
  cafeId        String
  entityId      String
  categoryId    String
  accountId     String?
  effectiveFrom DateTime @db.Date   // Africa/Cairo business date
  reason        String              // required, free text
  approvalRef   String              // required: accountant sign-off reference
  createdById   String
  createdAt     DateTime @default(now())
  @@unique([categoryId, effectiveFrom])
  @@index([cafeId, categoryId, effectiveFrom])
}

// Receipt for retried setup requests (account create/edit, mapping change).
model AccountingSetupOperation {
  id          String   @id @default(cuid())
  cafeId      String
  scope       String
  key         String
  requestHash String
  result      Json
  createdAt   DateTime @default(now())
  @@unique([scope, key])
}
```

Database guards (new migration, disposable database only until approved):
- Mapping table: append-only trigger (reject UPDATE/DELETE); on INSERT require category and entity to belong to the same café, and a non-null account to be same-entity, `isPostable`, `isActive`, and `type = EXPENSE` unless a catch-all exception is explicitly approved (D5).
- `AccountingAccount` update guard: once an account has journal lines, reject changes to `type`, `normalBalance`, `entityId`; reject `isPostable` true→false; reject any change to `systemKey` or, for system accounts, to `code`. Also reject a parent of a different type and any parent cycle.
- Migration name comes from the project's pre-allocated list; checksums are raw-byte SHA-256 (CRLF/LF trap).

Audit history uses the existing `AuditLog` via `auditInTransaction` in the same transaction (before/after values, reason, approval ref); a failing audit rolls the change back, as 4A's tests already prove for expenses. No separate account-revision table.

## 4. Account administration rules

| Action | Allowed | Rules |
|---|---|---|
| Create | owner with `accounting.setup` | Code unique per entity, 4 digits; parent must be a non-postable header of the **same type**; `normalBalance` derived from type unless a contra account is stated with a reason; `isPostable` set at creation. |
| Rename | yes | Name only; no effect on history. |
| Change code | non-system accounts only | Audited. Postings are unaffected because they reference ids/keys. |
| Deactivate / reactivate | yes | Deactivation refused while an effective mapping points at the account (remap first). History untouched. |
| Change type / side / postable→header | **never** once lines exist | Enforced by the DB guard. Corrections are a new account plus, if needed, an accountant-approved reversal entry. |
| Re-parent | yes, same type, no cycle, depth limit | Changes statement roll-up of historical lines. Decision D4 on whether this is blocked when the account has lines in a closed period. |
| Delete | never | FK is `Restrict`; no endpoint is offered. |

System-key accounts: only the name may change.

## 5. Mapping rules and effective dates

- Key: `categoryId`. Renaming or archiving a category never changes its mapping; archived categories keep theirs so late returns and history resolve.
- Resolution for an expense = mapping effective on the expense's Cairo accounting date, not "today's" mapping. No match → the source stays an **unpostable projection issue**, never a silent fallback to 5900 (unless a catch-all is approved, D5).
- `effectiveFrom` may not be earlier than the D8 cutover date (once set) nor earlier than the start of the earliest open period. A change never alters a posted entry; posted lines keep their account.
- Returns (4B.3 design note): a return posts against the account of the **original expense's posted entry**, not the current mapping.
- Before saving, an impact preview shows, for the chosen date, how many operating expenses and what total fall on or after it, split into already posted vs not yet posted. If any are already posted under a different account, the save requires acknowledging that they are **not** reclassified (reversal is a separate `accounting.reverse` action).
- Wages: a mapping may be saved for رواتب وأجور, but the payroll recognition source is undecided, so 4B.3 must not post it until D6 is answered.

## 6. Permissions and scope

- All writes: `requireKey("accounting.setup")`, café-wide only. A branch-pinned user is refused even with the key; `SUPER_ADMIN` must name the café. Another café's ids resolve as 404, not 403.
- Reads stay as in 4B.1 (`accounting.view`; mapping panel also needs `expenses.view`). Implementation must confirm any café feature gate for accounting, as other accounting routes do.
- Maker/checker: single owner action with a mandatory approval reference now; a separate approval key is deferred (D3).

## 7. Concurrency and idempotency

- Every write: `protectedTransaction`, lock the entity row `FOR UPDATE` first (same order as posting), then validate, write, audit.
- Mapping change carries `expectedLatestEffectiveFrom` (or the latest row id) for that category; a mismatch returns 409 so two administrators cannot overwrite each other blindly.
- Required `Idempotency-Key` header; scope and `requestHash` stored in `AccountingSetupOperation`. Same key and payload replays the stored result; same key with a different payload is refused. Unique `(entityId, code)` and `(categoryId, effectiveFrom)` are the last-line backstops.

## 8. Proposed surface (not built)

- `POST /api/accounting/accounts`, `PATCH /api/accounting/accounts/[id]` — Zod `.strict()` bodies.
- `GET /api/accounting/expense-category-mappings` (current, history, unmapped list), `POST …` (change), `POST …/preview` (impact preview; read-only).
- UI: edit actions on the 4B.1 chart gated by `accounting.setup`; mapping panel gains «اعتماد الربط» with the preview, reason and approval-reference fields, and a history list. Nothing posts.

## 9. Decisions

**2026-11-04 — owner accepted the recommendations for D1–D5.** D1: codes 5400–5450 are provisional until the accountant confirms them; accounts are created by an explicit setup action. D2: append-only effective-dated mapping. D3: mandatory approval reference, no separate approver yet. D4: block re-parenting accounts with lines in closed periods. D5: no automatic fallback to 5900. **D6, D7 and D8 remain open** (accountant/owner facts, not covered by this acceptance); they do not block 4B.2 but gate 4B.3, and D8 bounds `effectiveFrom` once set. Implementation still needs a separately approved migration.

| # | Decision | Recommendation |
|---|---|---|
| D1 | Create 5400 header and 5410–5450 as written, or the accountant's own numbering | Accountant confirms codes; create by explicit setup action, not by `DEFAULT_CHART`. |
| D2 | Effective-dated append-only mapping vs a single mutable mapping | Append-only (history for free, no update path). |
| D3 | Maker/checker now or later | Later; mandatory approval reference now. |
| D4 | Block re-parenting accounts that have lines in closed periods | Block. |
| D5 | Allow a deliberate catch-all (5900) for unmapped categories | No automatic fallback; allow only as an explicit mapping the accountant chooses. |
| D6 | Payroll recognition source and basis for الأجور | Needed before 4B.3; mapping can be saved earlier. |
| D7/D8 | Existing: actual accounts for credit/bank/wallet flows; cutover date and opening balances | Remain open; D8 sets the lower bound for `effectiveFrom`. |

## 10. Verification plan (disposable guarded environment only)

1. DB guards: update of `type`/`normalBalance`/`isPostable`/`systemKey` with lines is rejected; mapping insert rejects header, inactive, other-entity, non-expense account and other-café category; mapping UPDATE/DELETE rejected.
2. Concurrency: two creators of the same code (one wins, one 409/conflict); two mapping changes racing on the same category; a mapping change racing a projection run (serialized by the entity lock).
3. Idempotency: replay returns the stored result; changed payload under the same key is refused; lost-response retry creates one row.
4. Permission matrix: owner OK; accountant role without setup 403; branch manager 403; waiter 403; other-café owner 404; super admin without café 400.
5. Audit failure injection rolls back the change.
6. Effective dates: before cutover and before earliest open period refused; resolution picks the right row across a change; archived category keeps its mapping.
7. Regression: trial balance, ledger, journal and expense list identical before and after any admin write; 4B.1 chart and the account-selector route unchanged.
8. Migration applied to the disposable database only, checksum recorded from LF blobs; no production or owner database touched.

## 11. Boundaries

No schema change, migration, data write, posting activation, service restart or release action happens as part of this packet. Implementation of 4B.2 needs the section 9 answers and a separately approved migration.

## 12. As built (2026-11-04)

Migration `20261104120000_expense_category_account_mapping` (one table, triggers, no data change), applied only to the disposable `cafe_ops_test` database on 5434. Source: `src/lib/accounting/setup.ts`, `chart-view-queries.ts`, routes under `src/app/api/accounting/` (`accounts` POST, `accounts/[id]` PATCH, `expense-category-mappings` POST, `…/preview` GET), and `src/components/accounting/chart-setup-dialogs.tsx` with the edit actions on `/accounting/chart`. Tests: `accounting-007` to `accounting-011`.

Deviations from sections 2–8:
- **No `AccountingSetupOperation` table.** The existing `IdempotencyKey` machinery (`withIdempotency`, leased and fenced) is reused instead of a parallel receipt table. Only `ExpenseCategoryAccountMapping` is new.
- **System accounts may be renumbered.** `chart.ts` and `accounting-005` already promise that accountants may renumber or rename system accounts, because posting goes by `systemKey`. So the guard locks a system account's key, type, side, postable flag and active state, not its code. A header's key may move, because chart sync adopts keyless headers.
- **Deactivation rule is wider.** An account is also protected while it is the mapping in force today when a later row is dated in the future, not only when it is the category's latest row.
- **Closed periods.** A mapping date inside or before a closed period is refused by the API; the database guard keeps dates moving forward per category.
- **Wages** can be mapped; recognition (D6) still gates posting in 4B.3.

Not covered at that time: the posted-versus-unposted acknowledgement path and any real device. The acknowledgement path is now covered (section 13); real devices are still not covered.

## 13. 4B.2A — confirmed defects and fixes (2026-11-04 closeout)

All five were reproduced first against the applied migration `20261104120000` (tests failed), then fixed in a new forward migration `20261105090000_mapping_guard_hardening` (functions only; the earlier migration and its checksum are untouched). Regression suite: `tests/accounting-012-mapping-hardening.test.ts`, `accounting-013-posted-expense-ack.test.ts`.

| # | Defect (reproduced) | Fix | Regression evidence |
|---|---|---|---|
| 1 | Account A today, B from day +30, C from day +60: B could be deactivated (guard protected only the latest row and the row in force today). | An account is protected while any of its mapping rows is in force today or starts later. Intervals that ended in the past free it. Application and trigger use the same rule (`protectedMappingAccountIds` ⇔ trigger). | Future rows, a future unlink row, two categories sharing an account, an ended interval being freed, and trigger/application parity. |
| 2 | Mappings accepted cost of sales, purchase discounts, inventory loss and cash differences. | Eligibility by system identity only: `COST_OF_SALES`, `PURCHASE_DISCOUNTS`, `INVENTORY_LOSS`, `CASH_OVER_SHORT` are refused (`expense_mapping_excluded_key()` mirrored by `NON_OPERATING_EXPENSE_KEYS`; a test compares the two lists). Custom accounts and `OTHER_OPERATING_EXPENSE` (5900) stay valid whatever they are numbered or named. Applied in the selector, preview (`accountId`), write endpoint and database. | DB level, HTTP level, and a custom account named like cost of sales still accepted. |
| 3 | Closed-period protection for mapping dates existed only in the API ("any writer" was not true). | Trigger refuses a mapping date on or before any closed period's end. | Inside the period, its last day and an unlink row all refused with direct DB writes. |
| 4 | An account named by a mapping could still change type, side or postability. | Frozen for any account a mapping row has ever named (history pins it). | Type/side/postable changes refused, also after the mapping ended. |
| 5 | Deactivating an account and mapping to it concurrently could both commit (inactive but mapped). | Both take one per-books advisory lock; the mapping insert also shares the books' row lock so it orders against a period close. | Three rounds with a held-open deactivation: the mapping is always refused. |

**Existing-data audit.** On the verified disposable databases no existing mapping row violates the new rules: `cafe_ops_test` mappings are all created by test suites after the rules; the preview database had no mapping table before this stage. Hardening is not retroactive: existing rows are neither rewritten nor revalidated. Owner database: not inspected, and it has neither migration.

**Posted-expense acknowledgement (previously untested) — now covered with real drawer payouts and synthetic journal entries.** Preview counts and amounts are exact (3 expenses, 37.75; 2 posted, 30.50; a future date touches nothing; another category is counted separately). A mapping change that affects posted expenses is refused without the acknowledgement; an audit failure rolls it back with no mapping row; an acknowledged change plus an idempotent retry leaves one mapping and one audit row; the journal entries, lines and accounts are byte-for-byte unchanged afterwards.

Not changed on purpose: type, side and postability changes on accounts with posted lines stay blocked; no account is ever deleted.

## 14. 4B.2B — account coverage, creation/editing/export, accountant decisions

### 14.1 Capability tracking

| Capability | Status (2026-11-04) |
|---|---|
| Account creation — posting account under a compatible group | Implemented; tested (API + preview). |
| Main/group creation — root under one of the five types, or sub-group | Implemented (`parentId = null` is accepted and the nullable relation needed no schema change); groups are always non-postable; a posting account cannot be a parent; depth limit six levels. |
| Editing — name, code, parent, active status; protected fields shown with the reason | Implemented. The chart returns per-account locks (system account, posted lines, mapping in force, children, closed-period lines) and the dialog explains each. |
| XLSX export | Implemented: Summary, chart and optional mapping sheets, Arabic headings, widths, frozen header, filter, RTL; text codes; no formulas. |
| CSV export | Implemented: UTF-8 BOM, CRLF, quoting, formula neutralisation; chart and mapping files. |
| Upload / bulk import | Not built and not implied by the UI. |

Export rules: `accounting.export` for any file; the mapping sheet/CSV additionally needs `expenses.view` (server-side; without it the workbook has no mapping content). Full scope = every account; filtered scope = the chart's own filtered rows with ancestors kept as labelled context rows, and the summary records scope, filter and whether context rows are included. Spreadsheet-application opening: **not verified** — no Excel/LibreOffice is installed here; the files were parsed with an independent reader (SheetJS) and their XML inspected.
CSV note: codes are quoted text, but Excel may still convert a leading-zero code when it opens a CSV; the XLSX is the faithful format for such codes.

### 14.2 Coverage matrix

Legend: **Default** = in `DEFAULT_CHART` (31 accounts). **Disposable** = observed in the verified disposable business (preview-database books café: 33 accounts = 31 default + 2 synthetic test accounts; 6 synthetic expense categories; no operating-expense rows; 2 synthetic journal entries of source `OPERATING_EXPENSE`). **Owner DB** = never inspected.

| Concept | Default | Disposable | Saved mapping | Scheduled | Proposed | Owner DB |
|---|---|---|---|---|---|---|
| 5000 costs and expenses (header) | yes | yes | – | – | – | not inspected |
| 5100 cost of sales / 5110 purchase discounts / 5200 inventory loss / 5300 cash variance | yes | yes | refused as targets | – | – | not inspected |
| 5900 other operating expense | yes | yes | allowed (explicit choice only) | – | – | not inspected |
| 5400 operating expenses header | no | no | – | – | proposal | not inspected |
| 5410 cleaning · 5420 maintenance · 5430 wages · 5440 utilities · 5450 rent | no | 5420 is **occupied** by an unrelated synthetic account; others free | none in the preview DB at the time of inspection | none | proposals; codes provisional (D1) | not inspected |
| Payment processing fees, delivery commissions, marketing, internet/software, licences | no | no | – | – | proposals below | not inspected |
| Fixed assets, accumulated depreciation, depreciation expense | no | no | – | – | proposals below | not inspected |
| Prepaid expenses, deposits | no | no | – | – | proposals below | not inspected |
| Accrued expenses, wages payable | no | no | – | – | proposals below | not inspected |
| Employee advances | no (1300 is *supplier* advances) | no | – | – | proposal below | not inspected |
| Owner drawings | no (3100 capital, 3200 opening, 3300 retained earnings) | no | – | – | proposal below | not inspected |
| Card/wallet clearing 1140/1150, customer receivable 1160, supplier advances 1300, customer credit 2300 | yes | yes | – | – | – | not inspected |

Duplicate-concept checks before creating anything: 1300 "دفعات مقدمة للموردين" is not employee advances; 5900 is a catch-all, not a substitute for the specific accounts; 5110 purchase discounts is a *credit-side expense account* (contra to cost of sales) and must not be used as a mapping target. A renamed or re-coded account is matched by system identity or by the saved mapping, never by code; the creation flow refuses an occupied code, so an occupied proposal (like 5420 above) is reported and the accountant decides whether to reuse, renumber or create under another code.

### 14.3 Recommended additions (proposals — nothing is created in any owner data)

Codes are free in the default template; occupancy in each real business must be checked at creation. "Source" is the operational feed that would post to it (none of the new accounts is posted to by any current rule).

| Code | Account | Type · side | Parent · postable | Report classification (proposed, see §17) | Operational source |
|---|---|---|---|---|---|
| 5400 | مصروفات التشغيل | Expense · debit | 5000 · group | operating expenses (group) | – |
| 5410 | نظافة ومستلزمات نظافة | Expense · debit | 5400 · posting | operating expense | expense category "نظافة" |
| 5420 | صيانة وإصلاحات دورية | Expense · debit | 5400 · posting | operating expense | expense category "صيانة"; routine only |
| 5430 | رواتب وأجور | Expense · debit | 5400 · posting | operating expense (payroll) | payroll (not implemented); recognition basis D6 |
| 5440 | مرافق | Expense · debit | 5400 · posting | operating expense | expense category "مرافق" |
| 5450 | إيجار | Expense · debit | 5400 · posting | operating expense | expense category "إيجار" |
| 5460 | رسوم معالجة المدفوعات | Expense · debit | 5400 · posting | operating expense (financing/payments cost per accountant) | processor settlement vs 1140/1150 clearing (no module) |
| 5470 | عمولات منصات التوصيل | Expense · debit | 5400 · posting | operating expense | delivery-platform settlement (no module) |
| 5480 | تسويق وإعلان | Expense · debit | 5400 · posting | operating expense | expense category (marketing) |
| 5490 | اشتراكات إنترنت وبرمجيات | Expense · debit | 5400 · posting | operating expense | expense category |
| 5495 | تراخيص ورسوم حكومية | Expense · debit | 5400 · posting | operating expense | expense category; statutory treatment and any rates are the accountant's, not invented here |
| 1500 | الأصول الثابتة | Asset · debit | 1000 · group | fixed assets (group) | – |
| 1510 / 1520 | معدات / أثاث | Asset · debit | 1500 · posting | fixed assets | purchase of equipment above the capitalisation threshold (no module) |
| 1590 | مجمع الإهلاك | Asset · **credit** (contra) | 1500 · posting | fixed assets (contra) | depreciation run (no module) |
| 5500 | مصروف الإهلاك | Expense · debit | 5000 · posting | operating expense (non-cash) | depreciation run |
| 1310 | مصروفات مدفوعة مقدمًا | Asset · debit | 1000 · posting | current assets | prepayments (e.g. rent paid ahead) |
| 1320 | تأمينات وودائع | Asset · debit | 1000 · posting | current assets / non-current per accountant | deposits |
| 1350 | سلف الموظفين | Asset · debit | 1000 · posting | current assets — **not an expense** | cash paid to an employee (no module) |
| 2400 | مصروفات مستحقة | Liability · credit | 2000 · posting | current liabilities | accruals |
| 2410 | أجور مستحقة | Liability · credit | 2000 · posting | current liabilities | payroll accrual before payment |
| 3400 | مسحوبات المالك | Equity · **debit** (contra) | 3000 · posting | equity movement — **not an expense** | owner withdrawal from treasury |

Minimum café chart recommended: the 31 default accounts, plus 5400–5450 (the five requested categories under the 5400 group), 5480 marketing and 5460 processor fees if cards/wallets are used, 1350 employee advances and 3400 owner drawings so those flows never land in expenses, and 1310/2400/2410 only once accrual accounting is chosen. Fixed assets/depreciation, licences and delivery commissions are conditional on the business using them.

Separations the chart must keep: routine repairs (5420) versus capital equipment (1510/1520, capitalised and depreciated); wages **expense** (5430, when earned) versus the **payment** of wages (cash/bank credit, clearing 2410 if accrued); employee advances (asset 1350, recovered through payroll) versus expenses; owner drawings (equity) versus expenses; purchase of stock (inventory 1200) versus cost of sales (5100).

### 14.4 Unresolved policy choices for the accountant

1. Accrual versus cash basis for rent, utilities and wages (decides whether 1310/2400/2410 exist). 2. Payroll recognition source and timing (D6) and whether wages post gross or net. 3. Capitalisation threshold, useful lives and depreciation method; whether depreciation is booked monthly. 4. Whether processor fees and delivery commissions are operating expense or a separate financing-cost line; whether they are netted from settlements or posted gross. 5. Treatment of deposits (current versus non-current). 6. Whether purchase discounts (5110) stay a cost-of-sales contra account. 7. Licences and government fees: classification and any statutory rules. 8. Employee advance recovery and write-off policy. 9. Owner drawings approval path. 10. Final codes (D1). No tax rate, statutory rule or payroll policy is assumed anywhere in this packet.

## 15. 4B.2C — environment and acceptance evidence

**Source checks** (worktree, branch `codex/nextcup-workspace-redesign-20261102`, base commit `a6fa68b`): `tsc --noEmit` clean; `eslint src tests`: 0 errors (62 pre-existing warnings); accounting database/API suites `accounting-001` … `accounting-015` run serially: **58 tests, 58 pass** (new: 012 hardening, 013 posted-expense acknowledgement, 014 export files, 015 creation/editing/export over HTTP). Two earlier suites (`acc01b-*`, `treasury-003-*`) are authorization-gated runtime suites and were **not run**.

**Prisma client.** Reverified: `node_modules` in this worktree was a junction to the main checkout's shared directory, so `prisma generate` rewrote the *shared* client and could not replace the engine DLL while servers held it; the previous stage then copied `schema.prisma` into the shared client by hand. That manual edit was a mistake and is disclosed: the shared client still carries it (its engine file was not modified). Now fixed for this worktree only: `artifacts/erp-experience-20261102/step4b2/local-node-modules.mjs` replaces the junction with a real directory of per-package junctions plus a *copied* `@prisma/client`, so official `npx prisma generate` runs locally ("Generated Prisma Client (v6.19.3)") and nothing in the shared tree is edited (`--restore` relinks it). Servers started from the shared directory were not touched except the two owned by this worktree (see below). Recommended for the main checkout: re-run `prisma generate` there when no process holds the engine.

**Databases.** Writes only to databases whose identity was verified first (name, OID, port, data directory, `_disposable_test_database` marker). `cafe_ops_test`: migration `20261105090000` was the only pending migration when applied (the 4B.2 migration had been applied the day before). Preview database `cafe_ops_test_integr20261101_replay_66515e42c85e8ec4` (OID 65538): `prisma migrate status` listed exactly `20261104120000` and `20261105090000` pending before they were applied; the 91 earlier rows and checksums are unchanged. The disposable cluster stopped once during a heavy build and was restarted with the project's own `test-db.mjs up` (no data changed). The owner database (5433) was never contacted.

**Preview 3113.** The reviewed guard pins 91 migrations, so a copy `workspace-guard-4b2.mjs` was made whose only change is that number (93); the reviewed guard and all earlier configs are untouched, and the new config records the 93 rows read from the database, the source manifest (1011 files) and the new guard hash. One integration build (`.next-integration`, build id `Vwi87zApGwa5Q30Uk5Aos`) serves **http://localhost:3113/accounting/chart**; the guard verified source, migrations, database identity and HTTP/database correspondence on start. The previous 3113 process and my test server were stopped first (both started from this worktree). `artifacts/erp-experience-20261102/step4b2/verify.mjs` against 3113: chart locks and eligibility-filtered selector; root group, sub-group and posting account created; duplicate, posting parent, posting root and cycle refused; cost of sales refused as a mapping target and a mapped account refused deactivation; rename and recode followed by the saved mapping and the ledger link; full XLSX (three sheets, no formulas) and filtered CSV matching the chart; waiter 403 on export and writes; another café unable to see or edit these accounts. Login for the preview is the retained synthetic books-owner fixture of the earlier previews.

**UI.** Checked in the built-in browser pane (emulation, not a physical device) on the test server 3100 and the preview 3113: desktop 1280 and phone 375 (no horizontal page scroll), the add-group and add-sub-account buttons, the dialogs (group with type/parent/derived side, validation message, Escape closes), the edit dialog with the locked deactivate control and the "fixed" explanation, the export toolbar (scope select, mapping checkbox, Excel/CSV buttons), and RTL Arabic text. Screenshots: `artifacts/erp-experience-20261102/step4b2/b2-*.jpg`, `preview-3113-chart.jpg`. Not verified: a real phone or tablet, keyboard-only walkthrough beyond Tab/Escape, opening the XLSX/CSV in a desktop spreadsheet application (none installed; parsed with SheetJS and by inspecting the XML instead), and the browser's own download dialog.

**Not done.** Owner visual acceptance; any owner-database step; commit, push, merge, deployment.


## 16. 4B.3 — approval dependencies (posting stays closed)

Posting activation remains gated on: accountant approval of the mapping table and codes (D1); D6 payroll recognition; D7 operating facts and account identities for clearing, bank, wallet, credit and advances; D8 cutover date and opening balances (the mapping's earliest effective date); an explicit decision on recognition date versus payment date and on returns (a return posts against the account of the original expense's entry); a separate approval to turn the existing expense/return posting gate on; and a verified disposable run proving balanced entries, period handling, source traceability and exactly-once posting. Nothing in 4B.2 posts, reclassifies or reverses a journal entry.

## 17. 4B.4 — report classification requirements (design only; not implemented)

Finding: `incomeStatement` (src/lib/accounting/statements.ts) identifies cost of sales only by `systemKey === "COST_OF_SALES"`; every other EXPENSE account — including `PURCHASE_DISCOUNTS` (credit-side), `INVENTORY_LOSS` and `CASH_OVER_SHORT` — falls into operating expenses. An accountant-added cost-of-sales account (for example a second COGS account for beverages) would be shown below gross profit and gross profit would be overstated. The cash-flow statement classifies by source type and a fixed cash-key list, so a new bank-like account is not a cash account unless it carries the right key. The balance sheet groups by account type only, so contra assets (1590) and equity drawings (3400) depend on `normalBalance` handling that exists but has no explicit section.

Proposed design (needs accountant approval, then its own migration):
- Add `enum AccountReportClass { REVENUE, CONTRA_REVENUE, COST_OF_SALES, OPERATING_EXPENSE, NON_OPERATING_EXPENSE, CURRENT_ASSET, FIXED_ASSET, CONTRA_ASSET, CURRENT_LIABILITY, NON_CURRENT_LIABILITY, EQUITY, EQUITY_DISTRIBUTION }` and a nullable `AccountingAccount.reportClass` (null = derive from `type`/`systemKey` exactly as today, so existing books report identically).
- Backward-compatible default mapping: `COST_OF_SALES` → COST_OF_SALES, `PURCHASE_DISCOUNTS` → COST_OF_SALES (credit), other expenses → OPERATING_EXPENSE (`INVENTORY_LOSS` and `CASH_OVER_SHORT` stay operating unless the accountant says otherwise), headers unclassified.
- Account administration gains a "report classification" field with the same guards as type (frozen once lines exist), and mapping eligibility would be defined by class instead of the system-key list (the 4B.2 key list is the interim rule).
- P&L sums by class; gross profit = revenue − COST_OF_SALES class; tests: second COGS account; purchase discount contra; inventory loss and cash variance placement; branch-scoped statements; an account with no class; totals still reconcile to the trial balance; periods before the change report identically (no restatement without approval).
- Cash flow: classification by a cash-equivalent flag rather than the fixed key list, with the same reconciliation test (opening + net change = closing).
- Regression scenarios for 4B.4: add COGS account → gross profit changes only after the accountant classifies it; deactivating an unused account does not change totals; renaming/recoding never changes a statement; drawings reduce equity, never profit; employee advances never appear in expenses; contra assets reduce fixed assets.

## 18. Proposed commit scope (reviewable, not committed)

Source/schema: `prisma/migrations/20261105090000_mapping_guard_hardening/`; `src/lib/accounting/{chart-view,chart-view-queries,setup,chart-export,chart-export-queries}.ts`; `src/lib/{xlsx,report-output}.ts` (filter option, exported `csvCell`); `src/app/api/accounting/{accounts/route.ts,chart-of-accounts/route.ts,chart-of-accounts/export/route.ts,expense-category-mappings/preview/route.ts}`; `src/app/(app)/accounting/chart/page.tsx`; `src/components/accounting/chart-setup-dialogs.tsx`. Tests: `tests/accounting-012` … `accounting-015` and `tests/helpers/http.ts`. Evidence and scripts under `artifacts/erp-experience-20261102/step4b2/` stay uncommitted. The owner's modified sidebar, reports, styles and compact expense list are not part of this scope and were not touched.
