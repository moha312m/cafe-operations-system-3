# Data workaround applied on the disposable test DB (5434) — Day 2 evening

Why: finding F-053 — the branch night close was deadlocked and every in-app route was refused (cancel, approve, receive, branch custody, override; messages in findings.jsonl).
When: 2026-11-11 ~16:05 local. By: coordinator. One transaction, test DB port verified = 5434.

Rows changed (nothing deleted):
1. HandoverSession cmwcb3zgz00xjhljotnbv5i9v: status INCOMING_REVIEW → COMPLETED; completedAt, exceptionById = owner, exceptionAt, exceptionReason "SIMULATION WORKAROUND…".
2. InventoryFreeze cmwcb3ziu00xnhljofs8hqufk: releasedAt set (released by owner).
3. Shift #5 cmwcb2vtt00x3hljodnt828vb (manager هالة, opened only to record an expense, cash 0): AWAITING_HANDOVER → CLOSED (closedAt, stockClosedAt).
Not changed: custody periods (shared with كريم's open shift #4), counts, money.
Everything after this point in Day 2 PM and Day 3 is labelled «اختُبر بعد إصلاح يدوي».
