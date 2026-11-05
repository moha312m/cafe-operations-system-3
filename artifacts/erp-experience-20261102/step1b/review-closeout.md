# Step 1B closeout static re-review

Scope: the two earlier POS read findings, the shared read-abort side-effect guard and the final Sales return-focus fix. Source inspection only; no tests, typecheck, process, browser or database actions were performed by this reviewer.

## Result

No remaining actionable important regression found in the reviewed fixes.

- **Earlier P1 closed in source:** `OrderTypeSelector` keys `TableInvoices` by current branch/table. Table invoice reads now abort superseded/unmounted requests, use the 20-second opt-in GET deadline, check cancellation before applying results, and expose a loading/error/retry state. Late previous-table results cannot populate the current keyed instance. Customer settlement lookup also cancels obsolete reads.
- **Earlier P2 closed in source:** POS keys `CollectPaymentPanel` by order. Its collect-info read now has a bounded deadline, cancellation on replacement/unmount and error retry; phone lookup cancels obsolete requests. The inspected payment and close mutation bodies/keys remain unchanged.
- **Shared client:** post-fetch and post-body abort checks prevent cancelled GET continuations from triggering stale 401 navigation or returning late data. Mutation calls receive no read signal and retain the existing pending-key path.
- **Sales focus:** the activating element is captured before `run()` disables the register controls, retained in a ref and passed to `DialogContent.finalFocus`. The change does not alter invoice loading, mutation identity or dialog values.

The original `review.md` remains preserved as historical findings. Runtime/focus behavior and final check results are owned by the parent agent's separate verification; this static re-review does not claim to have repeated them. Owner visual acceptance remains PENDING.

Status: COMPLETE for this bounded static re-review.
