# NEXT CUP update candidate

This candidate consolidates application and test changes on top of the existing main branch. It is a review snapshot, not deployment approval or owner acceptance.

## Included source areas

- Financial transaction locks, idempotent request recovery and exact monetary calculations; payment/refund, serving and stock-consumption controls.
- Staff/branch permissions, session revocation, catalog price authority, order pagination and Cairo business-day reporting.
- Owner-approved cancellations/item voids with audit history, overnight cash and premises/opening receipts, operational/customer displays and historical-sales/recipe-import tooling.
- Viewport-constrained RTL dialogs with reachable actions; shared handover workspace with explicit counts, blind-count protection, review/receipt controls, financial context and persisted completion history.
- Finished-goods/resale source and additive migration source, still disabled by default and not live-accepted.

Publication review fixes exclude retained void rows from product-sales reports, adjust linked customer spending by the exact void delta under the existing lock order, allow completed handover history to open read-only, and restore permission-compatible opening-verification input when ancillary discovery lists are unavailable. Synthetic tests reproduce the original defects and exercise the corrected source paths.

## Verification and prerequisites

Production build, separate TypeScript check, lint (zero errors, 61 warnings), 11 focused synthetic source-path regressions and 52 selected offline checks passed. Synthetic database collaborators do not prove real SQL atomicity, concurrent database behavior or an authenticated browser journey.

The complete current schema/client requires `20261011210000_finished_goods_sales` even with resale OFF. The existing disposable test database lacks its schema. Read-only verification reproduced Prisma `P2022` for `CafeSettings.finishedGoodsSalesEnabled`. No migration was applied. Full integration and browser verification of this candidate remain blocked; older schema-compatible local binaries are not evidence for it.

The full legacy test runner also reads the root `.env` to discover an owner database, and some historical tests choose seeded records. It must not be run against an owner-populated test database without a separately reviewed isolation correction. No such owner or production connection was used in this review.

No independently verified Costa dataset/import execution was established. Generic NEXT CUP import/parser tools exist; private workbook data, historical database contents and local evidence are excluded from publication.

Railway production integration was observed. Confirm connected branch settings and disabled PR previews before pushing or opening a pull request; a draft PR alone is not a deployment guard.

No service qualification, credential access, live migration, deployment, commercial-readiness signoff or owner acceptance is claimed. Windows-service qualification remains paused.
