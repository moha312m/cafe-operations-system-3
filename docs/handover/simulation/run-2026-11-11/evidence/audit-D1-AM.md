# Audit D1-AM: morning shift #1 (سارة), فرع التجمع

- Auditor: independent, read-only. All DB access was SELECT inside `SET TRANSACTION READ ONLY` against `127.0.0.1:5434/cafe_ops_test`. App reads were GET only, as owner@demo.com, through `sim.mjs` (scene D1-AM-AUDIT).
- Snapshot time: DB `now()` = 2026-11-11T15:01:51Z. **The environment is live.** While I was auditing, a second supplier payment (1 EGP, 14:57:17Z) and the first accounting projection run (14:58:18Z) appeared. Both happened after shift #1 closed and are noted where they affect the figures.
- Scope: café `cmwc33qf00001hlngmptsrf8r`, branch `cmwc33qgt0012hlng6f0q8uz6`, shift `cmwc3fsgs002rhl54telkcr4n` (opened 12:26:54.555Z with 500; financially closed 12:45:02.871Z; stock closed and accepted 14:52:02.114Z), handover `cmwc434fn00s0hl542q1y551r`, next shift #2 `cmwc8me2n00t7hl54aq8ww1fl` (opened 14:52:00.570Z with 1564.95).

People (id suffix → person): `7tkq9c` سارة (cashier, AM) · `owrm77` كريم (cashier, PM) · `da63ro` وليد (waiter) · `3pzi24` مازن (barista) · `dkossi` عادل (storekeeper) · `aus05j` هالة (manager) · `fhgxvh` owner · `qvoxv5` "كريم الكاشير" (demo seed user) · `bau4ln` "وليد الويتر" (demo seed user).

---

## 1. Drawer cash from raw rows

### 1a. Cash rows with `Payment.shiftId = shift #1`

| Order | Payment id | Type | Amount | Note |
|---|---|---|---|---|
| #16 | cmwc3hg9n003phl54mh26qg1k | COLLECTION | 28.50 | |
| #19 | cmwc3j3g3006ihl54ad1moqdq | COLLECTION | 20.00 | cash leg of a split (8.50 on card) |
| #20 | cmwc3jbil006vhl54r14vvhpz | COLLECTION | 28.50 | |
| #21 | cmwc3jbuh0076hl54wuppb075 | COLLECTION | 28.50 | |
| #22 | cmwc3nzdi00bahl543umhzcwx | COLLECTION | 148.20 | |
| #23 | cmwc3nzuq00bmhl547wdkva4v | COLLECTION | 165.30 | |
| #24 | cmwc3o01m00byhl548mduh89m | COLLECTION | 153.90 | refunded later |
| #31 | cmwc3oc0u00euhl54ypdsi1n6 | COLLECTION | 133.70 | cash leg of a split (100 on card) |
| #27 | cmwc3wt5900n8hl54ajztzbq9 | COLLECTION | 125.40 | table session |
| #30 | cmwc3x0gi00nihl54zekkk2mx | COLLECTION | 82.65 | table session, cash half |
| #12 | cmwc3yuzx00qqhl54cuwm8flz | COLLECTION | 256.50 | seeded QR order |
| #14 | cmwc3yvc400qwhl54qcwv0pm9 | COLLECTION | 199.50 | seeded order |
| #15 | cmwc3yvn500r2hl54cuwm8flz | COLLECTION | 148.20 | seeded order (**second** cash row for #15, see F3) |
| **Cash collected** | | | **1518.85** | 13 rows |
| #24 | cmwc3ysly00qehl54l11a5n1u | REFUND | −153.90 | reversalOf cmwc3o01m00byhl548mduh89m |

No `MIXED` method rows exist. Splits are stored as separate legs.

### 1b. Other cash movements during the shift window (12:26:54 to 12:45:02)

| Source | Rows | Amount |
|---|---|---|
| OperatingExpense / OperatingExpenseReturn | none | 0 |
| Advances | none | 0 |
| CashDeliveryDeclaration / CashStorageMovement / MoneyMovement | none | 0 |
| ShiftCashDisposition cmwc434i900sahl54uoowziuf | delivered 0, retained 1564.95 | 0 handed out |
| **PurchasePayment cmwc3vb6400johl544d3llaqb** (INV-D1-001, CASH, by عادل, 12:38:58Z) | `shiftId = NULL`, `fundingSource = NULL` | **300** |

