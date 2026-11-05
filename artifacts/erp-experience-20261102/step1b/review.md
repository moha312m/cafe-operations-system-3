# Step 1B static code review

Reviewed the uncommitted scoped source diff against HEAD `0513bcd1693b74c011d208df1b0383b18a4c5457`, the explicit Step 1B brief and STEP-1B-PLAN. Static review only: no tests, server, browser, database or mutation actions were performed.

## Findings

1. **P1 — Current-table isolation is incomplete in the POS invoice/collection path.** `src/components/pos/order-type-selector.tsx:237-243` keeps the same `TableInvoices` instance when `branchId` or selected table changes. Its existing `src/components/pos/table-invoices.tsx:111-137` request neither clears/keys its previous summary nor cancels/ignores superseded responses. Selecting B while A loads permits a late A response to replace B's invoices and summary under the current B selection; collection/close actions use that stale `summary.id` (`:171`, `:192`). This is a pre-existing path left outside the newly added protection, but it directly violates the brief's current-query read requirement and can target the wrong table. Apply current branch/table identity guarding, opt-in GET deadline/cancellation and an explicit retry/error state; keep financial POST body/key semantics intact.

2. **P2 — Existing-order collection can still remain pending indefinitely.** `src/components/pos/collect-payment-panel.tsx:99-118` calls collect-info without the new opt-in deadline or cancellation. A hung read leaves the collection dialog permanently at its loading message; a failed read has no retry control. Phone lookup at `:129-138` also accepts obsolete responses. The parent now protects table-session resolution in the POS page, but this actual collection target read remains unbounded. Extend read protection to this path with current order identity and usable retry, preserving all write/recovery behavior.

These are scoped acceptance gaps in existing child components, not claimed newly introduced regressions. No confirmed new mutation-body/key regression was found in the reviewed `client.ts` GET-only wrapper, Treasury money commands or Expense money-intent paths. AppShell identity remounting and query/identity gating in the new helper prevent retained results being displayed under a changed user scope in the reviewed callers.

## Limits

Rendered sizing, focus/return focus, clipping, performance and populated journeys require the parent agent's runtime/browser checks. New tests were read, not executed. The new deadline tests cover transport/body timeout, abort and unchanged write options; they do not exercise React hook identity/query transitions.

Status: review complete; the two POS read acceptance gaps remain open for implementation or explicit disposition. Owner visual acceptance remains PENDING.
