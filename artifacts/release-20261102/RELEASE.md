# NEXT CUP release — 2026-11-02

Status: COMPLETE for GitHub publication, Railway deployment, data preservation and the explicitly approved trial policy. Ready for a controlled owner-run café trial; physical phone/PC/printer/payment acceptance remains the on-site step.

Live app: https://cheerful-grace-production-9236.up.railway.app

GitHub main and release branch contain commit `f4ff365c472f55fca101250bc4ed897f8175b4d6`:
https://github.com/moha312m/cafe-operations-system-3/commit/f4ff365c472f55fca101250bc4ed897f8175b4d6

Railway production deployment `c4500142-57c1-4197-925b-a440c347d305` succeeded. Its public health check returned HTTP200, database up and commit `f4ff365c472f`. The existing service, database, PostgreSQL volume, authentication secret and public hostname were retained. GitHub main advanced by a normal fast-forward; no force push or owner-source copy was used. The GitHub connector could not update refs, so the authenticated native Git connection performed that authorized push.

## Verification and data protection

- A new Railway database volume backup was created at 12:40 Cairo, 123 MB. Screenshot: `railway-pre-release-backup.png`. No restore rehearsal was performed; do not claim tested disaster recovery.
- Read-only production inspection found 57 applied migrations. Every checksum matched the exact committed LF Git blob; Windows CRLF hashes were not used as a production reference. The 34 pending integration migrations were reviewed for business rewrites; inventory tenant consistency and branch table-number uniqueness passed. The workspace redesign itself added no migration.
- A clean 963-file source snapshot passed an isolated webpack production build and strict TypeScript. All snapshot source files matched the published Git tree, allowing only text line-ending normalization. Existing dependencies were reused locally; generated builds, private configuration, fixtures and owner-local files were excluded from Git.
- Fresh focused tests: 29 passed, zero failed/skipped. Lint: zero errors/warnings. The earlier retained integration/runtime/browser evidence remains unchanged and is not presented as rerun for this release.
- Railway performed its own successful Linux/Node22/Prisma6 production build, generated Prisma Client, and applied all 34 migrations in its existing pre-deploy pipeline. All 91 are now applied, with zero failed/pending records. No reset, seed, opening entry, historical import or accounting cutover ran.
- Post-deploy read-only hashes/counts matched all original business records in 52 tables. Observed exceptions were login/audit activity, user login timestamps and normal permission-catalog synchronization. After the separately approved trial-policy change, a final check confirmed 51 business tables still match exactly. This includes Product224, ProductVariant91, MenuCategory34, CafeTable30, Order85, OrderItem165, Payment80, Shift8, TableSession13 and all original inventory/financial records.
- Both cafés and all existing accounts remain. Café `next` retains its 207 active products, main branch and 15 dining tables. Zero AccountingEntity, MoneyAccount or JournalEntry rows were created by the new workspace views.

## Approved trial policy

The owner explicitly chose “Enable Override all for the café trial” after being told that café `next` has no recipes and its previous ALLOW_NEGATIVE_STOCK mode still blocks missing recipes. Only `next` was changed to OVERRIDE_ALL. The transaction asserted that only inventoryEnforcementMode and updatedAt changed, and recorded a system audit without impersonating a staff member. Audit `cmvz5h0dz0001hl1ss71t222n` names this owner-authorized release operation and records old/new values. No other café policy, opening balance, menu, table, stock, password or money record was changed.

The current browser owner session belongs to قهوة المدينة. The existing café `next` owner account is `next@next.cafe`; use its existing password to view the intended café. No password was read, reset or republished. Use existing cashier/waiter accounts for staff devices.

## Availability and browser checks

Configured the existing app's next deployments for `/api/health`, 180-second health timeout, 60-second overlap, 30-second request draining, 300-second migration timeout, no application sleep, and on-failure restart (3 retries). Build command uses production webpack with the Git commit as Next deployment ID for version-skew protection. Existing `npx prisma migrate deploy`, AUTH_SECRET and DATABASE_URL were retained. No PostgreSQL restart/replacement or service/volume removal occurred.

The signed-in real owner session loaded Finance (9 links), table management (15 existing tables), Report Center (6 categories, 19 entries) and POS. The public `next` QR menu rendered all 207 existing items. Actual 390x844 phone layouts were checked for the public menu, table management, report center and POS with no document overflow; desktop Finance/table management were checked at 1280 pixels. Screenshots and `production-browser-checks.json` retain the evidence, including explicit viewport calibration. All temporary viewport overrides were cleared. No live order/payment/refund/table mutation was generated by browser checks. Production restricted-role acceptance and real hardware/printing were not performed; those boundaries were exercised earlier on the disposable target.

## Ground trial and recovery

Follow `CAFE-TRIAL.md`: PC cashier opens the real shift with counted cash, phone waiter places one intentional test order, PC confirms the same table/order, takes one actual payment and checks its receipt/report, then verifies the settled table becomes vacant. Both devices use the same HTTPS URL and need internet. Do not use localhost from the phone. Stock consumption/cost reporting remains incomplete in OVERRIDE_ALL until real recipes/stock are configured. General-ledger reports remain unconfigured/SHADOW until separately approved setup.

Optional place-photo uploads have no durable app volume yet; do not use them until private persistent storage is configured. Existing menu image URLs remain intact. Scheduled backup retention and restore drills remain separate operational setup; only the manual pre-release backup was created here. No claim of uninterrupted internet/service or full financial/hardware certification is made.

Previous successful Railway deployment: `7827966a-4c7e-4b74-9706-6e7a434df411`, source `5314becf8a26385c2ada7e2993293e7188904142`. Railway retains the old deployment, but compatibility with the migrated schema is not fully certified; prefer reviewed forward recovery. Never restore the pre-release database over later orders without an explicit recovery decision and reconciliation. The original local owner checkout/app on3110/database5433 were not switched by this cloud release.
