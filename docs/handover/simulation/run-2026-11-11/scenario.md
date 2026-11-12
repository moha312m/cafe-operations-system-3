# Simulation scenario — saved before the run (2026-11-11)

Environment: test server http://localhost:3100 (tree `handover/integration` @ 65993e3 = PR #5 30c40cc + docs) · test DB 127.0.0.1:5434 / cafe_ops_test (reset and reseeded at the start of the run) · café «demo» seed, branch «فرع التجمع» · currency EGP.
No clock control exists in the app → the 3 days run back to back on the same calendar day; date-dependent checks (daily report per day, business date, materials cadence by day, midnight handover) are «لم يُختبر».
WhatsApp: no integration enabled in the seed; the server's WhatsApp address points at a dead local port (127.0.0.1:9).

## Staff (created by the owner through the app)
| Card | Account | System role | Permission role |
|---|---|---|---|
| سارة — كاشير الصباح | sara.am@sim.test | CASHIER | كاشير |
| كريم — كاشير المساء | karim.pm@sim.test | CASHIER | كاشير |
| وليد — ويتر | walid.waiter@sim.test | WAITER | ويتر |
| هالة — مديرة الفرع | hala.mgr@sim.test | BRANCH_MANAGER | مدير |
| مازن — باريستا | mazen.bar@sim.test | BARISTA | بارستا |
| عادل — أمين المخزن | adel.store@sim.test | INVENTORY_MANAGER | مسؤول مخزون |
| منى — محاسبة | mona.acct@sim.test | CASHIER (no ACCOUNTANT system role exists) | محاسب |
| أحمد — المالك | owner@demo.com (seed) | CAFE_OWNER | — |
Roles a real café needs that do not exist: attendance/HR clerk, payroll, employee advances (no module at all), kitchen separate from bar (BARISTA covers both).

## Shift plan (each day: morning AM, evening PM)
AM: cashier سارة, waiter وليد, barista مازن, manager هالة, storekeeper عادل. PM: cashier كريم, same waiter/barista/manager.
Opening float: 500 EGP each morning (Day 1 first open); later shifts open against what the previous close left.

### Scenes per shift
1. Attendance (no module → recorded as missing), shift open, opening float, custody gate.
2. Service: ~20 orders in batches — takeaway by cashier, dine-in by waiter on tables, payment methods CASH / CARD / WALLET / MIXED split, one discount, one void (cancel), one refund request, one table transfer. Barista advances statuses.
3. Shift events: petty cash expense (manager), supplier delivery + payment (storekeeper/manager), employee advance (no module → finding), cash handed to manager/owner (cash disposition at close).
4. Before handover: open tables, unpaid orders, pending items.
5. HANDOVER: outgoing count of the selected items, incoming receiving sheet (independent recount), critical items بن/لبن, variances, accept / dispute / override, sign-off.
6. After handover: incoming works on inherited stock; outgoing cashier tries to act and must be blocked.
End of day (PM close): close into branch custody, daily reports, P&L. Next morning: open against last night's close (morning opening count).

### Days
- Day 1 normal: exact cash, no variances. Both handovers through the real screens (browser, phone width).
- Day 2 problems: cash shortage at AM handover, surplus at PM; stock variance on بن and لبن + one item with no cost; open tables at shift change; incoming cashier late; supplier delivery during handover; expense with no receipt; PM refund of an AM order; refresh / connection loss mid-handover; double tap on every submit. One handover through the real screens.
- Day 3 misuse: cash delivery disputed then resolved; manager override with and without reason; outgoing leaves without handing over; two devices on one handover; outgoing and incoming confirming at the same moment; editing counts after sign-off; applying variances twice; opening a new shift while the previous is not closed; midnight handover (no clock control → «لم يُختبر»).

### Every shift
After the shift: AUDITOR recomputes drawer and stock from raw records and compares with screens, journal and P&L; CONTROLS TESTER tries forbidden actions. Timeline (logs/timeline.jsonl) and findings (logs/findings.jsonl) saved after every shift.