### 1c. Recomputation

| Line | Auditor | App (Shift row) |
|---|---|---|
| Opening float | 500.00 | 500.00 |
| + cash collected | 1518.85 | 1518.85 (report `paymentBreakdown.CASH.sell`) |
| − cash refunds | 153.90 | 153.90 |
| − cash expenses | 0 | 0 |
| − supplier cash payments | **300.00** | **0** (`totalCashPayouts = 0`) |
| − advances | 0 | 0 |
| − cash handed over | 0 | 0 |
| **Expected drawer** | **1564.95** | **1864.95** (`expectedCashAmount`) |
| Counted | 1564.95 | 1564.95 (`actualCashAmount`) |
| Difference | **0.00** | **−300.00** (`cashDifference`) |

The app counted all 13 shift cash collections and the refund. It left out the 300 cash supplier payment, because that row has no shift and no funding source. It also correctly left out the seed cash row for #15 (cmwc33rf600arhlng2szn7qpf, 148.20, no shift), which never entered this drawer. The −300 variance is fully explained by the supplier payment. The cashier's own explanation (Shift.notes: "300 اتدفعوا كاش لمورد الألبان من الدرج (فاتورة INV-D1-001) بإيد أمين المخزن") matches the raw PurchasePayment row in amount, invoice and actor.

## 2. Card and wallet

