# R1 accounting verification

The owner has held historical accounting changes. The November 11 figures below come from the previous R1 comparison on the marked disposable database `cafe_ops_test` on local port 5434. That comparison rolled back the journal postings and verified the original balances. The figures describe a branch of the test café and its open period.

## Historical records identified

PR #7 can value a movement whose type is `COUNT_REBASE`, whose quantity is nonzero and whose stored total cost is null. It uses a positive cost captured on the linked count line. A legacy receiving-count movement can instead name its acknowledgement in the movement note and use the acknowledgement's count-line cost. A missing or zero historical snapshot leaves an explicit unpostable exception. Today's item cost supplies no historical evidence.

| Disposable movement ID | Quantity | Captured unit cost (EGP) | Additional inventory loss (EGP) |
| --- | ---: | ---: | ---: |
| `cmwcavbgs00q5hljozgtp1no6` | −0.168 | 450.00 | 75.60 |
| `cmwcavbhp00qbhljor599y805` | −0.980 | 38.00 | 37.24 |
| `cmwcavbib00qhhljovcvh7t50` | −0.300 | 38.00 | 11.40 |
| `cmwcjpsn6013whljotbpmr8kq` | −0.500 | 38.00 | 19.00 |
| **Total** | | | **143.24** |

For the November 11, 2026 Cairo business day, the same report yielded the following values. Amounts are EGP.

| P&L measure | Before | With PR #7 historical valuation | Change |
| --- | ---: | ---: | ---: |
| Operating profit | 1,849.68 | 1,849.68 | 0.00 |
| 5200 · هالك وفروقات مخزون | 0.00 | 143.24 | +143.24 |
| Net variances | 300.00 | 443.24 | +143.24 |
| Net profit | 1,549.68 | 1,406.44 | −143.24 |

The P&L shows 5200 under **الفروقات والتسويات**, after operating profit. The net variances subtotal (**صافي الفروقات والتسويات**) is deducted to reach **صافي الربح النهائي**. Inventory control account 1200 is credited EGP 143.24. The net variances values in the table are derived from operating profit less net profit. The comparison executed the P&L engine before and after posting the four candidate entries in the rollback transaction.

The stock-count workbook and P&L answer different questions. The workbook covers confirmed or locked count lines, summarizes the value of their differences and records whether a count rebase exists. A rebase is evidence that stock moved. A journal entry is evidence that accounting posted the movement. The movement's actual quantity drives the candidate journal and can differ from the count-line variance.

## Read-only identification query

Run against a verified disposable database. Bind the café, branch and Cairo-period bounds `[from, to)`. The scope joins validate the source references. Rows with multiple movements pointing at one acknowledgement need individual reconciliation before any decision to post.

