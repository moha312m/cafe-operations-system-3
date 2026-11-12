# Staff route guide (what each screen action calls)

Helper (always set these first in the same shell command):
```
export MSYS_NO_PATHCONV=1 SIM_ACTOR="<your role card name>" SIM_SCENE="<D1-AM-S2 etc>"
S="node C:/Dev/cafe-operations-system-3/docs/handover/simulation/run-2026-11-11/tools/sim.mjs"
$S call <your-email> GET /api/shifts/active?branchId=$BR
$S call <your-email> POST /api/orders '<json>'
$S call <your-email> POST /api/handovers/<id>/accept '<json>' --idem <key>
$S call <your-email> POST /api/orders '<json>' --times 2 --parallel      # double tap
$S batch <your-email> <file.json>      # [{"method":"POST","path":"/api/orders","body":{...},"tag":"order 3"}]
```
You are already logged in (cookie saved). Branch: `BR=cmwc33qgt0012hlng6f0q8uz6` («فرع التجمع»). Money is EGP.
Write JSON bodies to a file in your scratch folder and pass `@file.json` when they contain Arabic or quotes.

## Shift (POS top bar)
- See my shift / opening requirements: `GET /api/shifts/active?branchId=BR` → `shift`, `pendingShift.waitingFor`, `openingBlocker`, `carryforward`
- «فتح الشيفت»: `POST /api/shifts {"branchId":BR,"openingCashAmount":500}`
- Close screen data («إنهاء الشيفت» → /close-shift): `GET /api/shifts/close-flow?branchId=BR`
- Drawer split before close (direct handover / cash to owner): `GET|POST /api/shifts/<shiftId>/cash-disposition {"deliveries":[{"destination":"OWNER"|"MANAGER","recipientId":"<userId>","amount":200}],"retainedAmount":300,"note":"","idempotencyKey":"k"}`
- Close («إغلاق الشيفت»): `POST /api/shifts/<shiftId>/close {"actualCashAmount":N,"reason":"…if difference","actualCardAmount":N,"actualWalletAmount":N,"handoverTarget":"SHIFT_TO_SHIFT"|"BRANCH_CUSTODY","directHandover":false}`
- Shift report: `GET /api/shifts/<shiftId>/report`

## Menu / orders (POS)
- Products: `GET /api/products?branchId=BR` (variants inside each product)
- New order (ALWAYS add `--idem <unique key>`; a repeat of the same key is a double tap): `POST /api/orders {"branchId":BR,"type":"TAKEAWAY"|"DINE_IN","tableNumber":"3","items":[{"productId":"…","variantId":null,"quantity":1}],"collectionMode":"NOW"|"PENDING","method":"CASH"|"CARD"|"WALLET"|"MIXED","splits":[{"method":"CASH","amount":20},{"method":"CARD","amount":15}],"discountAmount":0,"invoiceDiscount":{"type":"PERCENT","value":"10"}}`
- Collect later: `POST /api/payments {"orderId":"…","method":"CASH","amount":N}`
- Order list: `GET /api/orders?branchId=BR` ; one order: `GET /api/orders/<id>`
- Edit open order: `PATCH /api/orders/<id> {"items":[{"id":"<orderItemId>","quantity":0}],"newItems":[…]}`
- Status (kitchen/bar, waiter): `PATCH /api/orders/<id>/status {"status":"PREPARING"|"READY"|"SERVED"|"CANCELLED","reason":"…"}`
- Refund request: `POST /api/orders/<id>/refund {"reason":"…"}` or per payment `POST /api/payments/<paymentId>/refund {"reason":"…"}`
- Owner approval queue: `GET /api/owner-action-requests` ; decide `POST /api/owner-action-requests/<id>/decision {…}`
- Open orders summary: `GET /api/orders/open-summary?branchId=BR`

## Tables (waiter)
- Tables: `GET /api/tables?branchId=BR` ; selector `GET /api/tables/selector?branchId=BR`
- Dine-in order goes through `POST /api/orders` with `"type":"DINE_IN","tableNumber":"N","collectionMode":"PENDING"`
- Transfer table: `POST /api/tables/<tableSessionId>/transfer {"tableNumber":"5"}`
- Pay table: `POST /api/tables/<tableSessionId>/pay {"mode":"FULL","method":"CASH"}`
- Close table: `POST /api/tables/<tableSessionId>/close`

## Expenses, suppliers, stock (manager / storekeeper)
- Expense («مصروفات»): `POST /api/expenses {"branchId":BR,"categoryId":"cmwc3aqal0025hl541cuaabpt","amount":50,"description":"…","documentReference":"receipt no."}` (header Idempotency-Key may be required: use --idem)
- Suppliers: `GET /api/suppliers`
- Purchase / delivery («فاتورة شراء»): `POST /api/purchases {"branchId":BR,"supplierId":"…","invoiceNumber":"…","items":[{"inventoryItemId":"…","quantity":5,"unitCost":38}],"payment":{"amount":190,"method":"CASH"}}` then `POST /api/purchases/<id>/confirm`, pay later `POST /api/purchases/<id>/payments {"amount":N,"method":"CASH"}`
- Stock list: `GET /api/inventory?branchId=BR` ; movement (waste/adjust): `POST /api/inventory/<itemId>/movement {"type":"WASTE"|"ADJUSTMENT","quantity":-1,"note":"…"}`

