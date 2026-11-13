# Stock handover v2 — delivery report (2026-11-12)

Owner decision: a stock handover is **counting, reporting and accountability — never blocking**.
Where: worktree `C:/Dev/cafe-ops-handover-p1`, branch `handover/p1-shift-open-custody`, on top of the local P1 save point `e0be1c9`. **Nothing is committed, pushed, merged or deployed.**

## What changed, in plain words

**Nothing stops work any more because of stock:**
- Closing a shift no longer freezes the stock. Sales, purchases, transfers and adjustments keep working during a handover.
- A new shift is never held back by stock. It takes the shelf as the books show it and can sell straight away. This includes opening against stock the branch holds. (Before: "waiting for opening verification".)
- The outgoing employee can finish with no count, a partial count, or a count that is not confirmed. The gaps are reported, not refused.
- Receiving a handover needs none of these any more: a signed sheet, a confirmed count, every required item counted, or no disputes. It can be received even if the outgoing employee never finished counting, as long as the cash step was done. (The cash rules are unchanged.)
- At close, an open count, corrections awaiting approval and draft purchase invoices are shown as **warnings**, not blockers. Unserved orders and "a handover already in progress" still block as before.

**Nothing is posted automatically:**
- A count no longer becomes the stock balance. There is no rebase on acceptance, and the receiver's count is never applied.
- No automatic stock case naming an employee. (Cash cases are unchanged.)
- Any correction to the stock goes through the normal "stock adjustment" screen, by an authorised person.

**What is recorded instead:**
1. **Two independent counts.**
   - The outgoing employee's count is unchanged.
   - The receiving employee's own count is new. It is **blind**: the outgoing figures are hidden from the receiver until they submit their own. Managers and owners see both.
2. **Every figure carries its exact moment.** Each counted figure keeps the stock-book position at the moment it was counted. That lets the system add the sales and movements recorded between the two counts, and count each one exactly once.
3. **The comparison, for each item:**
   - Raw difference = received count − handed-over count.
   - Expected = handed-over count + movements recorded between the two counts.
   - Difference after movements = received count − expected.
   - Labels:
     - "مطابق" (no difference).
     - "فرق مفسَّر بحركات مسجلة" (the movements explain it).
     - "فرق غير مفسَّر — مطلوب مراجعة" (unexplained; needs review).
     - "المقارنة غير متاحة" (an item one side didn't count). A missing count is never treated as zero, and different units are never added together.
4. **Notifications.**
   - Any difference (raw or after movements) notifies every manager of the branch and every owner. It is sent once per comparison and person, in the same database transaction as the submission that caused it.
   - A missing outgoing count is reported when the outgoing employee finishes or the handover is received.
   - A missing incoming count is reported when the receiving shift closes.
   - The counted employees are never the recipients.
5. **Corrections are new revisions.** After submitting, a changed figure needs a written reason. It is saved as a new revision; the old figure is kept, and the database refuses edits to saved lines. A correction produces a new comparison version (the old one stays) and a new notification.
6. **Review by the manager or owner.**
   - The review has:
     - A status: مفتوح ← قيد المراجعة ← اتراجع ← اتقفل.
     - A classification: counting error, unrecorded usage, waste, receiving/transfer, unexplained shortage, explained by movements, or other.
     - Notes that can't be edited or deleted. Each change of status or classification is saved with its note, author and time.
   - The report can be filtered by result, status, classification and date, and exported to Excel (two sheets: handovers and items).

## Screens (Arabic, right-to-left, phone-friendly)
- `/handovers/incoming-count?handoverId=…` — «جرد الاستلام» (also a button on the handover screen).
- `/reports/stock-handovers` — «جرد التسليم والاستلام»: list, filters, Excel, and the detail view (both counts side by side, the movements between them, earlier versions, review notes).
- `/notifications` — «التنبيهات».
- Nav and report-center entries for managers and owners.

## Database
- Migration `20261112090000_stock_handover_v2`.
  - **Additive only:** 6 new tables (incoming count, incoming lines, comparison, review, review notes, notifications) and 4 enums. Nothing existing is altered.
  - Two database triggers refuse edits to count lines and review notes.
  - Two check constraints: a revision after the first needs a reason, and quantities can't be negative.
- Applied **only** to a new disposable database, `cafe_ops_test_shv2` on the test cluster (5434). Not applied to `cafe_ops_test` (your browser-test DB), not to 5433, and not to any shared, QA or production database.
- Name checked against every worktree and branch: no migration after `20261106131000` exists anywhere.

## Environment changes (local only)
- The P1 worktree now has its own copy of the database client, so generating it there can't touch another worktree. The other worktrees' clients were checked: unchanged.
- Test server **3102** now runs this code against `cafe_ops_test_shv2`. Server 3100 (unchanged integration code, `cafe_ops_test`) was not touched.

## Tests
See `STATUS.md` for the final counts of the last run.
- **New tests:**
  - `shv2-001` — the arithmetic, including movement windows, missing counts, units and exact decimals.
  - `shv2-002` — the whole journey over HTTP: no freeze; selling continues; an outgoing count with a gap; the blind incoming count; revisions and retries; movement-adjusted comparison; deduplicated notifications to manager and owner only; a correction needing a reason and creating a new version; the append-only review; filters and Excel; the next shift not held back; and the missing-incoming-count notification.
  - `shv2-003` — count conditions are warnings, not blockers, at close.
- **Old tests that pinned the blocking rules were updated, not deleted.** Each edited test says "Stock handover v2 (owner decision 2026-11-12)" and now asserts the new behaviour, for example "accepted and recorded" instead of "refused".
  - Tests for the old opening-verification path were kept. Their setup now writes the old "waiting for verification" state directly, because shifts already in that state when this ships still need that way out.

## Not done / known limits
- If the outgoing employee is still counting when the handover is received, that unfinished count is closed as history (owner decision 2026-11-13, C2): its figures stay exactly as they were, it is never shown as confirmed, and it cannot be finished afterwards. Left open, it would stop the branch from ever starting another count. The handover is recorded as received without a confirmed count.
- The legacy line-by-line signing sheet and "send back for recount" still exist as options. They no longer block anything.
- The demo seed has one cashier. For a browser check of the blind count, use a second cashier account (or a manager, who is allowed to see both counts).
