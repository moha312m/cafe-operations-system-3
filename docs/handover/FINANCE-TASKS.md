# Cash leaving the drawer — task for the finance track

Owner decision (2026-11-11): these fixes belong to the finance track, not the handover workstream (RULES.md: supplier payments, expenses, treasury, advances).
Evidence: live simulation of 2026-11-11, `C:\Dev\cafe-operations-system-3\docs\handover\simulation\run-2026-11-11\` (findings F-002, F-016, F-017, F-019, F-023, F-057, F-062; audits `evidence/audit-D1-AM.md`, `audit-D2.md`). Tested tree: `handover/integration` @ 65993e3.

## What goes wrong today
1. **Cash supplier payment with no source (F-017, critical).** `POST /api/purchases/:id/payments {"method":"CASH"}` is accepted with `fundingSource: null`. `FUNDING_SOURCES = ["DRAWER","SAFE","BANK"]` exists (src/lib/purchases.ts:33) but is optional. Result in the simulation: 300 paid from the drawer by the storekeeper → shift `totalCashPayouts` 0 → the cashier's close shows a false −300, a variance case on her, and the projector cannot post the payment (supplier shows 1,050 owed instead of 747).
2. **No way to record an expense paid from a cashier's drawer (F-016, high).** Expenses are owner/manager only and need the actor's own open shift; a manager who opens one gets a 0 drawer ("النقد المتوقع المتاح لا يكفي للصرف"). Opening that shift also deadlocks the night close (F-053).
3. **No employee advances at all (F-002/F-019, high).** An advance from the drawer can only appear as an unexplained shortage.
4. **Night cash after a branch-custody close has no holder (F-057, critical)** and the morning opening never compares the cash (F-067). This touches treasury / overnight storage.
5. **Zero-cost purchase lines accepted silently (F-062).**

## What "done" should mean (acceptance, for the finance track to refine)
- A CASH supplier payment must name its source. DRAWER links to an open shift whose cash custody the actor holds or shares, and reduces that shift's expected cash. SAFE/BANK post to treasury. A legacy null stays a projector exception, but new nulls are refused.
- An expense paid from a cashier's drawer can be recorded by the manager against **that cashier's open shift**, or by the cashier with manager approval. The actor, the shift and the receipt (or "no receipt" + reason) are recorded, and it posts.
- An employee advance from the drawer: employee, amount, shift, actor; it reduces expected cash and appears in the handover.
- The handover screen and the close list every cash-out of the shift (supplier, expense, advance, delivery) before the count.
- Every one: one transaction, idempotent on duplicate submit, safe against two devices, actor recorded, audit row; corrections by reversing entry.

## Known overlap
`feature/hnd-cash-01` / `feature/finance-f1-purchase-payments` (worktree `C:/Dev/cafe-ops-finance-f1`, draft PR #4) contain `ACC-01A drawer expenses + ACC-01B purchase payments + ACC-02A treasury (local save point)`. Check what is already built there before designing.