```sql
WITH movement AS (
  SELECT m.*,
         substring(m.note FROM '^HANDOVER_RECEIVING_COUNT .*acknowledgement=([^[:space:]]+)') AS acknowledgement_id
  FROM "InventoryTransaction" m
  WHERE m."cafeId" = $1
    AND m."branchId" = $2
    AND m."createdAt" >= ($3::timestamptz AT TIME ZONE 'UTC')
    AND m."createdAt" < ($4::timestamptz AT TIME ZONE 'UTC')
    AND m.type = 'COUNT_REBASE'
    AND m.quantity <> 0
    AND m."totalCost" IS NULL
), evidence AS (
  SELECT m.id, m."createdAt", m."cafeId", m."branchId", m."inventoryItemId",
         m.quantity, m.acknowledgement_id,
         CASE WHEN rs.id IS NOT NULL AND rl."unitCostSnapshot" > 0
              THEN rl."unitCostSnapshot" END AS rebase_cost,
         CASE WHEN hs.id IS NOT NULL AND ac.id IS NOT NULL AND al."unitCostSnapshot" > 0
              THEN al."unitCostSnapshot" END AS acknowledgement_cost
  FROM movement m
  LEFT JOIN "StockCountRebase" r
    ON r."ledgerTransactionId" = m.id AND r."inventoryItemId" = m."inventoryItemId"
  LEFT JOIN "StockCountLine" rl
    ON rl.id = r."lineId" AND rl."sessionId" = r."sessionId"
    AND rl."inventoryItemId" = m."inventoryItemId"
  LEFT JOIN "StockCountSession" rs
    ON rs.id = rl."sessionId" AND rs."cafeId" = m."cafeId" AND rs."branchId" = m."branchId"
  LEFT JOIN "HandoverStockAcknowledgement" a ON a.id = m.acknowledgement_id
  LEFT JOIN "HandoverSession" hs
    ON hs.id = a."handoverId" AND hs."cafeId" = m."cafeId" AND hs."branchId" = m."branchId"
  LEFT JOIN "StockCountLine" al
    ON al.id = a."stockCountLineId" AND al."inventoryItemId" = m."inventoryItemId"
  LEFT JOIN "StockCountSession" ac
    ON ac.id = al."sessionId" AND ac."cafeId" = m."cafeId" AND ac."branchId" = m."branchId"
), valued AS (
  SELECT e.*, coalesce(acknowledgement_cost, rebase_cost) AS snapshot,
         CASE WHEN acknowledgement_id IS NOT NULL
              THEN count(*) OVER (PARTITION BY acknowledgement_id) END AS acknowledgement_uses
  FROM evidence e
)
SELECT v.id, v."inventoryItemId", v."createdAt", v.quantity, v.snapshot,
       -sign(v.quantity) * round(abs(v.quantity) * v.snapshot, 2) AS inventory_loss_delta,
       p.status AS period_status, j.id AS journal_entry_id,
       v.acknowledgement_id, v.acknowledgement_uses
FROM valued v
LEFT JOIN "AccountingPeriod" p ON p."cafeId" = v."cafeId"
  AND ((v."createdAt" AT TIME ZONE 'UTC') AT TIME ZONE 'Africa/Cairo')::date
      BETWEEN p."startsOn" AND p."endsOn"
LEFT JOIN "JournalEntry" j ON j."cafeId" = v."cafeId" AND j."sourceKey" = 'stock:' || v.id
ORDER BY v."createdAt", v.id;
```

Before using a result for approval, verify the acknowledgement is unique across the full stock history and review existing journal or reversal links. A null snapshot identifies a movement that still lacks evidence. A closed period identifies a late-event review.

## Posting and accounting dependencies

- The ordinary inventory adjustment uses the authorized inventory movement workflow, a separately confirmed quantity and explicit cost evidence. A priced reduction debits account 5200 and credits inventory. A priced increase reverses those sides under the existing `ADJUSTMENT` policy. For a received purchase, transfer, usage or waste, record or link the original cause's workflow. The handover classification alone does not determine a journal account.
- The inventory movement ID is the accounting source. The projector uses `stock:<movement ID>` to replay the same journal entry. A retry of the stock request must also replay its original movement, since a second movement has its own journal source key. A later physical correction is a new, authorized movement. A journal reversal creates a mirror entry and preserves the original journal and movement.
- An earlier waste or shortage can already explain the discrepancy. The comparison nets movements between the two recorded ledger cursors. Investigation must also consider movements outside that interval before any adjustment. Use the current ledger and physical stock to establish the residual discrepancy.
- The stock subledger reconciles using the movement's stored total cost. Historical diagnostic posting values the journal from count evidence while leaving that stored amount null. For the four test movements, the resulting change to `ledger value − GL inventory` is +EGP 143.24 and the movement rows still count as uncosted. This affects the inventory period-close check. A production decision needs an approved reconciliation treatment and a policy for closed-period late events.
- The application has no HR role or payroll computation. Stock handover review is report and audit information. Existing report permissions are the boundary for sharing it. A dedicated HR audience requires a separate decision on access.

## Verification cases

The corrective tests exercise ordinary P&L sync with the historical hold, opt-in open-period diagnostics, the P&L line and inventory subledger, and a repeated reversal. The closed-period test exercises the same diagnostics on a closed fixture and checks for a late-event issue, zero new journal entries and unchanged P&L. See `tests/count-variance-books.test.ts` and the R1 status entry for execution results.
