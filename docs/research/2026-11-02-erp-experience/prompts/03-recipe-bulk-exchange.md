# Step 3/5 — Bulk recipe export, external editing and safe import

Recommended Codex model: GPT-6.1 Sol. Thinking: High.
Roadmap: inspect current exchange → simplify workbook and entry points → strengthen preview/conflicts → verify round trip → hand off.

Implement STEP 3 ONLY. Continue the isolated feature worktree/branch and shared UI from Steps1–2. Read C:/Dev/cafe-operations-system-3/docs/research/2026-11-02-erp-experience/PLAN.ar.md and both prior STEP-N-HANDOFF.md files. This message authorizes scoped local changes, focused tests and explicit local commits; routine choices are delegated.

## Boundaries

Keep the real ERP on3110 and original database5433 running and unchanged. No real recipe import, stock write, historical repricing, .env edit, PostgreSQL control, package install/upgrade, schema migration, push, main merge or deployment. Use only the task's positively verified disposable target and owned preview server; prove server/database correspondence and preserve retained evidence. If unavailable, finish independent pure/static work and report runtime limits. Read relevant installed Next.js guides.

Do not rebuild the existing exchange or repeat prior integration/research. Inspect:
- src/app/(app)/recipe-review/page.tsx
- src/components/recipe-import/recipe-exchange.tsx
- src/lib/recipe-file.ts
- src/lib/recipe-import.ts
- src/lib/recipes.ts and recipe-access.ts
- src/app/api/recipe-import/route.ts
- src/app/api/recipe-import/preview/route.ts
- src/app/api/recipe-import/export/route.ts
- Existing recipe review/verification routes and Recipe/RecipeItem models.

Existing behavior includes XLSX/CSV decoding, XLSX export/template/reference sheets, a1000-row limit, replace/new-only modes, signed preview tokens and transaction/concurrency guards. Preserve and improve it.

Proposed Prisma additions/enums/relations/indexes: NONE by default. Reuse Product/ProductVariant/AddOn/InventoryItem/Recipe/RecipeItem and current audits. If a durable new operation-receipt contract truly needs schema work, prepare its exact separate proposal without applying it; do not silently weaken retry or conflict protection.

## Required workflow

Select products or export all → edit externally → upload → see errors and before/after changes → explicitly confirm → see result and changed recipes requiring review.

1. Make entry points easy to find from recipe review and relevant product/recipe screens, using Step1 components and existing recipe permissions.
2. Support selected-scope and full export. One row represents one ingredient of a product-default, variant or add-on recipe. Preserve explicit scope and variant inheritance.
3. Make SKU visible in product reference sheets and preserve it as text, including leading zeros. Keep stable IDs and version/fingerprint metadata understandable and protected where useful; names are helper labels, not ambiguous matching keys.
4. Include reference sheets for products/variants, ingredients/branches, add-ons, valid units and concise Arabic instructions. Simplify editable columns without breaking current templates; version any changed file contract and define backward compatibility.
5. Keep explicit replace-included-recipes versus new-only choices. Replacement affects only recipe groups included in the approved file; never delete other recipes because their rows were omitted.
6. Show per-recipe before/after and totals for create, change, unchanged, skip and error. Include row numbers and actionable error text; provide an error export if useful. Any invalid file must not silently partially apply.
7. Preserve the preview-token protection between preview and commit. Assess and close stale-export overwrites using the smallest compatible baseline/version strategy; changing a recipe after export must not be overwritten without a meaningful conflict/confirmation flow.
8. Preserve existing finite numeric validation, quantity precision, waste precision and unit compatibility. No weight/volume conversion without item-specific density, and no guessed package conversions. Reuse existing conversion utilities.
9. Keep1000 rows as the current explicit limit unless a justified, tested bounded change is needed. Reject oversized input clearly. If larger work is split into batches, show partial completion and receipts per batch; do not claim whole-file atomicity across separate transactions.
10. Handle double submission and a lost success response without duplicate recipes or misleading success. Reuse transactional/audit/idempotency facilities where suitable and record actual limitations honestly.

Changing recipes must not change sale prices, stock balances, prior stock consumption or historical financial snapshots. Unchanged recipes retain their existing verification status; changed/new recipes follow the approved review and verification flow. Do not auto-verify imported ingredients or quantities.

Planned addition9 offers optional cost-based price suggestions with editable final prices. Recipe import may later invalidate/refresh those suggestions, but cannot publish prices or replace manual overrides. Its independent preview/selected-publication workflow is outside this Step3 prompt; see 09-optional-cost-based-pricing.md.

## Contracts and transaction requirements

Retain Zod validation on the server, including tenant/branch ownership and active catalog identity. Document any optional workbook metadata or request/response extension before implementation. Revalidate file content and preview state inside the appropriate existing transaction; all business mutations and required audits must succeed or roll back together.

Bound file bytes, rows, columns and field lengths appropriately. Treat formulas, macros and external links as untrusted data; never execute them. Ensure exported identifiers/text cannot become executable spreadsheet formulas.

## Acceptance

Use a real export→edit→preview→import→export round trip on synthetic disposable fixtures. Verify Arabic, SKU0012, variants/default inheritance, add-ons, matching ingredient names in different branches, conflicting identifiers, invalid units/precision, duplicate rows/headers, empty/oversized files and stale export/preview state.

Changing one recipe must preserve all unrelated recipes. Invalid input or injected audit failure must leave no partial recipe effects. Check result/retry behavior, permission denial and unchanged prices/stock/history. Perform browser checks of the actual file-selection and preview controls, not only parser tests.

Finish STEP-3-HANDOFF.md with the workbook/request contract, sample synthetic workflow, tests, source changes, limitations and actual preview URL. Stop before Step4.

Final status: COMPLETE / PARTIALLY COMPLETE / BLOCKED / NEEDS OWNER DECISION.
