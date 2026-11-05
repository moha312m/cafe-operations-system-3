# NEXT CUP café trial

Use the same HTTPS address on the café PC and phone:
https://cheerful-grace-production-9236.up.railway.app

Sign in with the existing accounts for café `next`, main branch. Use an owner account for settings, table setup, finance and reports; use the existing cashier account on the PC and waiter account on the phone for normal service. Do not share the super-admin account with floor staff. The phone and PC use the cloud database, so they do not need a localhost address or access to this development computer. Both need a working internet connection.

Before the first ground test, the cashier opens their actual shift and enters the counted starting drawer cash. No invented opening cash, seed accounts or synthetic orders are provided by this release.

1. On the PC, verify the existing 207 active menu items and the main branch's 15 dining tables.
2. On the phone, open Tables/POS with the waiter account and select a vacant configured table.
3. Place one intentional café test order. Watch it appear on the PC; confirm the chosen table is occupied and item/variant/add-on prices agree.
4. Follow the existing approval/preparation/service flow, collect the actual payment once, and verify its receipt and sales/collection report.
5. Confirm the table becomes available after the session is settled/closed. Check the payment and drawer before trying any correction or refund.

These are owner-run real transaction checks. This release's automated checks do not insert fake orders, payments or shifts into production. Retry an uncertain payment using its existing pending action/retry flow; first check whether it already succeeded on the other device.

The owner explicitly approved temporary `OVERRIDE_ALL` inventory enforcement for café `next` on 2026-11-02 because its 207 products have no recipes. The setting change is pending normal owner sign-in and must be confirmed through the app and its audit. This mode allows the trial while recipes are absent; ingredient consumption and product cost/profit reports are incomplete. Supply actual product/variant/add-on recipes and opening stock before switching back to the intended stricter inventory policy. Other cafés' policies are not part of this approval.

Finance account balances remain unknown until the existing opening approval process is completed; accounting remains unconfigured/SHADOW unless separately configured. No accounting books or opening entries are created by visiting the new dashboards. Physical printer behavior, actual phone hardware and end-to-end payment handling still require this café trial.

Optional place-photo uploads need persistent private media storage. The production app currently has no upload volume; do not upload place photos until that storage is configured. Existing menu image URLs and menu/table database records are preserved.

Pre-release protection: Railway volume backup dated 2026-11-02 12:40 Cairo, 123 MB, and read-only baseline hashes/counts for every existing business table. A restore rehearsal was not performed; the backup's restore operation is not certified. Never restore it over later orders without a separate recovery decision and reconciliation.

Current release status and exact preservation checks are in the final release report beside this guide.