| Tender | Raw rows (shift #1) | Raw total | Shift row | Reconciliation (counted) | Diff |
|---|---|---|---|---|---|
| CARD | #18 28.5, #19 8.5, #25 273.6, #31 100, #28 148.2, #33 28.5, #30 82.65 (7 rows) | **669.95** | 669.95 | 669.95 (cmwc434ea00rwhl54vdao2ign) | 0 |
| WALLET | #17 28.5, #26 119.7, #29 239.4 (3 rows) | **387.60** | 387.60 | 387.60 (cmwc434eg00ryhl54frqnsoeg) | 0 |

Both TenderReconciliation rows are `SUBMITTED`, with no approver. `externalReconciliation = NOT_EVIDENCED`: there is no settlement or terminal evidence.

Totals check: gross collections 1518.85 + 669.95 + 387.60 = 2576.40. Minus the refund 153.90, that is 2422.50 = `Shift.totalSales`. orderCount 20 = orders #12, #14, #15, #16–#31 (except #32) and #33.

## 3. Stock

Recipes used are the variant-level ones the owner created and verified at 12:31–12:32Z, plus the verified seed recipe for شاي. The seed product-level recipes for إسبريسو, لاتيه, آيس لاتيه and سبانش لاتيه are **unverified** (`verifiedAt = NULL`). أمريكانو, مافن, براوني and شاي نعناع have no recipe at all.

Expected consumption per SERVED order (auditor) against InventoryTransaction USAGE rows. Every row matched, except:
- #12 (سبانش لاتيه وسط ×1, براوني ×2): **0 rows**, although `stockDeductedAt` = 12:41:15. A recipe exists but is unverified. Audit: `PRODUCT_WITHOUT_RECIPE_SERVED` / `PRODUCT_WITH_INCOMPLETE_RECIPE_SERVED`.
- #15 (أمريكانو كبير, مافن): 0 rows. Neither product has a recipe, which is consistent. Audit flags were raised.
- #14: cappuccino deducted correctly. شاي نعناع has no recipe (flagged).

No order was deducted twice: no (orderId, item) pair has more than one row. No served order has an inventory row from another order.

| Item | Opening (baseline/creation) | Received | Consumed (ledger) | Expected (ledger) | currentStock | Handover count | Auditor "true" expected incl. #12 recipe |
|---|---|---|---|---|---|---|---|
| بن KG | 12 | 0 | 0.216 | 11.784 | 11.784 | 11.784 | 11.766 (−0.018) |
| لبن L | 30 | 10 | 1.990 | 38.010 | 38.010 | 38.010 | 37.810 (−0.200) |
| كاسات PC | 500 | 200 | 31 | 669 | 669 | not counted | 668 (−1) |
| أغطية PC | 500 | 0 | 14 | 486 | 486 | not counted | 485 (−1) |
| شاي أخضر BOX | 1 | 2 | 0.26 | 2.74 | 2.74 | not counted | 2.74 |
| كرواسون (قطعة) PC | 30 (created 12:31:38 by owner) | 0 | 6 | 24 | 24 | not counted | 24 |
| برتقال KG | 10 (created 12:31:38 by owner) | 0 | 1.6 | 8.4 | 8.4 | not counted | 8.4 |
| صوص فانيليا L | 5 | 0 | 0 | 5 | 5 | not counted | 4.98 (−0.02) |

Consumption build-up (auditor):
- بن: 0.018 each for #22, #24, #26, #28, #29, #31; 0.036 each for #23, #25, #14. Total 0.216.
- لبن: #22 0.18, #24 0.22, #25 0.48, #26 0.27, #28 0.18, #31 0.30, #14 0.36. Total 1.99.
- كاسات: 1 each for the 6 tea orders, plus #22 1, #23 3, #24 2, #25 2, #26 2, #27 2, #28 2, #29 2, #30 2, #31 4, #33 1, #14 2. Total 31.
- أغطية: #22 1, #24 2, #25 2, #26 2, #28 2, #30 1, #31 2, #14 2. Total 14.
- شاي أخضر: 0.02 × 13 cups = 0.26.
- كرواسون: #22 1, #25 1, #27 1, #29 2, #30 1. Total 6.
- برتقال: 0.4 × 4 (#24, #28, #30, #31). Total 1.6.

Receipts: INV-D1-001 (cmwc3ugj700hohl54xa7o4jfu), CONFIRMED 12:38:40Z by عادل. Items: لبن 10 × 38 = 380, شاي أخضر 2 × 85 = 170, كاسات 200 × 2.5 = 500, total 1050. Matching PURCHASE txns 0z0l02yw, bv5g1odm and gnxrwsuq were all booked into سارة's stock custody `…1bqzks` and shift.

Refund and void:
- **#24 refund (153.90, cash)**: no stock was returned. The 5 USAGE rows stay (بن 0.018, لبن 0.22, كاسات 2, أغطية 2, برتقال 0.4, valued at 36.36). The drink was served and consumed ("customer complained about the taste"), so not restocking is physically right. However, no waste or loss row was created, so the consumed stock sits in COGS against a sale that was fully returned.
- **#32 cancel (68.40)**: cancelled before serving. No deduction happened and none was needed. The order still shows `paymentStatus = PENDING_COLLECTION` with `remainingAmount = 68.40` (see F9).

Handover count: session cmwc437pl00skhl54xticf06c, BLIND, CRITICAL_ONLY. Counter سارة, `confirmedById = NULL`. Lines بن 11.784 = 11.784 and لبن 38.01 = 38.01. COUNT_REBASE rows have 0 delta. Note that a blind count landing on the system figure to the gram means it did **not** see #12's untracked usage (0.018 kg بن, 0.2 L لبن). Either the drink was never physically made, or the count was not truly independent.

Perpetual valuation (Σ currentStock × cost) = 11233.58, which equals GL 1200 = 11233.58.

## 4. Journal / P&L / TB (app, today, branch)

Projection run cmwc8uhio00wfhl54lfgv4ad2 (14:58:18Z, `actorId = NULL`): 187 entries posted, 35 issues.

P&L `/api/accounting/pnl?from=2026-11-11&to=2026-11-11`:

| Line | App | Auditor comment |
|---|---|---|
| 4100 Sales | 2465.00 | = shift orders ex-VAT 2260 + seed order #11 205 (dated today, servedAt NULL, ASSUMED_DATE) |
| 4400 Sales returns | −153.90 | #24 booked **gross incl. VAT**. Ex-VAT should be 135.00; output VAT 18.90 was not reversed |
| Net revenue | 2311.10 | should be 2330.00 if the refund were split |
| 5100 COGS | 461.42 | = Σ USAGE totalCost (بن 97.2 + لبن 75.62 + كاسات 77.5 + أغطية 21 + شاي 22.1 + كرواسون 120 + برتقال 48). Excludes #12 (≈22.10 untracked) and the no-recipe items |
| 5300 Cash over/short | 300.00 | **not a real shortage**; it is the supplier payment |
| Net profit | 1549.68 | |
| KPI "discounts" | 153.90 | label wrong: no discount was given; this is the return |

Trial balance today: debits 21457.92 = credits 21457.92, **balanced**. Since 1 Nov: 25470.72 = 25470.72, balanced. Closing balances for the branch: 1110 drawer 1213.15 · 1140 card clearing 2910.05 · 1150 wallet 387.60 · 1160 receivables **−148.20** (credit balance on an asset) · 1200 inventory 11233.58 · 2100 suppliers −1050 · 2200 VAT −591.50 · 2300 customer advances 0 · 3200 opening balances −10645 · 4100 −4225 · 4400 153.90 · 5100 461.42 · 5300 300.

Posted correctly: every sale (SALE entries 95–186), every collection, the refund (181), the purchase invoice (91, Dr 2110 / Cr 2100 1050), stock receipts and openings (Dr 1200 / Cr 2110 1050 and Cr 3200 10645), COGS (Dr 5100 / Cr 1200 461.42), cash variance (187, Dr 5300 / Cr 1110 300).

**Not posted (BLOCKING projection issues):**
- `supplier-payment:cmwc3vb6400johl544d3llaqb` (300, 12:38:58Z): "دفعة قديمة مصدرها مش متسجل (درج ولا خزنة ولا بنك)"
- `supplier-payment:cmwc8t6qs00ukhl54t7389sx9` (1, 14:57:17Z, after scope): same reason

The 33 ASSUMED_DATE warnings are seed orders across 3 branches with no servedAt. For this branch, that is #2 … #11.

Missing from the GL entirely: the 500 opening float (no entry in 1110 or 1120, and no OpeningCashReceipt).

GL drawer bridge: physical 1564.95 − float 500 (never booked) + 148.20 (seed duplicate cash for #15, entry 67) = 1213.15 = GL 1110.

## 5. Accountability: rows with no actor or no custody link

| Table / row | Missing | Effect |
|---|---|---|
| PurchasePayment cmwc3vb6400johl544d3llaqb (300) | `shiftId`, `fundingSource` (actor عادل is present) | the drawer it left is not recorded, so the shortage lands on سارة |
| PurchasePayment cmwc8t6qs00ukhl54t7389sx9 (1, after scope) | same | same pattern in shift #2 |
| JournalEntry (all 187) | `createdById` | GL has no poster |
| AccountingProjectionRun cmwc8uhio00wfhl54lfgv4ad2 | `actorId` | who ran the books is unknown |
| VarianceCase cmwc434dk00ruhl544y6ar9uh | `assignedResponsibilityUserId`, reason; attribution NOT_APPLICABLE | open −300 has no owner and no reason |
| Shift #1 | `cashReasonCodeId`, `cashReasonNote` (reason exists only in free-text `notes`) | handover/variance/report screens show reason = null |
| Shift #1 `closedById` = كريم | financial close actually performed by سارة (AuditLog SHIFT_CLOSED by 7tkq9c, 12:45:03) | shift report shows "closedByName كريم" next to closedAt 12:45 |
| StockCountSession cmwc437pl00skhl54xticf06c | `confirmedById` (confirmedAt is set) | |
| HandoverSession | `countedOpeningCash`, `cashVerifiedById` | incoming accepted 1564.95 without an independent count (by design for direct handover) |
| 12 seed Payment rows (#1–#11 card, #15 cash) | `shiftId`, `cashierId` (receivedBy demo user qvoxv5) | #15 duplicate cannot be tied to any drawer |
| Order #12 | `createdById` | QR order; approver وليد is present, which is acceptable |
| Opening float 500 | no OpeningCashReceipt, no source custody | handover-accountability flags OPENING_WITHOUT_RECEIPT |

All Order `servedById` values match the ORDER_SERVED audit actor. All InventoryTransaction rows have `createdById`. No AuditLog row in scope has a null userId.

## 6. Handover agreement

| Figure | Handover screen | Counted / close | Journal | Agree? |
|---|---|---|---|---|
| Expected drawer | 1864.95 | (auditor 1564.95) | n/a | **no**: the screen shows the wrong expected value |
| Drawer counted | 1564.95 | 1564.95 | 1110 = 1213.15 (no float, +148.2 dup) | screen = count; GL different |
| Cash variance | −300, reason null | −300 | 5300 = 300 | consistent with each other, wrong in substance |
| Card | 669.95 / 669.95 | 669.95 | 1140 +669.95 shift (+233.7 seed #11) | yes |
| Wallet | 387.6 / 387.6 | 387.6 | 1150 387.6 | yes |
| بن / لبن | 11.784 / 38.01 matched | same | 1200 valuation matches | yes (subject to #12) |
| Passed to shift #2 | proposedTransfer 1564.95, receivedCash null | shift #2 opening 1564.95; CustodyPeriod close 1564.95 → next open 1564.95 | | yes |
| Handover-accountability report | stock items 0, "خامات لم تُعدّ 7 صنف", matched 0 | 2 items counted and matched | | **no** |
| Shift report product mix | 1110.00 subtotal, 22 units | shift sales subtotal 2260 | | **no** |

---

## Candidate findings

**F1. Cash supplier payment is not linked to the drawer, which creates a false −300 shortage on the cashier.** High confidence.
PurchasePayment cmwc3vb6400johl544d3llaqb: 300 CASH by عادل at 12:38:58Z, `shiftId = NULL`, `fundingSource = NULL`. Because of that:
- Shift.expectedCashAmount is 1864.95; the true figure is 1564.95.
- `totalCashPayouts` is 0.
- VarianceCase cmwc434dk00ruhl544y6ar9uh (−300) is OPEN.
- employee-variances and handover-accountability both charge a 300 shortage to سارة, while the actor was عادل.
The app let a CASH supplier payment be recorded without a source, during an open shift.

**F2. The books mis-state the supplier payment.** High confidence.
- The payment cannot be posted (BLOCKING issue `supplier-payment:cmwc3vb6400johl544d3llaqb`).
- 2100 Suppliers shows 1050 owed; the real balance is 750.
- The P&L shows a 300 cash-shortage expense (JE 187, 5300); there was no loss.
- If the payment is later given fundingSource = drawer and posted, 1110 would be credited 300 a second time unless JE 187 is reversed. That is a double-count risk.

**F3. Order #15 has two cash collections for one 148.20 sale.** High confidence.
- Seed Payment cmwc33rf600arhlng2szn7qpf (12:17:33Z, no shift, receivedBy demo user) and shift Payment cmwc3yvn500r2hl54cuwm8flz (12:41:45Z, سارة) are both COLLECTION/PAID.
- Order.paidAmount shows only 148.20.
- GL: JE 67 and JE 185 both Dr 1110. SALE JE 186 applies 296.40 of advances, so 1160 receivables end at −148.20.
- Daily report cashCollections 1667.05 includes 148.20 that never entered any drawer.
- Root is the seed data (the seed paid #15 but left the order UNPAID). The app then allowed a second collection without detecting the existing payment.

**F4. The refund reverses gross revenue including VAT.** Medium-high confidence.
- JE 181: Dr 4400 153.90 / Cr 1110 153.90.
- The output VAT on #24 (18.90, JE 123) is never reversed. VAT payable is overstated by 18.90; net revenue is understated by 18.90 (2311.10 vs 2330.00).

**F5. Order #12 was served with no stock deduction although it has a recipe.** Medium confidence.
- #12 (سبانش لاتيه وسط, براوني ×2): `stockDeductedAt` = 12:41:15, zero InventoryTransaction rows.
- The سبانش لاتيه recipe seed_cmwc33r5u002jhlng3zr2z7bq exists but is unverified, so it was treated as missing.
- Untracked: بن 0.018, لبن 0.200, صوص فانيليا 0.020, كاسات 1, أغطية 1 (≈22.10 EGP COGS).
- Under STRICT, the till blocked these items 41 times at 12:27Z, yet seeded orders #12, #14 and #15 were served with no-recipe or unverified items (only audit warnings). The blind handover count matched the system exactly, so it did not surface this.

**F6. The shift report product mix does not reconcile to shift sales.** Medium-high confidence.
- `/api/shifts/<id>/report` `productsSold` totals 1110.00 (22 units). That covers only POS orders with saleShiftId = shift #1 (#16–#26, #31, including refunded #24).
- Shift sales are 2576.40 gross / 2260 ex-VAT. The report omits table/waiter orders #27–#30 and #33, and the collected seeded orders #12, #14 and #15. Example: شاي shows 9 cups; 13 were sold in the shift.

**F7. The handover-accountability report contradicts the handover.** Medium confidence.
- `/api/reports/handover-accountability` shows `stock.items = 0`, `notCounted = 7`, `matched = 0`, and exception "خامات لم تُعدّ عند التسليم — الفرق غير معروف".
- The handover counted بن and لبن (the 2 required critical items) with zero variance (SYSTEM_MATCH).

**F8. The cash-variance reason is not captured in the structured fields.** High confidence (data), medium (impact).
- The cashier wrote the explanation in Shift.notes only. `cashReasonCodeId` and `cashReasonNote` are NULL.
- The handover screen (`closingReason`, `financialSummary.cashReason`), employee-variances (`reason`) and the VarianceCase all show no reason.
- The close accepted a −300 difference with no reason code.

**F9. Cancelled order #32 still carries an open balance.** Low-medium confidence.
- `status = CANCELLED`, `paymentStatus = PENDING_COLLECTION`, `remainingAmount = 68.40`. Daily report pendingCount is 0, so the current reports exclude it, but the row is inconsistent.
- The CANCEL request reason stored is "retry after owner saved approval settings", which is a technical note. The business reason ("العميل لم يستلم") is only in the owner's decisionNote.

**F10. The opening float is unsourced and absent from the books.** Medium confidence.
- The 500 opening float has no OpeningCashReceipt and no previous cash custody (CustodyPeriod cmwc3fsjn002thl54p77oly41 `previousPeriodId = NULL`).
- No GL entry exists for it. The report flags OPENING_WITHOUT_RECEIPT.
- As a result GL 1110 (1213.15) can never equal the physical drawer.

**F11. Seed history pollutes "today".** Low confidence (seed artifact, not app logic).
- Seed order #11 (created 10:17Z today, servedAt NULL, UNPAID, but with a CARD payment 233.70) adds 205 revenue and 233.70 card to today's P&L and daily report.
- Seed orders #1–#11 are all "UNPAID / paid 0" yet have PAID card payments.
- Daily report `collection.paidTotal` 2422.50 vs `financials.collections` 2958.30 differ for this reason plus F3.

**F12. Accountability gaps.** Medium confidence.
- All 187 JournalEntry rows and the projection run have no actor.
- StockCountSession has `confirmedById` NULL.
- Shift #1 `closedById` = كريم, while the financial close (12:45:03) was by سارة. The shift report pairs كريم's name with سارة's close time.
- The refund executed in shift #1 kept the consumed stock in COGS (36.36) with no waste/loss row. This is defensible, but there is no trace that links the returned sale to the consumed materials.

**F13. Owner and storekeeper stock entered the cashier's custody without acknowledgment.** Low confidence (design question).
- The owner created كرواسون 30 and برتقال 10 as "رصيد افتتاحي" at 12:31:38Z inside سارة's open stock custody …1bqzks / shift.
- عادل's delivery (+10 لبن, +2 شاي, +200 كاسات) was also posted into her custody.
- Neither has an acknowledgment by the custodian, but both raise what she is answerable for.

Post-scope note: PurchasePayment cmwc8t6qs00ukhl54t7389sx9 (1 EGP CASH by عادل, 14:57:17Z, in shift #2's window) repeats the F1 pattern. If it came from كريم's drawer, shift #2 will close 1 short.
