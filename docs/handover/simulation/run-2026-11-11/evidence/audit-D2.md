# Audit D2: Day 2 (shifts #3, #4, #5 and the night close), فرع التجمع

- Auditor: independent and read-only. All DB access was SELECT inside `SET TRANSACTION READ ONLY` against `127.0.0.1:5434/cafe_ops_test`, through `@prisma/client` from `C:/Dev/cafe-ops-handover-integration`. App reads were GET only, as owner@demo.com, through `tools/api.mjs` (scene D2-AUDIT). The P&L was read with `autoSync=false`; nothing was projected.
- Snapshot: DB `now()` was 16:10–16:20Z. The state was stable: the last AuditLog row was at 16:09:24.608Z (owner `HANDOVER_ACCEPTED` on the night handover). There were still 187 journal entries and 2 projection runs.
- Scope:
  - Shift #3 `cmwcagah600ethljoosq95fmm` (سارة): opened 15:43:15 with 2173.55; financially closed 15:47:40.963.
  - Shift #4 `cmwcasvek00pphljogyptmg2y` (كريم): opened 15:53:02 with 2622.55; financially closed 16:06:12.849 by هالة.
  - Shift #5 `cmwcb2vtt00x3hljodnt828vb` (هالة): opened 16:00:49 with 0; closed by the workaround at 16:05:36.400.
  - Handovers `cmwc9mzdx00cehljodn25jwq6` (D1 night to AM), `cmwcalzoj00o3hljojnbyr2wv` (AM to PM), `cmwcb3zgz00xjhljotnbv5i9v` (stray, shift #5) and `cmwcb9tra00yshljoragymaka` (night, BRANCH_CUSTODY).
- Day 2 shares the calendar date 2026-11-11 with Day 1, so every "today" report and P&L mixes both days. Day 2 figures below were isolated from rows created after 15:21Z.

People (id suffix): `7tkq9c` سارة · `owrm77` كريم · `da63ro` وليد · `aus05j` هالة · `dkossi` عادل · `fhgxvh` owner.

---

## 1. Cash chain

### 1a. Raw rows per drawer period

| Shift | Cash in (rows) | Cash out | Card | Wallet |
|---|---|---|---|---|
| #3 | 449.00 (6): #51 28.5, #52 136.8, #53 79.8, #56 50 (split), #57 57, #48 96.9 (T1) | none | 423.10 (4): #54 114, #55 153.9, #56 46.9, #49 108.3 (T2) | 57.00 (1): #58 |
| #4 | 607.30 (5): #59 125.4, #60 51.3, #61 136.8, #64 100 (split), **#50 193.8 (T3, morning order)** | **REFUND 136.80** cmwcb1mv700wvhljooad3dd6j (#52, morning order) | 230.60 (2): #62 159.6, #64 71 | 114.00 (1): #63 |
| #5 | none | none | 0 | 0 |

Other cash sources in the Day 2 window:
- OperatingExpense, OperatingExpenseReturn, PurchasePayment, CashStorage, CashStorageMovement, CashDeliveryDeclaration, MoneyMovement and OpeningCashReceipt: **0 rows**.
- The 40 ice is not recorded anywhere. Both POST /api/expenses attempts (16:00:44 and 16:00:53) returned 400.

### 1b. Chain

| Link | Raw expected | Counted | Recorded by the app | Where the difference is recorded |
|---|---|---|---|---|
| D1 close (shift #2) | 2223.55 (2220.55 if the 3 sourceless EGP left the drawer, D1-PM P2) | 2223.55 | Shift #2 expected = counted 2223.55, diff 0. Disposition cmwc9mzfw00cohljonebr52yp retained 2223.55. Cash custody cmwc8mfc100u8hl54tawqajw6 (كريم) closing 2223.55 | n/a |
| → AM opening (shift #3) | 2223.55 | **2173.55** (−50) | Shift #3 `openingCashAmount` 2173.55. Handover `countedOpeningCash` 2173.55, `cashVarianceAmount` −50, `cashVerifiedById` سارة. Custody cmwcagmsl00g8hljo8s7vubhj opening 2173.55 | OpeningException cmwcagmkk00f7hljowxtm549q (CASH_MISMATCH, reason SIM_HO_SHORT, note "عجز 50 عند الاستلام", authorized by سارة) on **shift #2 / كريم's cash custody**. VarianceCase cmwcagmlt00f9hljoxdljkafi: OPENING_EXCEPTION, −50, OPEN, `assignedResponsibilityUserId` NULL, NOT_APPLICABLE. HandoverIssue cmwcafl5t00ephljoockzp8tm (CASH 50) is separately OPEN and not linked to the case. Shift #2 `cashDifference` stays 0. **Not in the books** (see §4) |
| → AM close (shift #3) | 2173.55 + 449.00 = **2622.55** | 2622.55 | expected 2622.55, diff 0. Disposition cmwcaq8ri00p9hljoclb6087m retained 2622.55. Custody closing 2622.55 | none. Table 3 (#50, 193.8) was still unpaid and is not in this drawer |
| → PM opening (shift #4) | 2622.55 | 2622.55 (recounted by كريم, `cashVerifiedById` كريم) | `countedOpeningCash` 2622.55, variance 0. Custody cmwcavboo00r7hljox8civnxc opening 2622.55 | none |
| → PM close (shift #4) | 2622.55 + 607.30 − 136.80 = **3093.05** (app). Including the unrecorded ice: 3093.05 − 40 = **3053.05** | **3083.05** (= 3053.05 + 30 unexplained surplus) | expected 3093.05, actual 3083.05, `cashDifference` −10, `cashReasonNote` "زيادة 30 غير معروفة + 40 ثلج…", `cashReasonCodeId` NULL | VarianceCase cmwcb9tov00ymhljoldtlv0ow: CASH −10, OPEN, `custodyPeriodId` NULL, assigned NULL. It nets a 40 expense and a +30 surplus into one 10 shortage |
| → overnight | 3083.05 cash + 230.60 card + 114.00 wallet | n/a | **No disposition** (`cashDisposition` null). Cash custody cmwcavboo00r7hljox8civnxc was CLOSED at 16:06:13.179 (the financial close) with closing 3083.05, `acceptedById` NULL and no successor period. The night handover has `incomingCashCustodyId` NULL; only a STOCK BRANCH custody cmwcbdxby010lhljoo94phcvg was opened | **Nobody holds the 3083.05.** There is no branch cash custody, no safe and no delivery |

Tenders: CARD and WALLET TenderReconciliation rows for shifts #3, #4 and #5 (cmwcalzne00nzhljosal1zbx0, cmwcalznk00o1hljoutau545e, cmwcb9tp900yohljouaa98npf, cmwcb9tpf00yqhljowe2l9u7x, cmwcb3zfh00xfhljoripu4lop, cmwcb3zfp00xhhljoae78fycl) all show expected = actual and are SUBMITTED with no approver. The shift #4 and shift #5 rows were submitted by هالة.

### 1c. Who carries the −50

| Source | Names |
|---|---|
| VarianceCase cmwcagmlt00f9hljoxdljkafi | shift #2 and كريم's cash custody; **no person assigned** |
| employee-variances | **كريم** (category HANDOVER_CASH, shortage 50, custodian/outgoing كريم, incoming سارة) |
| handover-accountability | **"shared"**: `sharedCashShortage` 50; both سارة and كريم show `shared.cashAmount −50`. It is excluded from `cashShortage` 310. The open-issue exception lists both people |
| daily report | not included (`shifts.cashDifferenceTotal` −310 = −300 − 10) |
| Books | not posted |

On custody facts, كريم held the drawer alone overnight: CLOSE_RETAIN_ALL, and custody stayed OPEN in his name until 15:43:31. Naming كريم is right. The two reports disagree, though, and the case itself names nobody.

### 1d. Refund of the morning order and table 3

- **Refund #52 (136.80)**:
  - Requested by كريم 15:58:12 (cmwcazil000wlhljoinkqzkbl), approved by the owner 15:59:39 ("موافق — مرتجع من طلب الصباح"), executed by كريم 15:59:51.
  - REFUND row cmwcb1mv700wvhljooad3dd6j: shift #4, cashier كريم, `reversalOfPaymentId` = the shift #3 collection cmwcah6k600gzhljoch5fzecn, note "مرتجع من شيفت مقفول رقم 3".
  - It lands in **shift #4 totals** (`totalRefunds` 136.80; deducted from كريم's expected 3093.05) and in the **evening drawer**. Physically that is right.
  - Shift #3 still shows the 136.80 sale and collection, which is correct as of its close.
  - Shift-sales "net": shift #4 621.30 = its own 758.10 − 136.80 (the morning refund); shift #3 723.90 is not reduced.
  - Daily `salesByStaff` puts the refund on سارة (refunds 290.70 = 153.90 + 136.80). `refundsByActor` puts it on كريم (136.80).
  - Stock: كرواسون ×2 (40.00 COGS, shift #3, سارة's custody) was not returned, and there is no waste row.
- **Table 3 (#50, 193.80)**:
  - Created and served by وليد with `saleShiftId` NULL, `servedShiftId` = shift #3. The USAGE (47.50) is in سارة's custody and shift #3.
  - The cash came in through Payment cmwcayzuw00wfhljoy7nr8yj7 in **shift #4** (كريم), inside his expected. Shift #4 `orderCount` 7 includes #50.
  - The AM handover recorded no carried or open order (`carried.count 0, unpaidTotal 0`). The open table is invisible in the handover.

## 2. Stock

### 2a. Day 2 consumption

All 17 orders (#48–#64) were STRICT. USAGE rows match the verified recipes exactly: 0 mismatches over 60 rows. No (order, item) pair is duplicated. There were no deferred deductions.

| | Rows | Cost |
|---|---|---|
| Shift #3 / custody …3cbcpe (سارة; #48–#50 deducted by وليد) | 37 | 260.68 |
| Shift #4 / custody …ie7sgh (كريم) | 23 | 174.71 |
| **Day 2 COGS** | 60 | **435.39** |

### 2b. بن and لبن through the day

| Step | بن (KG, 450) | لبن (L, 38) | Record |
|---|---|---|---|
| D1 close count = system | 11.658 | 36.84 | count cmwc9n0z600cwhljo150q2tx0 |
| AM acceptance (سارة acked 11.658 / 36.84) | rebase 0 (before 11.658, after 11.658) | rebase 0 (36.84 → 36.84) | StockCountRebase cmwcagmp400flhljow0vuk5n8, cmwcagmog00ffhljoowiszqpt (by سارة, booked to كريم's …rmodnb / shift #2) |
| AM usage | −0.090 (#49 .018, #50 .018, #53 .009, #54 .018, #55 .018, #57 .009) | −1.06 (#49 .18, #50 .30, #54 .24, #55 .22, #57 .12) | |
| System at AM count | 11.568 | 35.78 | |
| سارة counts (count cmwcaoznk00oyhljo8dbwwu23, BLIND, by سارة) | 11.4 → **−0.168** | 34.8 → **−0.98** | lines cmwcaoznl00p0hljosemkr97p / cmwcaoznl00p1hljomzt65x75, VARIANCE_RECORDED, cost 75.60 / 37.24, no reason code |
| كريم receives (ack) | 11.4 (0) | **34.5 (−0.3)**, decision ACCEPTED, no dispute reason | HandoverStockAcknowledgement cmwcaufwf00pthljo3b8rhtbs / cmwcaufxj00pxhljoxas9nnc5 |
| Rebase at PM acceptance (by كريم, booked to **سارة's custody …3cbcpe / shift #3**) | 11.568 → 11.4 (txn cmwcavbgs00q5hljozgtp1no6) | 35.78 → 34.8 (cmwcavbhp00qbhljor599y805), then 34.8 → 34.5 (cmwcavbib00qhhljovcvh7t50, note HANDOVER_RECEIVING_COUNT) | all 3 COUNT_REBASE rows have `unitCost`/`totalCost` **NULL** |
| INV-D2-001 confirm 15:55:42 (by عادل, custody …ie7sgh كريم / shift #4) | +1 at 450 (cmwcawbac00rjhljofhdvleou) | | refused 409 during the freeze at 15:48:34, confirmed after |
| PM usage | −0.081 (#60 .009, #62 .036, #63 .018, #64 .018) | −0.82 (#62 .36, #63 .22, #64 .24) | |
| Night count (هالة) = system | 12.319 | 33.68 | count cmwcba1ia00z8hljo3otcl22j; owner rebase 0 (cmwcbdwxj00zzhljo4nm7qb4x, cmwcbdwyf0105hljo3gvk4nwo) |
| currentStock = Σ ledger | **12.319** | **33.68** | |

How each variance was recorded:

| Variance | Stock movement | Variance case | Cost carried | Journal |
|---|---|---|---|---|
| بن −0.168 (سارة) | COUNT_REBASE, cost NULL | cmwcavbm800qvhljov8qut6ed: STOCK OPEN, VERIFIED_SHIFT shift #3, assigned NULL, qty −0.168, **amount +75.60** | 75.60 on the line/case only | none; on projection it becomes the exception "حركة مخزون من غير تكلفة" (`purchase-posting.ts:97`) |
| لبن −0.98 (سارة) | COUNT_REBASE, cost NULL | cmwcavbna00qxhljooctkxdng: same, **amount +37.24** | 37.24 on the line/case only | same |
| لبن −0.3 (كريم receiving) | COUNT_REBASE, cost NULL, booked to سارة's custody | **none** | **none** (11.40 at 38) | same |

- **Attribution of −0.3.** No case or report names anyone. employee-variances and handover-accountability (`ingredients`) list only the two سارة lines. Only the shift #3 materials report shows `receiving.difference −0.3`. The ledger books the movement to سارة's custody period, while it was كريم's receiving count that disagreed with her.
- **سكر (cmwcams7v00ohhljox1681m0y).**
  - Created by عادل 15:48:18 with `costPerUnit` 0. PURCHASE +5 at unit cost 0 (cmwcawbb000rlhljotigpet2h, totalCost 0).
  - Value in stock: 0. The invoice INV-D2-001 is 450 (all بن). The projection posts nothing for a 0-cost row (`pair()` returns no lines).
  - Any future use will cost 0 COGS. It is not a critical item and was never counted.
- **Negative stock: none.** All 10 items have currentStock = Σ ledger.
- **Perpetual value.** Σ currentStock × cost = **10829.89**. That is 10939.52 (D1 end) − 435.39 usage + 450 purchase − 124.24 rebase losses (75.60 + 37.24 + 11.40).

## 3. Open cases and items

| Record | Type | Amount | Names (case / employee-variances / handover-accountability) | Correct? |
|---|---|---|---|---|
| VarianceCase cmwc434dk00ruhl544y6ar9uh | CASH (D1 shift #1) | −300 | — / سارة / سارة | no: it is the supplier payment (D1-AM F1), unchanged |
| VarianceCase cmwcagmlt00f9hljoxdljkafi | OPENING_EXCEPTION (shift #2) | −50 | nobody / كريم / shared سارة+كريم | the person (كريم) is right in employee-variances; HA splits it; the case has no person and is not in the books |
| VarianceCase cmwcavbm800qvhljov8qut6ed | STOCK بن | −0.168 kg, +75.60 | — / سارة / سارة | person yes; amount sign positive for a shortage; no reason; no GL cost |
| VarianceCase cmwcavbna00qxhljooctkxdng | STOCK لبن | −0.98 L, +37.24 | — / سارة / سارة | same |
| (missing) | STOCK لبن receiving | −0.3 L, 11.40 | nobody / absent / absent | no case at all |
| VarianceCase cmwcb9tov00ymhljoldtlv0ow | CASH (shift #4) | −10 | — / كريم / كريم | no: the reality is a 40 expense (manager's ice, refused by the app) plus a +30 surplus. هالة was SHARED custodian (participant cmwcb2vxq00x5hljoat7lorz5, from 16:00:49), did the count and close, and is not named. `custodyPeriodId` NULL |
| HandoverIssue cmwcafl5t00ephljoockzp8tm | CASH 50 | 50 | reported by سارة | duplicate of the −50 case, not linked; OPEN |
| HandoverIssue cmwc91alh01kvhl54y81snlls | OTHER (D1 controls test) | 0 | flags سارة | test residue, OPEN |

employee-variances totals: سارة CASH 300, STOCK 112.84 (2); كريم CASH 10, HANDOVER_CASH 50.

handover-accountability KPIs: handovers 5, closes 5, matched 3, cashShortage 310, sharedCashShortage 50, ingredientShortage 112.84, openIssues 2, openingsWithoutReceipt 2, stockNotCounted 4.

## 4. Books

- **Day 2 is not in the books, and neither is Day 1 PM.**
  - JournalEntry count is 187; the last posting was at 14:58:21; the last projection run was cmwc8wt7q01kohl54dforxuav at 15:00:06.
  - P&L (`autoSync=false`, today): sales 2465 · returns −153.90 · COGS 461.42 · cash variances 300 · net 1549.68. This is identical to the D1-AM audit.
  - Trial balance today: 21457.92 = 21457.92, "balanced", identical to D1-AM.
- **Raw Day 2:**
  - 17 orders. Ex-VAT 1650.00 (shift #3 orders 985, shift #4 orders 665), VAT 231.00, gross 1881.00.
  - Collections: cash 1056.30, card 653.70, wallet 171.00. Refund 136.80 (120.00 + 16.80 VAT).
  - COGS 435.39. Stock losses 124.24. Purchase 450 (unpaid).
  - Cash: −50 (opening), −40 ice, +30 surplus.
- **Projected entries if someone opens the P&L normally** (from code reading; not run):

| Item | Posts? | Entry |
|---|---|---|
| Sales | yes | 4100 Cr 1650, 2200 Cr 231 |
| Collections | yes | 1110 Dr 1056.30, 1140 Dr 653.70, 1150 Dr 171 |
| Refund #52 | yes, gross | Dr 4400 136.80 / Cr 1110 (`shadow-projection.ts:117`). VAT 16.80 not reversed (D1-AM F4 again) |
| COGS | yes | 5100 Dr 435.39 / 1200 Cr |
| INV-D2-001 | yes | 1200 Dr 450 / 2110 Cr; confirm 2110 Dr / 2100 Cr 450. سكر 0, no line |
| Shift #4 variance | yes | 5300 Dr 10 / 1110 Cr 10 |
| −50 opening shortage | **no source** | CASH_VARIANCE posts only `Shift.cashDifference` (`shadow-projection.ts:138`), and shifts #2 and #3 are both 0 |
| Stock rebases 124.24 | **no** | 3 exceptions "حركة مخزون من غير تكلفة" |
| Ice 40 | **no** | no expense row; it is inside the −10 |
| +30 surplus | netted | inside the −10 |

- **Day 2 net result.**
  - Books (projected): 1650 − 136.80 − 435.39 − 10 = **1067.81**.
  - Raw economics: (1650 − 120) − 435.39 − 124.24 − 40 + 30 − 50 = **910.37**.
  - Gap 157.44 = 124.24 stock loss + 50 cash shortage − 16.80 refund VAT.
- **Balance-sheet gaps after a full sync** (projected):
  - 1110 drawer: 1213.15 + 658.60 (D1 PM) + 909.50 (D2) = 2781.25, against a physical 3083.05. The gap −301.80 = −500 float (never booked) + 148.20 seed duplicate (#15) + 50 unposted opening shortage.
  - 1200 inventory: 10954.13 against a perpetual 10829.89 (+124.24, the rebases).
  - 2100 suppliers: 1500 against a true 1500 − 303 = 1197 (the 4 sourceless payments are still BLOCKING).

## 5. Workaround rows (16:05:36Z)

Every Day 2 table was checked for rows updated or created between 16:05:00 and 16:06:00. Exactly 3 rows changed, as the note says:

| Row | Change |
|---|---|
| HandoverSession cmwcb3zgz00xjhljotnbv5i9v | status COMPLETED, `completedAt` = `exceptionAt` 16:05:36.400, `exceptionById` = owner, `exceptionReason` "SIMULATION WORKAROUND…", updatedAt 16:05:36.419 |
| InventoryFreeze cmwcb3ziu00xnhljofs8hqufk | `releasedAt` 16:05:36.400, `releasedById` = owner |
| Shift #5 cmwcb2vtt00x3hljodnt828vb | CLOSED, `closedAt` = `stockClosedAt` 16:05:36.400 (closedById هالة was already set at 16:01:40) |

- No Payment, InventoryItem, InventoryTransaction, StockCount, CustodyPeriod, VarianceCase, TenderReconciliation or Order row was touched. No AuditLog row exists between 16:04:10 and 16:06:10.
- Side effects that remain:
  1. The owner is recorded as the actor of a release and exception he did not perform, and the audit log has no trace of it.
  2. The stray count cmwcb65ir00xxhljotztch2ih (هالة, on كريم's stock custody) is CONFIRMED and never locked. The owner had acknowledged its two lines at 16:04:03 through the app, before the fix.
  3. That stray count is now the baseline for shift #4. Its materials `coverageFrom` is 16:04:03.345 (the stray handover's submittedAt). The night count lines' `confidenceWindowFrom` is 16:04:03.112 and their confidence is UNVERIFIABLE, with costImpact null.
  4. هالة is still a SHARED participant (no `leftAt`) on كريم's cash and stock custody.
  5. handover-accountability shows shift #5 as a "RECOUNT / MATCHED" close.

## 6. Actors on Day 2 money and stock rows

| Rows | Actor | Remark |
|---|---|---|
| #48–#50 (T1–T3) | created/served by وليد; `saleShiftId` NULL | created 15:42:29–37, before any cashier shift (shift #3 opened 15:43:15) |
| #51–#58 / #59–#64 | سارة / كريم, matching payments and shifts | fine |
| #48/#49 collections | سارة, shift #3 | fine |
| #50 collection | كريم, shift #4 | correct drawer, no link to the morning shift |
| Refund #52 | requester and executor كريم, approver owner; REFUND row in shift #4 | fine; reports disagree on whose refund it is (§1d) |
| Stock rebases AM (−0.168, −0.98, −0.3) | rebasedBy كريم, booked to سارة's custody/shift #3 | −0.3 is كريم's receiving finding, booked to سارة with no case |
| INV-D2-001, سكر item, PURCHASE rows | عادل, into كريم's custody/shift #4 | no acknowledgement by the custodian (D1-AM F13 pattern) |
| Shift #4 close, tender reconciliations, VarianceCase −10, counts | هالة | fine |
| **InventoryFreeze cmwcb9tt500ywhljoyiha41gk** `startedById` and AuditLog `INVENTORY_FROZEN` / `HANDOVER_STARTED` (16:06:13.29) | **كريم** | **wrong person**: the request was هالة's close (timeline line 1117, AuditLog SHIFT_CLOSED by aus05j at 16:06:13.308) |
| Night handover acceptance, rebase 0, branch stock custody | owner | fine |
| HandoverSession cmwcb3zgz00xjhljotnbv5i9v `exceptionById`, freeze cmwcb3ziu00xnhljofs8hqufk `releasedById` | owner | **wrong person**: set by the coordinator's data fix |
| Shift `closedById` (#2 سارة, #3 كريم, #4 owner) | acceptor | by schema design `closedById` means "who accepted and discharged". This corrects D1-AM F12. The shift report still pairs `closedByName` with the financial close time |
| Night count lines | هالة; she copied the GET /api/inventory figures (her diary) | "BLIND" mode, but not an independent count |

---

## Candidate findings (new, or with changed numbers)

**Q1. The night close into branch custody leaves the cash with nobody.** High confidence.
- Shift #4 closed BRANCH_CUSTODY with 3083.05 cash, 230.60 card and 114.00 wallet.
- No ShiftCashDisposition was asked for or created.
- Cash custody cmwcavboo00r7hljox8civnxc was CLOSED at the financial close with no successor and `acceptedById` NULL.
- The owner's approval opened only a STOCK branch custody (cmwcbdxby010lhljoo94phcvg); handover `incomingCashCustodyId` is NULL.
- No safe, CashStorage or delivery row exists.
- The next morning's opening has no cash custody to open against.

**Q2. The −50 handover shortage is never in the books, and the reports disagree on who owes it.** High confidence.
- OpeningException cmwcagmkk00f7hljowxtm549q and VarianceCase cmwcagmlt00f9hljoxdljkafi sit on shift #2 / كريم's custody with no person assigned.
- employee-variances names كريم. handover-accountability calls it "shared" between سارة and كريم and leaves it out of cashShortage (310). The daily report leaves it out too (−310).
- The projection has no source for it: only `Shift.cashDifference` posts, and shifts #2 and #3 are both 0. So 1110 will stay 50 above the drawer.
- The HandoverIssue for the same 50 is a second, unlinked open item.

**Q3. Stock-count rebases carry no cost, so the stock losses never reach the books.** High confidence.
- The three non-zero COUNT_REBASE rows (cmwcavbgs00q5hljozgtp1no6 −0.168 بن, cmwcavbhp00qbhljor599y805 −0.98 لبن, cmwcavbib00qhhljovcvh7t50 −0.3 لبن) have `totalCost` NULL. The count lines priced the first two at 75.60 and 37.24.
- The projection turns them into "حركة مخزون من غير تكلفة" exceptions. 1200 inventory will be 124.24 above perpetual stock, and INVENTORY_LOSS stays 0.

**Q4. The incoming cashier's receiving difference (−0.3 لبن, 11.40) has no case, no cost and no owner.** High confidence.
- Acknowledgement cmwcaufxj00pxhljoxas9nnc5 was ACCEPTED with a −0.3 difference and no dispute reason.
- The app silently rebased the stock into the *outgoing* custody (سارة, shift #3).
- employee-variances and handover-accountability do not show it. Only the shift #3 materials block does.

**Q5. An expense paid from a cashier's drawer cannot be recorded, so the close nets it against an unexplained surplus.** High confidence.
- The 40 ice was refused twice. Opening a 0-cash manager shift made it worse: "النقد المتوقع المتاح لا يكفي", and هالة's shift #5 became SHARED custodian of كريم's drawer, which led to the deadlock F-053.
- Result: one case of −10 against كريم (cmwcb9tov00ymhljoldtlv0ow), instead of a 40 expense (هالة's decision) plus a +30 surplus case.
- P&L opex stays 0 and 5300 takes 10. The two facts survive only in a free-text note, and `cashReasonCodeId` is NULL.

**Q6. Day 2 stock-variance sign and reason gaps.** Medium confidence.
- Stock VarianceCases show `amountVariance` +75.60 / +37.24 for shortages (CASH cases use negative). handover-accountability shows −75.60 / −37.24.
- The count lines have no reason code, yet the handover was accepted.

**Q7. A morning order refunded from the evening drawer is reported three different ways.** Medium confidence.
- The cash is right: shift #4, كريم's drawer.
- Shift-sales nets the refund against shift #4 sales (621.30) and leaves shift #3 unreduced (723.90).
- Daily `salesByStaff` charges it to سارة, while `refundsByActor` gives it to كريم.
- The projected journal will book it gross: VAT 16.80 not reversed (D1-AM F4, day total now 35.70).
- The 40.00 of croissant COGS stays with no return or waste link.

**Q8. Orders taken before the cashier opened, and the open table at shift change (D1-PM P3, new numbers).** High confidence.
- #48–#50 (350.00 ex-VAT / 399.00 incl.) have `saleShiftId` NULL. The waiter was allowed to order with no open cashier shift.
- Shift-sales shows shift #3 with 8 orders and shift #4 with 6, against 10 and 7 in the Shift rows. Day "صافي اعتراف الورديات" is 3374.40 against daily netSales 5739.90.
- Table 3's receivable (193.80) crossed the AM→PM handover with `carried 0 / unpaidTotal 0`. Its cash landed in shift #4, while its COGS (47.50) stayed in shift #3.

**Q9. A zero-cost item is accepted on a purchase.** Medium confidence.
- سكر was created at cost 0 and received ×5 at unit cost 0 on INV-D2-001 without a warning.
- Its stock value is 0, the GL gets no line, and future COGS for it will be 0.

**Q10. Night handover count and actors.** Medium confidence.
- The night count (cmwcba1ia00z8hljo3otcl22j) was "BLIND" but copied from GET /api/inventory by هالة. Lines are UNVERIFIABLE with no costImpact.
- Its window starts at the stray shift-#5 count, which was never accepted and was closed by data fix.
- InventoryFreeze cmwcb9tt500ywhljoyiha41gk and the HANDOVER_STARTED audit row are attributed to كريم, though هالة performed the close.
- handover-accountability still says the night close had "stock items 0, notCounted 8", although 2 items were counted (D1-PM P4 pattern).

**Q11. Handover-accountability adds the chained drawer every time (D1-PM P4, new numbers).** Medium-high confidence.
- `ledgerTotals` expected 9804.10 / counted 9494.10 = Σ of 5 closes (1864.95 + 2223.55 + 2622.55 + 3093.05 + 0).
- There is one physical drawer of 3083.05 at day end.

**Q12. The books are now two shifts and a day behind (D1-PM P1, new numbers).** High confidence.
- Missing: D1 PM plus D2 sales 2825.00 ex-VAT, VAT 395.50, collections 3220.50 (net of the 136.80 refund 3083.70), COGS 729.45 and purchase 450.
- The trial balance still reports "balanced" at 21457.92.

Unchanged and not repeated: D1-AM F1 (−300 on سارة), F3, F5, F9 and F10; D1-PM P2 (3 EGP), P5 and P8.
