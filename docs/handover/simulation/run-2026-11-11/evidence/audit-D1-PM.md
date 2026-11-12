# Audit D1-PM: evening shift #2 (كريم) and end of day 1, فرع التجمع

- Auditor: independent, read-only. DB access was SELECT only, inside `SET TRANSACTION READ ONLY`, against `127.0.0.1:5434/cafe_ops_test`. App reads were GET only, as owner@demo.com, through `sim.mjs` (scene D1-PM-AUDIT).
- The P&L was read with `autoSync=false`. A plain `GET /api/accounting/pnl` runs `projectShadowLedger` and posts journal entries (`src/lib/accounting/pnl.ts:271`), and the auditor must not write. The trial balance and journal routes do not sync.
- Snapshot: DB `now()` 15:22–15:38Z. The state was stable: the last AuditLog row was at 15:20:59.903Z. There were still 2 projection runs and 187 journal entries, freeze cmwc9mzfh00cihljoyihiaflj was unreleased, and handover cmwc9mzdx00cehljodn25jwq6 was OUTGOING_SUBMITTED.
- Scope:
  - Shift #2 `cmwc8me2n00t7hl54aq8ww1fl`: opened 14:52:00.570Z with 1564.95; financially closed 15:20:27.599Z; status AWAITING_HANDOVER; `stockClosedAt` NULL.
  - Handover `cmwc9mzdx00cehljodn25jwq6` (SHIFT_TO_SHIFT, direct, OUTGOING_SUBMITTED, incoming NULL).
  - Count `cmwc9n0z600cwhljo150q2tx0`.
  - Disposition `cmwc9mzfw00cohljonebr52yp`.
  - End of day: both shifts.

People (id suffix): `7tkq9c` سارة · `owrm77` كريم · `da63ro` وليد · `3pzi24` مازن · `dkossi` عادل · `fhgxvh` owner · `qvoxv5` "كريم الكاشير" (seed) · `bau4ln` "وليد الويتر" (seed).

---

## 1. Evening drawer, card, wallet

### 1a. Raw Payment rows with `shiftId = shift #2` (all COLLECTION/PAID; cashier = receivedBy = كريم)

| Order | Payment | Method | Amount | Note |
|---|---|---|---|---|
| #34 | cmwc973lj000jhljo2cph8g0a | CARD | 28.50 | controls tester, using كريم's login |
| #36 | cmwc9d71p001ohljou2ubkvkf | CASH | 148.20 | |
| #41 | cmwc9dfae003lhljodudh1enz | CASH | 108.30 | |
| #42 | cmwc9dfna003xhljodykjtgp3 | CASH | 136.80 | |
| #43 | cmwc9dfzv0048hljoozbjkojt | CASH | 57.00 | |
| #44 | cmwc9dgqv004jhljovd85877p | CARD | 57.00 | |
| #45 | cmwc9dhjb004vhljo0d7ag5dk | CARD | 131.10 | |
| #46 | cmwc9dhzm0057hljohts0p1jc | WALLET | 79.80 | |
| #47 | cmwc9digr005jhljosz4y7lbg / cmwc9digx005lhljon4v7cuef | CASH / CARD | 100.00 / 71.00 | split |
| #35 (T5) | cmwc9efhe005shljofbq74vuj | CASH | 57.00 | table session cmwc9d6s60018hljoojomqlrh |
| #37 (T6) | cmwc9eftv005whljotb5fqizm | CARD | 148.20 | table session cmwc9d77s0020hljoyhcap47t |
| #38 (T7) | cmwc9eg5d0060hljo26sojrtq | WALLET | 96.90 | table session cmwc9d7li002ghljoqsqk93yr |
| #40 (T7) | cmwc9eg5s0062hljo1mygniv5 | WALLET | 68.40 | same session |
| #39 (T8) | cmwc9egh20066hljobuci2ijo | CASH | 51.30 | table session cmwc9d7ws002vhljo0brdyhh1 |

