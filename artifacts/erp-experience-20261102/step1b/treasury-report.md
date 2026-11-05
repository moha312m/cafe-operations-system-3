# Step 1B Treasury correction

Changed files: `src/components/treasury/treasury-workspace.tsx`, `treasury-client.tsx`, `treasury-details.tsx`; new `tests/experience-step1b-treasury.test.tsx`.

Implemented Accounts/Transfers peer views with #accounts/#transfers deep links and arrow/Home/End keyboard navigation. The active view has a concise search/branch/status toolbar, optional advanced filters, active filter chips, clear action, real server count and pagination. Account register shows name/code/type/branch/status and unknown or recorded balance with coverage caveat. Transfer register shows source/destination/amount/channel/reference/status/date/detail; drafts explicitly do not move money. Account/transfer dialogs retain existing input contracts, pending recovery, failed values and financial safeguards.

useTreasuryData now opts into a 20-second read deadline, aborts superseded/unmounted GETs, ignores late results and immediately gates inaccessible data. Same-query refresh retains allowed results while pending; a failed read removes results and offers retry. Inactive transfer view does not fetch. Transfer-account lookup also uses bounded cancellation. Mutation commands and idempotency/pending logic are unchanged.

Details use the shared full-width workspace language, coverage warnings, explicit retry and correct list-return hash.

Verification: new register tests initially failed for absent components and then passed 3/3. Combined focused `node --import tsx --test tests/experience-step1b-treasury.test.tsx tests/treasury-002-intent.test.ts tests/workspace-002-treasury-filters.test.ts` passed 13/13 with zero skipped. Whitespace check clean except normal Git LF/CRLF notices. Parent requested stopping the duplicate full typecheck so one combined authoritative pass can be run; interrupted, no success claim. Final focused lint result is reported to parent separately. No browser, server, database, fixture or commit actions performed by this worker.

Final focused ESLint: exit 0, no diagnostics after correcting static tab IDs from a ref to ordinary render values. No source edits remain pending from this worker. Parent owns browser acceptance and combined TypeScript checks.