## Handover («التسليم والاستلام»)
- List / mine: `GET /api/handovers?branchId=BR` ; detail: `GET /api/handovers/<id>`
- Outgoing: start the count `POST /api/handovers {"action":"start_count","handoverId":"…"}` → returns countSession
- Count a line: `PATCH /api/stock-counts/<countId>/lines/<lineId> {"countedQuantity":12,"expectedCountedAt":null}` (see lines: `GET /api/stock-counts/<countId>`)
- Submit count: `POST /api/stock-counts/<countId>/submit {}` ; confirm count (manager): `POST /api/stock-counts/<countId>/confirm {"idempotencyKey":"k"}`
- Reason for a variance line: `POST /api/stock-counts/<countId>/lines/<lineId>/variance-reason {"reasonCodeId":"…","note":"…"}` ; accept variance (manager) `…/accept-variance {"reasonCodeId":"…"}` ; recount `…/recount {…}`
- Finish outgoing («تسليم»): `POST /api/handovers {"action":"finish_outgoing","handoverId":"…","note":"…"}` (older path: `{"action":"submit",…}`)
- Incoming receiving sheet: `POST /api/handovers/<id>/acknowledge {"countSessionId":"…","countVersion":"…","idempotencyKey":"k","lines":[{"stockCountLineId":"…","incomingCountedQuantity":12}]}` (dispute a line: add `"disputeReasonCodeId":"…","disputeNote":"…"`); countVersion comes from GET /api/handovers/<id>
- Accept («استلام»): `POST /api/handovers/<id>/accept {"idempotencyKey":"k","incomingShiftId":"<my shift>","countedOpeningCash":N,"cashReasonCodeId":"…","cashReasonNote":"…"}`
- Request recount: `POST /api/handovers/<id>/request-recount {"reasonCodeId":"…","note":"…"}`
- Manager: override accept `POST /api/handovers/<id>/override-accept {"idempotencyKey":"k","reasonCodeId":"…","note":"…","kind":"MANAGER_ADJUSTMENT"|"NO_INCOMING","incomingUserId":"…"}` ; end to branch custody `POST /api/handovers/<id>/to-branch-custody {"idempotencyKey":"k"}` ; approve `POST /api/handovers/<id>/approve {"reasonCodeId":"…","note":"…"}` ; cancel `POST /api/handovers/<id>/cancel {"reasonCodeId":"…","note":"…"}`
- Direct handover (summary only): `GET /api/handovers/<id>/direct` ; accept `POST /api/handovers/<id>/direct {"reviewVersion":"…","idempotencyKey":"k"}`
- Report a difference: `POST /api/handovers/<id>/issues {"kind":"CASH"|"STOCK_ITEM"|"OTHER","amount":N,"description":"…"}`
- Morning count when the branch held the stock overnight: `POST /api/custody/opening-verification {"action":"start_count","branchId":BR,"shiftId":"…"}` then count + submit + confirm, then `{"action":"verify","branchId":BR,"shiftId":"…","countSessionId":"…"}`
- Cash handed to owner/manager: recipient sees `GET /api/cash-deliveries` ; confirm `POST /api/cash-deliveries/<id>/confirm {"idempotencyKey":"k"}` ; dispute `…/dispute {"note":"…","claimedReceivedAmount":N}` ; resolve (owner) `…/resolve {"resolutionNote":"…","resolvedAmount":N}`

## Reports (manager / accountant / owner)
- Daily: `GET /api/reports/daily?branchId=BR` ; shift sales `GET /api/reports/shift-sales?branchId=BR` ; employee variances `GET /api/reports/employee-variances?branchId=BR` ; handover accountability `GET /api/reports/handover-accountability?branchId=BR`
- Books: `GET /api/accounting/pnl?branchId=BR` ; `GET /api/accounting/trial-balance?branchId=BR` ; `GET /api/accounting/journal?branchId=BR`

## Reason codes (ids)
SIM_HO_SHORT عجز عند التسليم · SIM_HO_COUNT خطأ في العد · SIM_HO_MGR قرار مدير · SIM_ST_WASTE هالك · SIM_ST_COUNT فرق جرد · SIM_CASH_SHORT عجز نقدية · SIM_CASH_OVER زيادة نقدية — ids in `tools/reasons.json`.

## Sellable menu on Day 1 (recipes set up by the owner at 14:32)
شاي 25 · كرواسون 60 · عصير برتقال 60 · إسبريسو سنجل 45 / دبل 60 · كابتشينو صغير 50 / وسط 70 / كبير 90 · لاتيه (3 sizes, see products.json). Other items have no recipe and are refused. Prices are before 14% tax; totals include it.

## Corrections learned on Day 1 (read these)
- Order status is PATCH /api/orders/<id>/status (POST gives 405). Waiter/cashier can mark SERVED only after READY.
- Every money write (orders, payments, table pay/close, supplier payments, expenses) needs `--idem <8+ chars unique>`.
- Amounts are numbers, never strings.
- Cancelling an order or refunding creates an OWNER approval request (202). The owner decides; then the requester executes `POST /api/owner-action-requests/<id>/execute {"idempotencyKey":"<8-64 chars>"}`. If the order changes in between (e.g. marked SERVED), the approval goes STALE and must be requested again.
- Waiter cannot take money, close or transfer tables; the cashier collects (POST /api/tables/<session>/pay, then /close); table transfer = manager.
- Expenses can be recorded only by owner/manager who has an open shift of their own (no way to pay from the cashier's drawer).
- The cashier's close screen is blind: it never shows expected cash.