- No REFUND rows were created in the evening.
- The two refund requests on #23 (cmwc94ygq0001hljogqsn26qa, cmwc97x3a000qhljoqwqn9aje) are REJECTED by the owner at 15:12:00/15:12:01. No payment or stock was touched.
- Order #23 is unchanged.

### 1b. Other cash movements in the shift window (14:52:00 to 15:20:27)

| Source | Rows | Amount |
|---|---|---|
| OperatingExpense / returns / advances / CashDelivery / CashStorageMovement / OpeningCashReceipt | none | 0 |
| ShiftCashDisposition cmwc9mzfw00cohljonebr52yp | CLOSE_RETAIN_ALL: delivered 0, retained 2223.55 | 0 handed out |
| **PurchasePayment** cmwc8t6qs00ukhl54t7389sx9 (14:57:17.666) · cmwc96tu80007hljo8enapeym (15:07:54.128) · cmwc96u5a000bhljo75q4ef2p (15:07:54.526) | 3 rows: CASH, by عادل, INV-D1-001, `shiftId` NULL, `fundingSource` NULL | **3.00** |

### 1c. Recomputation

| Line | Auditor | App (Shift row / report) |
|---|---|---|
| Opening (taken over, no recount) | 1564.95 | 1564.95 |
| + cash collected (7 rows) | 658.60 | 658.60 (`totalCashSales`) |
| − cash refunds | 0 | 0 |
| − expenses / advances / handed out | 0 | 0 |
| − supplier cash payments in window | **3.00** (if they left the drawer) | 0 (`totalCashPayouts`) |
| **Expected drawer** | **2223.55** if the 3 EGP did not come from the drawer; **2220.55** if they did | **2223.55** (`expectedCashAmount`) |
| Counted | 2223.55 | 2223.55 (`actualCashAmount`, disposition `countedCash`) |
| Difference | 0.00, or **+3.00** unexplained | 0 (`cashDifference`) |

| Tender | Raw rows | Raw | Shift row | TenderReconciliation (counted) | Diff | Status |
|---|---|---|---|---|---|---|
| CARD | #34 28.5, #44 57, #45 131.1, #47 71, #37 148.2 (5) | **435.80** | 435.80 | cmwc9mzcr00cahljohd3qxu3s 435.80 | 0 | SUBMITTED, no approver, NOT_EVIDENCED |
| WALLET | #46 79.8, #38 96.9, #40 68.4 (3) | **245.10** | 245.10 | cmwc9mzcy00cchljon6pktxu3 245.10 | 0 | SUBMITTED, no approver, NOT_EVIDENCED |

