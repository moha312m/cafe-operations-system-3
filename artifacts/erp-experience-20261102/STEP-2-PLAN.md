# Step 2A–2C implementation plan

Goal: Preserve Step1B and deliver the requested invoice navigation and six accurate read-only reports, responsive UI and snapshot outputs.
Architecture: Existing reporting/recognition/shift/window/Decimal sources; no schema or financial policy change. One exact pure metric core and bounded read-only server loader, shared typed presentation, canonical permission-aware navigation. Earlier delegated backend attempts produced no source; implementation continued directly, followed by independent source review.
Spec: User attachment aa4ccc8b-b6e2-44be-a3ae-cf36d7539467/Pasted text.txt and PLAN.ar.md, SALES-REPORTS-REFERENCE.ar.md, prompts/02-sku-and-shift-reports.md in original docs.
Worktree: nextcup-workspace-redesign/cafe-operations-system-3; branch codex/nextcup-workspace-redesign-20261102; baseline e9f55c7.

- [x] Metric/query/response contracts and exact invariant tests recorded; handoff captures the implemented contract without claiming earlier runtime acceptance.
- [x] Product/Purchase pair: stable IDs, invariant denominator, exact reconciliation, no fabricated COGS.
- [x] Payment/Staff pair: real paid legs and role-specific event references, unknown identity retained.
- [x] Shift/Table pair: direct shift/session identity, no join multiplication, provisional/unknown counts.
- [x] Shared responsive reports, allowlisted filters and URL state, columns, snapshots/page/full exports, A4.
- [x] Canonical Sales/Reports navigation and enhanced invoice source/sort/customer/status/detail filters.
- [x] Pure/component/scope-fingerprint/export checks:43 pass. Final lint and production build including TypeScript pass; recorded in handoff.
- [ ] Dedicated runtime, real API/auth isolation, desktop/mobile screenshots and owner visual acceptance:5434 unavailable; no owner fallback.
- [x] Independent source review and scoped local source commit `6bcdefb`; STEP-2-HANDOFF actual results and limitations. Stop before2D/3/7–9; no push/merge/deployment.

Runtime writes require unchanged existing guard proving dedicated disposable identity + correspondence. No ownerSQL, PostgreSQL control, installs, environment changes, schema/migration or new provisioned database. Missing runtime is reported precisely, never replaced by owner data. Owner visual acceptance is separate.
