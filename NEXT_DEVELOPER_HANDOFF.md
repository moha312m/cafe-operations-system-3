# Next Cup ERP — developer handoff

Written at the point where POS Available-to-Sell was finished and development
was stopped. Everything below is the state as verified on this branch; nothing
here is a plan or an intention.

---

## Where things are

| | Branch | HEAD |
|---|---|---|
| **Stable** | `seif-work` | `e11d13f` |
| **Current feature** | `feature/pos-available-to-sell` | `dd8638b` |

`dd8638b` is the final **code** checkpoint for the Available-to-Sell feature.
This document is the only thing added after it.

The feature branch is **not merged** into `seif-work`, and must not be until
it has been reviewed and manually tested (see *What to do next*).

---

## Completed stable work (already on `seif-work`)

- **Isolated test database.** Automated tests run against a dedicated,
  disposable PostgreSQL cluster and refuse to start against anything else.
  This exists because a test run once wrote 552 audit rows into the owner's
  live café; the guard is not decoration.
- **Inventory enforcement modes** on `CafeSettings`, replacing the old
  `Cafe.allowNegativeStock` boolean:
  - `STRICT` — refuse a shortage and refuse an unreadable recipe.
  - `ALLOW_NEGATIVE_STOCK` — accept a *known* shortage; still refuse an
    unknown consumption. Going below a balance we can compute is a different
    risk from selling against a recipe nobody wrote, which is why this mode
    sits between the other two rather than being a synonym for either.
  - `OVERRIDE_ALL` — accept both, with a warning and an audit row.
- **Order inventory-policy snapshot.** `Order.inventoryEnforcementMode` is
  captured at creation, so a settings change never retroactively rewrites the
  rules an order was accepted under.
- **Owner DB is at 42 migrations.**
- **Next Cup café is currently `STRICT`.**

---

## What the ATS feature branch adds

- **Available-to-Sell count** beside every sellable configuration on the POS.
- **Limiting-ingredient calculation** across the *complete* recipe — a
  milkshake whose ice cream supports 5 and whose milk supports 20 supports 5.
- **Variants** counted independently; a product whose sizes draw differently
  shows a range and defers to the size picker rather than inventing one
  number.
- **Add-ons** merged into the base per ingredient before anything is compared.
- **Cart-adjusted availability**, recomputed in the browser from the payload
  already sent, using the same function the server uses.
- **Open-order inventory commitments** — an accepted order reduces
  availability even though stock is only deducted at SERVED.
- **Immutable consumption snapshots** — what an order was accepted for is
  never recomputed.
- **Recipe changes affect new sales only**; existing commitments are untouched.
- **Concurrency protection** — acceptance takes the capacity under row locks,
  so two tills cannot both sell the last four of five portions.
- **Batch availability endpoint** — `GET /api/pos/availability`.
- **Constant-query / no-N+1 design** — measured at **9 SQL statements for 19
  configurations and 9 for 199**.

---

## Verification as it stands

```
751 tests
750 pass
  1 fail
```

Typecheck, production build and `prisma validate` all pass. Lint is unchanged
from the baseline (48 problems, 1 pre-existing error; none in the new files).

### The one failure

`COUNT-001 — every pre-existing inventory item reads isCritical = false`

This is a **pre-existing environmental / UAT-data issue, not a code defect**,
and it is not caused by this feature. Two ingredients in the manual-UAT café
in the test database carry `isCritical = true`, and the test asserts that no
café acquires a critical list it did not choose. It was **reproduced on the
untouched baseline** (`seif-work` @ `e11d13f`: 687 tests, 686 pass, same one
failure) before any ATS work began.

It has deliberately **not** been fixed here — classifying it properly is the
first task below.

> This branch is **not** production ready. It is ready for review and manual
> UAT.

---

## Pending migration

```
20260829120000_order_inventory_commitment
```

| Database | State |
|---|---|
| Test DB — `127.0.0.1:5434/cafe_ops_test` | **applied** |
| Owner DB — `127.0.0.1:5433/postgres` | **NOT applied** |

The migration is additive: one enum, one table
(`OrderInventoryCommitment`), one nullable column
(`Order.inventoryCommittedAt`). Nothing is dropped, altered or rewritten.

**There is deliberately no backfill.** Finalised orders need no commitment,
and open orders that predate the ledger have no consumption evidence in
`OrderItem` — reconstructing them from today's recipe would produce a figure
that looks like history and is not. They are counted and disclosed as
`uncertainOpenOrders` instead, and the condition clears itself as those orders
finalise in the ordinary course of a shift.

---

## Database safety

| | |
|---|---|
| **Owner DB** | `127.0.0.1:5433/postgres` |
| **Test DB** | `127.0.0.1:5434/cafe_ops_test` |

- **Automated tests must never use the Owner DB.** `npm test` supplies the
  test `DATABASE_URL` itself, never inherits `.env`, and proves the app server
  under test reads the same database before a single test file loads.
- **Never run `prisma migrate reset` (or `db push`, or `migrate dev`) against
  the Owner DB.**
- Owner DB was fingerprinted before and after all ATS work: zero rows, zero
  content changes, zero timestamp drift, zero AuditLog growth.

---

## What to do next

1. **Reproduce and classify COUNT-001** — confirm it is UAT data rather than
   code, and decide whether the fixture or the assertion should change.
2. **Reach a full suite with zero failures.**
3. **Perform manual ATS UAT** on the test café.
4. **Review the ATS feature.**
5. **Merge into `seif-work` only after approval.**
6. **Take a fresh Owner DB backup.**
7. **Apply the pending migration safely.**
8. **Verify the Owner DB** after the migration.
9. **Push `seif-work`.**
10. **Resume the roadmap:** Variance atomicity → Cash/Card/Wallet → Handover →
    Opening Shift controls.

---

## Notes for the reviewer

Two changes on this branch sit slightly outside the feature's headline scope,
both deliberate and both flagged in their own commits:

- `src/lib/financials.ts` — `getBranchFinancialSettings` created its defaults
  row with a plain `create`, so two simultaneous first orders on a branch
  raced and one received a 500. Fixed by treating the unique-index violation
  as success and reading the winner's row. The concurrency test could not pass
  without it.
- Recipe reads that run inside a transaction now use that transaction's
  client rather than the global one, which avoids taking a second pooled
  connection while the first is held.

The commit history on this branch is intended to be read in order; each commit
message explains why the change is shaped the way it is.