Totals check:
- 658.60 + 435.80 + 245.10 = 1339.50 = `totalSales`.
- 14 orders (#34–#47), all SERVED and PAID. Ex-VAT 1175.00, VAT 164.50, no discount, no service charge.

## 2. Stock

### 2a. Evening consumption (verified variant recipes plus the seed شاي recipe) against the ledger

Every evening order was served under STRICT, with custody `…rmodnb` (كريम) and shift `…8ww1fl`. Each one has exactly the expected USAGE rows. No (order, item) pair appears twice anywhere in the ledger, and nothing was served with an unverified recipe.

| Item | Build-up (auditor) | Expected use | Ledger USAGE | Cost |
|---|---|---|---|---|
| بن KG | #36 .018, #37 .018, #39 .009, #41 .018, #42 .018, #44 .009, #45 .009, #46 .009, #47 .018 | 0.126 | −0.126 (9 rows) | 56.70 |
| لبن L | #36 .18, #37 .18, #41 .30, #44 .12, #45 .15, #47 .24 | 1.170 | −1.17 (6) | 44.46 |
| كاسات PC | #34 1, #35 2, #36 1, #37 1, #38 2, #39 1, #41 1, #42 2, #43 2, #44 1, #45 1, #46 2, #47 1 | 18 | −18 (13) | 45.00 |
| أغطية PC | #36, #37, #38, #41, #42, #44, #45, #47 | 8 | −8 (8) | 12.00 |
| شاي أخضر BOX | 0.02 × 7 cups (#34 1, #35 2, #38 1, #43 2, #46 1) | 0.14 | −0.14 (5) | 11.90 |
| كرواسون PC | #36, #37, #40, #45, #47 | 5 | −5 (5) | 100.00 |
| برتقال KG | #38, #42 | 0.8 | −0.8 (2) | 24.00 |
| **Evening COGS** | | | 48 rows | **294.06** |

### 2b. Morning snapshot to end of day

| Item | AM handover / AM audit | − evening use | Expected | InventoryItem.currentStock | Σ ledger | Evening count |
|---|---|---|---|---|---|---|
| بن | 11.784 | 0.126 | **11.658** | 11.658 | 11.658 | **11.658** (diff 0) |
| لبن | 38.010 | 1.170 | **36.840** | 36.84 | 36.84 | **36.84** (diff 0) |
| كاسات | 669 | 18 | 651 | 651 | 651 | not counted |
| أغطية | 486 | 8 | 478 | 478 | 478 | not counted |
| شاي أخضر | 2.74 | 0.14 | 2.60 | 2.6 | 2.6 | not counted |
| كرواسون (قطعة) | 24 | 5 | 19 | 19 | 19 | not counted |
| برتقال | 8.4 | 0.8 | 7.6 | 7.6 | 7.6 | not counted |
| صوص فانيليا | 5 | 0 | 5 (true 4.98, AM F5) | 5 | 5 | not counted |
| صوص كراميل | 4 | 0 | 4 | 4 | 4 | not counted |

Other stock checks:
- The only other stock rows since the morning are 2 COUNT_REBASE rows with 0 delta at 14:52:02 (by كريم, booked to سارة's custody `…1bqzks`/shift #1). That is the acceptance of the morning handover.
- There were no purchases, transfers, waste or manual movements in the evening.
- The last stock row is at 15:18:15.429. The freeze started at 15:20:27.867, and no row exists after it.
- Perpetual valuation Σ(currentStock × cost) = **10939.52**. That is 11695.00 received/opening − 461.42 (AM) − 294.06 (PM).

Evening count `cmwc9n0z600cwhljo150q2tx0` (BLIND, CRITICAL_ONLY, status CONFIRMED, `validation` SYSTEM_MATCHING_QUANTITIES):
- Lines: لبن cmwc9n0z600czhljons34kee8 counted 36.84 at 15:20:49.835; بن cmwc9n0z600cyhljoizsgnrmh counted 11.658 at 15:20:49.895, 60 ms later.
- Counter and initiator are كريم; `confirmedById` NULL; `lockedAt` NULL. `startedAt` equals the first `countedAt`.
- `confidenceWindowFrom` is 12:45:38 (the morning close), not the 14:52 acceptance.

## 3. End of day: both shifts

### 3a. Day reconciliation (branch فرع التجمع, business day 2026-11-11, Africa/Cairo)

"Raw" means rows tied to shifts #1 and #2. The seed rows (order #11 with a card payment of 233.70, and the second #15 cash row of 148.20) are shown separately.

| Figure | Auditor expected (raw) | Counted / reconciled | Recorded by the app (best source) | Books (TB/P&L today, as stored) | Difference |
|---|---|---|---|---|---|
| Opening float | 500.00 | not counted | Shift #1 500 | **not booked** | books −500 |
| Cash collected | 2177.45 (1518.85 + 658.60, 20 rows) | n/a | daily `cashCollections` 2325.65 (includes seed 148.20) | 1110 Dr 1667.05 (AM only, includes seed 148.20) | daily +148.20; books −658.60 (PM missing) |
| Cash refunds | 153.90 | n/a | 153.90 | 1110 Cr 153.90 | 0 |
| Supplier cash paid | 300 (AM) + 3 (PM) = 303 | n/a | Shift payouts 0 / 0; daily `supplierPayments` 303 | not posted (2 BLOCKING, 2 not yet seen) | drawer logic misses 303 |
| **Drawer at day end** | **2223.55** (500 + 2177.45 − 153.90 − 300; the 3 EGP assumed not from the drawer) | **2223.55** (one physical drawer, held by كريم) | Shift #2 expected 2223.55; shift #1 expected 1864.95, so the −300 is on سارة | **1110 = 1213.15** | books −1010.40 (−500 float, +148.20 seed duplicate, −658.60 PM not projected) |
| Card | 1105.75 (669.95 + 435.80, 12 rows) | 1105.75 (2 reconciliations, unapproved) | daily 1339.45 (+233.70 seed #11) | 1140 today Dr 903.65 (669.95 + 233.70) | books −435.80 (PM) |
| Wallet | 632.70 (387.60 + 245.10) | 632.70 | daily 632.70 | 1150 Dr 387.60 | books −245.10 (PM) |
| Sales ex-VAT | 3435.00 (2260 + 1175, 34 orders) | | daily 3640.00 (+205 seed #11, 35 orders) | 4100 = 2465.00 | books −1175.00 |
| VAT | 480.90 (316.40 + 164.50) | | daily 509.60 (+28.70 seed) | 2200 today Cr 345.10 | books −164.50; refund VAT 18.90 never reversed |
| Sales incl. VAT | 3915.90 | | daily `grossSales` 4149.60 | | |
| Refunds | 153.90 gross = 135.00 ex-VAT + 18.90 VAT | | 153.90 everywhere | 4400 Dr 153.90 (gross) | VAT split missing (AM F4) |
| Net sales ex-VAT | 3300.00 | | daily `netSales` 3995.70 (incl. VAT and seed) | net revenue 2311.10 | |
| COGS | 755.48 ledger (461.42 + 294.06); about 777.58 with the untracked #12 (+22.10) | | InventoryTransaction USAGE 755.48 | 5100 = 461.42 | books −294.06 |
| Gross margin | 3300.00 − 755.48 = **2544.52 (77.1 %)** | | | gross profit 1849.68 (80 %) | |
| Cash over/short | 0 (the −300 is the supplier payment) | | VarianceCase cmwc434dk00ruhl544y6ar9uh −300 OPEN | 5300 = 300 | +300 false loss |
| Net profit | 2544.52 (no opex) | | | 1549.68 | |
| Inventory value | 10939.52 | 2 of 9 items counted (match) | 10939.52 | 1200 = 11233.58 | books +294.06 |
| Suppliers payable | 1050 − 303 = 747 (of which only 300 is traceable to a drawer) | | invoice paid 303, remaining 747 | 2100 = 1050 | books +303 |

Notes on the books:
- Trial balance today: debits 21457.92 = credits 21457.92, **balanced**, but identical to the morning.
- Journal: 123 entries dated today and 187 in total. The last entry was posted at 14:58:21.646Z.
- The evening is **absent from the books**. There have been no projection runs since cmwc8wt7q01kohl54dforxuav (15:00:06–15:00:08Z, posted 0, replayed 127, 5 issues, `actorId` NULL).

If someone opens the P&L normally (autoSync), the projection should add these items (projected, not observed):
- Sales: 4100 +1175.00, 2200 +164.50.
- Collections: 1110 +658.60, 1140 +435.80, 1150 +245.10.
- COGS: 5100 +294.06.
- Two more BLOCKING issues, for cmwc96tu80007hljo8enapeym and cmwc96u5a000bhljo75q4ef2p.

Expected result: P&L sales 3640 (with seed #11), net revenue 3486.10, COGS 755.48, net profit 2430.62. Even then, 1110 would be 1871.75 against a physical 2223.55. The gap of 351.80 is the 500 float minus the 148.20 seed duplicate.

Events missing from the books:
- the 500 opening float (no entry and no OpeningCashReceipt);
- all 4 supplier cash payments (303), which cannot be posted because `fundingSource` is NULL;
- the drawer carried from shift #1 to shift #2 (1564.95) and overnight (2223.55): there is no custody, transfer or safe entry, only 1110 in aggregate;
- the entire evening shift, until the next autoSync;
- the VAT part of the #24 refund (18.90).

### 3b. End-of-day report agreement

| Report (GET, today) | Figure | Value | Raw / other report | Agree? |
|---|---|---|---|---|
| daily `totals` | orders / ex-VAT / VAT / incl. VAT | 35 / 3640 / 509.60 / 4149.60 | 34 shift orders + seed #11; items sum 3640 (69 units) | yes (includes seed #11) |
| daily `financials` | cash / card / wallet collections | 2325.65 / 1339.45 / 632.70 (total 4297.80) | shift rows 2177.45 / 1105.75 / 632.70 (3915.90) | **no**: +148.20 (#15 seed duplicate) and +233.70 (#11 seed) |
| daily `collection.paidTotal` | | 3762.00 | Σ Order.paidAmount = 3915.90 − 153.90 | different basis from `financials.collections` 4297.80 |
| daily `byCashier` | سارة / كريم | 2576.40 (23) / 1339.50 (15) | = shift totals | yes |
| daily `salesByStaff` | وليد 1385.10, سارة 1265.40, كريم 917.70, seed "كريم الكاشير" 381.90, seed "وليد الويتر" 199.50 | sum 4149.60 | | yes (seed users mixed in with real staff) |
| daily `shifts` | open 0 / closed 1 / cashDifferenceTotal −300 | | shift #2 is AWAITING_HANDOVER and holds the drawer | **no**: shift #2 is in neither count |
| daily `tables` | closedToday 8, collected 1128.60 | | 8 sessions, 1128.60 | yes |
| daily `purchases` | invoice 1050, supplierPayments 303, unpaid 747 | | PurchasePayment Σ 303 | yes (but 3 EGP have no source) |
| shift-sales (from=to=today) | shift #1: orders 12, "net" 1111.50, cash 1518.85, expected 1864.95, counted 1564.95, var −300 | | 20 orders, 2576.40 collected | **no** on orders/sales; cash matches the app's wrong expected |
| shift-sales | shift #2: orders 9, "net" 917.70, tax 112.70, cash 658.60, card 435.80, wallet 245.10, expected = counted 2223.55, var 0 | | 14 orders, 1339.50, ex-VAT 1175 | **no** on orders/sales (tables #35, #37–#40 = 421.80 incl. VAT are missing); tenders yes |
| shift-sales summary | "صافي اعتراف الورديات" 2029.20 | | daily netSales 3995.70 | **no** (1966.50 attributed to no shift) |
| sales-payments (today) | collections 6304.20 (51 rows), refunds 153.90, net 6150.30 | | daily 4297.80 | **no**: +2006.40 = seed card payments for #1–#10 (created 11-05..11-10, `paidAt` today) |
| sales-payments shift #2 | 1339.50 (15 rows) | | 15 rows 1339.50 | yes |
| product-sales (today) | itemNet 3640, canonicalNet 3995.70, tax 509.60, bridge −153.90 | | daily | yes |
| product-sales shift #2 | itemNet 805.00, canonicalNet 917.70 | | 1175 ex-VAT | **no** (−370 table items) |
| shift #2 report | sales 1339.50, cash 658.60, equation 2223.55; `productsSold` sum 805 (شاي 4, كرواسون 3) | | 7 tea, 5 croissants sold | money yes; **product mix no** |
| employee-variances | 1 row: سارة CASH −300, reason null, OPEN | | not a loss | consistent with app; wrong in substance (AM F1) |
| handover-accountability | KPIs: handovers 2, closes 2, matched 1, cashShortage 300, openIssues 1, stockNotCounted 1, openingsWithoutReceipt 1 | | | partly |
| handover-accountability | `ledgerTotals` expected 4088.50 / counted 3788.50 / retained 3788.50 | | one drawer: 2223.55 at day end | **no**: it adds the carried drawer twice |
| handover-accountability | evening close: stock items 0, notCounted 0 | | 2 counted (matched), 7 not counted | **no** (morning row says notCounted 7) |
| P&L (autoSync=false) | sales 2465, returns −153.90, COGS 461.42, cash variance 300, net 1549.68 | | raw 3435 / 755.48 / 0 | **no**: the evening is missing |
| trial balance | balanced 21457.92 | | | balanced but stale |
| journal | 123 today, 0 evening entries | | 14 sales, 15 collections, 48 stock rows | **no** |

## 4. Overnight state

- **Cash, 2223.55:**
  - CASH CustodyPeriod `cmwc8mfc100u8hl54tawqajw6` is OPEN, held by USER كريم (sole PRIMARY participant), opening 1564.95, `closingCashAmount` NULL.
  - The disposition is CLOSE_RETAIN_ALL: retained 2223.55, delivered 0. The status is "في الدرج كعهدة — بانتظار استلام الشيفت التالي".
  - Nothing went to a safe, the manager or the owner. كريم stays answerable until someone accepts handover cmwc9mzdx00cehljodn25jwq6.
  - Card 435.80 and wallet 245.10 are SUBMITTED, not approved and NOT_EVIDENCED. Nobody has verified them against a settlement.
- **Stock:**
  - STOCK CustodyPeriod `cmwc8mf9r00u0hl54xmrmodnb` is OPEN, held by كريم.
  - كريم is answerable for all 9 items: 2 counted (match) and 7 never counted today (كاسات 651, أغطية 478, شاي أخضر 2.6, كرواسون 19, برتقال 7.6, صوص فانيليا 5, صوص كراميل 4).
- **Freeze:** InventoryFreeze `cmwc9mzfh00cihljoyihiaflj` has been active since 15:20:27.867Z (started by كريم; `releasedAt` NULL). From code reading (not exercised):
  - `applyStockMutation` (`src/lib/ledger.ts:166`) throws InventoryFrozenError for any stock movement without the handover's freeze token. That covers manual movement, transfer, purchase confirm, count and finished-goods return.
  - Serving an order is still allowed. Its deduction is deferred (`recordDeferredDeduction`, `orders/[id]/status/route.ts:184`) until the freeze lifts. So sales can still consume stock that the ledger does not show.
  - The owner can force-release the freeze through `POST /api/branches/<id>/inventory-freeze/release`, with a reason.
  - No open orders, open table sessions or carried orders exist now (`carryOpenOrdersOnHandover = false`).
- **Next morning cashier:**
  1. Accept handover cmwc9mzdx00cehljodn25jwq6 as incoming. This opens shift #3 with 2223.55 and moves cash and stock custody to them. It also releases the freeze and rebases بن/لبن from count cmwc9n0z600cwhljo150q2tx0.
  2. Count the drawer and confirm 2223.55. Direct handover allows one-tap DIRECT_ACKNOWLEDGEMENT with no recount; that is what happened at 14:52, where `countedOpeningCash` and `cashVerifiedById` are NULL.
  3. Check بن 11.658 and لبن 36.84 against the shelf. The materials cadence is EVERY_SHIFT, mode SELECTED with بن/لبن only.

  Still open for the owner, and not blocking the acceptance:
  - VarianceCase cmwc434dk00ruhl544y6ar9uh (−300, OPEN);
  - HandoverIssue cmwc91alh01kvhl54y81snlls (OPEN, on the completed morning handover);
  - the 4 sourceless supplier payments.

## 5. Actors on evening rows

| Rows | Actor fields | Notes |
|---|---|---|
| Orders #34, #36, #41–#47 | createdById = servedById = كريم; prepared by مازن (14 PREPARATION_STARTED + 14 READY) | #34 was created by the controls tester **under كريم's account**; the record cannot tell them apart |
| Orders #35, #37–#40 | createdById = servedById = وليد; `saleShiftId` **NULL**, `servedShiftId` = shift #2 | sales belong to no shift |
| 15 Payments | cashierId = receivedById = كريم, shiftId = shift #2 | |
| 4 TableSessions | opened by وليد, collected and closed by كريم | |
| 48 USAGE rows | createdById = server (كريم 9 orders / وليد 5), custody …rmodnb, shift #2 | |
| 2 COUNT_REBASE (14:52) | كريم, booked to سارة's custody/shift | acceptance of the AM handover |
| 3 PurchasePayments | createdByUserId = عادل; shiftId, fundingSource NULL | the controls tester used عادل's account |
| 2 OwnerActionRequests (#23 refund) | requester = كريم (tester), decided by owner, decisionNote "طلب اختبار رقابة — مرفوض" | two PENDING requests for the same order and fingerprint were accepted |
| HandoverIssue cmwc91alh01kvhl54y81snlls | reported by سارة's account (tester) after acceptance | still OPEN, flags سارة |
| Shift #2 close, disposition, tender reconciliations, freeze, handover, count | كريم; `closedById` = كريم (correct this time) | approvedById, confirmedById and incoming are NULL |
| AccountingProjectionRun ×2 | `actorId` NULL | nobody knows who posted the books, and the 15:00 run came from a GET |

No AuditLog row in the window has a null userId. Every ORDER_SERVED actor matches `servedById`.

---

## Candidate findings (new, or AM findings whose numbers changed)

**P1. The evening is missing from the books, and only a GET of the P&L would post it.** High confidence.
- There are still 187 journal entries; the last was posted 14:58:21Z, and the last projection run was 15:00:06Z.
- Missing: sales 1175.00, VAT 164.50, collections 1339.50 and COGS 294.06.
- The trial balance reports "balanced" while missing a whole shift.
- Projection runs only from `GET /api/accounting/pnl` (autoSync default on, `pnl.ts:271`). That GET writes journal entries with `AccountingProjectionRun.actorId` NULL (runs cmwc8uhio00wfhl54lfgv4ad2 and cmwc8wt7q01kohl54dforxuav).
- The trial-balance and journal reads show whatever was last projected. There is no close-of-day trigger.

**P2. Sourceless cash supplier payments repeated inside an open shift (AM F1/F2, new numbers).** High confidence.
- PurchasePayment cmwc8t6qs00ukhl54t7389sx9, cmwc96tu80007hljo8enapeym and cmwc96u5a000bhljo75q4ef2p: 1 EGP CASH each, by عادل, at 14:57:17, 15:07:54.128 and 15:07:54.526. All three fall inside shift #2's window (the only open shift), with `shiftId` and `fundingSource` NULL.
- The invoice shows paid 303 / remaining 747. Only 300 of that is traceable to a drawer, through سارة's note.
- Shift #2 expected 2223.55 and counted 2223.55. Either the 3 EGP left no drawer (then the invoice paid amount is overstated by 3) or the drawer is +3 unexplained. Nobody is answerable for the 3 EGP.
- The day's supplier cash outflow (303) appears in no shift's payouts (0 / 0) and in no journal entry. 2100 still shows 1050. There will be 4 BLOCKING projection issues after the next sync.

**P3. Table/waiter orders have no sale shift, so the shift reports under-state sales (AM F6, new numbers).** High confidence.
- Orders #35, #37, #38, #39 and #40 (370.00 ex-VAT / 421.80 incl. VAT) have `saleShiftId` NULL, although they were collected (payments in shift #2) and served (`servedShiftId` = shift #2).
- Shift-sales reports shift #2 as "orders 9, net 917.70", against 14 orders and 1339.50.
- Product-sales for shift #2 shows itemNet 805 against 1175. The shift report `productsSold` shows شاي 4 and كرواسون 3, against 7 and 5 sold.
- Day: "صافي اعتراف الورديات" is 2029.20, against daily netSales 3995.70. 1966.50 of the day's sales is attributed to no shift.
- The "net" column (الصافي) includes VAT: 917.70 = gross, while tax 112.70 is shown beside it.

**P4. Handover-accountability adds the carried drawer twice and hides the evening stock (AM F7, new numbers).** Medium-high confidence.
- `ledgerTotals` and `employeeTotals` show expected 4088.50, counted 3788.50 and retained 3788.50. That is 1864.95 + 2223.55 and 1564.95 + 2223.55, but there is one physical drawer of 2223.55 at day end.
- The evening close row shows stock items 0 and notCounted 0. In fact 2 items were counted and matched (cmwc9n0z600czhljons34kee8, cmwc9n0z600cyhljoizsgnrmh) and 7 were not counted.
- For the same 7 items the morning row says notCounted 7. `ingredients` is empty.

**P5. The daily report does not see the overnight drawer.** Medium confidence.
- `shifts`: open 0 / closed 1. Shift #2 (AWAITING_HANDOVER, holding 2223.55 plus 435.80 card and 245.10 wallet) is counted as neither.
- No end-of-day closing cash, custody holder or pending handover figure appears in the daily report. Only handover-accountability shows "تسليم لم يُستلم بعد".

**P6. Day-end custody stays with the evening cashier personally.** Medium confidence (design).
- The day's last close used SHIFT_TO_SHIFT with CLOSE_RETAIN_ALL. Cash custody cmwc8mfc100u8hl54tawqajw6 and stock custody cmwc8mf9r00u0hl54xmrmodnb remain OPEN in كريم's name overnight; `closingCashAmount` is NULL.
- Nothing was delivered to a safe, the manager or the owner, and no branch custody was used.
- The scenario's "close into branch custody" did not happen. The app did not ask for it at the last shift of the day.

**P7. Evening handover count: same weakness as AM F12, new record.** Low-medium confidence.
- Count cmwc9n0z600cwhljo150q2tx0 was "BLIND", but done by the outgoing cashier alone. Both lines were counted 60 ms apart, both match the system to the gram, and `confirmedById` is NULL.
- The count `startedAt` equals the first `countedAt`. `confidenceWindowFrom` is 12:45:38 instead of the 14:52:02 acceptance.

**P8. Test actions recorded under real staff identities.** Low confidence (simulation artifact, but an audit-trail limit).
- #34 (CARD 28.50, counted in كريم's card reconciliation) and the two #23 refund requests were made by the controls tester as كريم.
- The 3 supplier payments were made as عادل. HandoverIssue cmwc91alh01kvhl54y81snlls was made as سارة; it is still OPEN and flags سارة "مشكلة مفتوحة" in handover-accountability.
- Two PENDING refund requests with the same target fingerprint were accepted for #23 (cmwc94ygq0001hljogqsn26qa, cmwc97x3a000qhljoqwqn9aje).

**P9. Seed payments distort the day's money reports (AM F11, new numbers).** Low confidence (seed artifact).
- Sales-payments today: 6304.20, against daily 4297.80. The +2006.40 is 10 seed card payments for #1–#10, dated 11-05..11-10 by `createdAt` but with `paidAt` today.
- Daily is in turn +381.90 over the shift rows (the #15 duplicate 148.20 and the #11 card 233.70).
- The three money reports give three different "collections" for the same day: 3915.90 raw, 4297.80 daily and 6304.20 sales-payments.

Unchanged from AM, not repeated:
- F1 −300 on سارة (VarianceCase cmwc434dk00ruhl544y6ar9uh still OPEN, reason NULL);
- F3 #15 double cash;
- F4 refund VAT (18.90);
- F5 #12 untracked stock (≈22.10);
- F9 #32 open balance;
- F10 float not booked (now part of the 1110 bridge above).
