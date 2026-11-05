# Planned addition 9 — Optional cost-based menu pricing with editable final prices

Recommended Codex model: **GPT-6 Astra**. Thinking: **High**.
Roadmap: verify cost and target-price contracts → optional settings and editable suggestions → guarded selected-price publication → POS/QR/variant/branch reconciliation and handoff.

## Owner request — 2026-11-03

Add optional automatic pricing for menu creation/repricing. The owner can enter a SKU's cost directly or use its ingredient/recipe cost, choose a selling-price multiplier such as ×2 or ×3, and keep the resulting price column editable. Example: cost16.25 ×2 proposes32.50; the owner can enter35.00 before publishing. Fractional prices remain valid when deliberately chosen; do not ban them globally.

This is a planned addition, not an instruction to run it merely because the file was saved. Preserve implemented Step1/1B, remaining core Steps2–5 and additions6–8. Explicit later invocation authorizes bounded local code/tests/reviewed local commits in the worktree path and branch named by that invocation or its approved current handoff. Verify HEAD and actual work; without a named approved target, finish read-only preparation and request it before edits. No automatic execution of other prompts.

Read AGENTS.md, PLAN.ar.md section14, the latest handoff, actual schema and installed Next.js route-handler/form guidance. Inspect src/lib/money.ts, pricing.ts, costing.ts, recipes.ts, product/variant/branch price write paths, menu page, product-cost report, recipe confirmation and branch ingredient resolution. Use current permissions, audit/idempotency and protected transaction patterns. Do not repeat broad ERP research or rebuild Step1/Step3.

No owner-database write, real-menu repricing, PostgreSQL control/provisioning, dependency installation, .env edit, push, merge or deployment is authorized by preparing/invoking this bounded development prompt. Schema application needs an explicitly allowed verified disposable target. Preserve accountant/D7/D8 and existing valuation, posting, receipt, order revision, custody and stock policies. This feature changes selected future menu prices; it does not restate historical COGS, profit, invoices or inventory valuation.

## 1. Product behavior and clear defaults

Add **Settings → التسعير حسب التكلفة**, owner-controlled and OFF by default. Enablement shows pricing controls; it must not reprice the menu itself. Provide ×2, ×3 and a validated custom multiplier, plus optional rounding defaults. Also expose **احسب السعر من التكلفة** in the existing product editor and a bulk **تسعير / إعادة تسعير المنيو** workspace for permitted products/categories and price targets.

The engineering default is calculation → editable review → explicit publication of selected rows. The owner did not request unattended background price changes. Editing an ingredient cost, importing recipes, enabling the feature, opening the report or changing a multiplier may refresh suggestions but must not silently publish prices. If future unattended repricing is requested, design it separately rather than inferring permission here.

Per row show: selection, SKU/product/variant, target branch/global scope, separate reference-cost branch, cost source and status/time, cost per sold unit, multiplier, raw calculated price, optional rounded suggestion, current effective price, **editable final price**, manual-override state and difference. Cost breakdown is available to authorized readers. Keep this usable on mobile, with labeled inputs, decimal entry, keyboard navigation, visible errors and Arabic RTL identity from Step1B.

Changing cost/multiplier/rounding updates an untouched final-price draft. Once the owner edits final price, mark it **تعديل يدوي — محفوظ** and do not overwrite it during refresh, bulk recalculation, ingredient-cost updates, navigation/reload recovery or a new preview. Show the new suggestion alongside the retained manual value. Provide an explicit **استخدم المقترح من جديد** per row and a separately chosen reset for selected manual rows. Do not default-select pinned rows for a later automatic bulk overwrite.

Keep manually edited catalog prices outside this feature protected too: compare against last applied price/fingerprint and require explicit review when another authorized editor changed a target. User-scoped draft recovery must not expose another cafe's costs or auto-publish on restoration. Disabling the feature leaves all published menu prices intact. Manual catalog price editing continues to work under its existing permission even without a usable automatic-cost source.

## 2. Cost sources and exact calculation

Require an explicit cost source per target: **DIRECT** or **RECIPE**. Do not silently replace a missing recipe cost with direct cost, sum the two sources, or reuse one size's cost for another size without an explicit supported inheritance rule.

- DIRECT: reuse Product.costPrice as the product-level direct pricing cost where applicable. Label its scope and origin. A scoped variant/branch direct-cost override may be stored in the proposed rule only when explicit; do not copy it into stock costs or replace the global product cost from a branch row. Saving a pricing estimate is not an inventory revaluation.
- RECIPE: use the effective product/variant recipe, explicit appliesToAllVariants semantics, branch ingredient costs, compatible units and existing waste treatment. The inspected costing path rounds ingredient contributions to2 decimals before summing; preserve the approved rule using shared Decimal math for this new pricing path. Do not activate unused six-decimal valuation helpers or refactor historical financial arithmetic.
- Recipe source scope is independent of price target scope: global product/variant prices require an explicit authorized **reference-cost branch** before calculation. For a branch target use that same branch initially. Never pick the first branch, guess cafe-wide average costs or sum branch costs. Persist sourceBranchId separately from the target branch, display it, and bind it plus ingredient identities/versions to the preview fingerprint. For DIRECT, sourceBranchId is null; any scoped direct override is explicitly entered for the price target.
- Reuse strict completeness/confirmation rules. Missing ingredient costs, invalid/incompatible quantities, stale/unverified recipes, inactive ingredients or ambiguous branch mapping cannot become zero-cost ingredients. A structurally computable unverified recipe may show a clearly labeled draft estimate; it is not an eligible automatic publication source until reviewed under existing rules. Do not auto-verify a recipe as a side effect of pricing.
- Resolve ingredients through the reviewed cafe/branch identity mapping, not unscoped name matching or an arbitrary first match. The inspected configurationFinancials/withBranchIngredientCosts implementation must be checked for tenant scope, ambiguity and transaction-aware reads before reuse; do not treat a display helper as a proven publication boundary.
- FINISHED_GOOD reference costs come from their explicit existing stock binding if offered as a separately labeled supported reference source; do not silently substitute one while the user selected RECIPE or DIRECT. No current purchase price is automatically realized historical COGS.
- Cost and supplier/recipe detail visibility require current cost-read authority in addition to menu/price-write authority. Never leak cost columns in JSON, export or DOM to an unauthorized cashier.

Formula: **rawSuggestedPrice = eligibleUnitCost × multiplier**. ×2 means multiply by2, not “add200%” and not “200% margin”. Do not change tax/service treatment: show the configured existing menu-price basis and apply the multiplier on that basis without adding or removing tax twice. Any conversion needed for a different tax-inclusive/exclusive policy requires an explicit compatible contract; do not infer it.

Use money.ts Decimal and canonical decimal strings for new money inputs/outputs, preserving compatible existing API types. Initial multiplier validation is finite, greater than0 and at most100, supporting up to3 decimal places; money inputs/final prices obey existing currency precision/range. Reject NaN, Infinity, invalid signs, excessive precision and overflow. Cost unavailable/nonpositive produces no automatic suggested price; the existing manual price path remains available.

Rounding is optional: NONE, NEAREST or UP to a positive increment, with common choices1,5,10 in cafe currency. NONE is the initial default; the owner may instead type any valid final price. Define NEAREST ties toward positive infinity for nonnegative prices and UP as the mathematical ceiling to the increment. Calculate using Decimal before the final currency normalization; do not round the raw price before finding its increment multiple.

Examples to verify:16.25 ×2 =32.50; UP to5 =35.00; NEAREST to5 at32.50 =35.00; NONE retains32.50; manual final35.00 remains35.00 after multiplier changes until explicitly reset. Do not force a chosen manual price back onto the rounding increment. Show any below-cost or lower-than-target outcome transparently, preserving existing catalog policy rather than adding an invented financial prohibition.

These are current pricing estimates and proposed menu prices, not realized margin or official P&L. Preserve Step2 historical-cost coverage and Step4 accounting gates.

## 3. Real product, variant and branch targets

Reuse Product.basePrice, ProductVariant.price and ProductBranchPrice.price; do not create a parallel live-price table. Use pricing.ts unitPriceExact as the authoritative effective-price contract for POS, server orders and QR.

In the inspected source, variant.price is absolute and a product branch override shifts every variant by (branchBase − globalBase). Consequently, editing one base price can change effective variant/branch prices the owner did not select. Preview the full affected target set and its old/new effective prices before accepting a change. Show prices as stored-field changes and effective customer-facing changes, not only the target field.

For a product with active variants, global/branch base fields are offset anchors rather than a separately sold SKU. They cannot inherit the first/cheapest variant's recipe cost. Initial automatic proposals target the actual global variants with their own eligible costs; base/branch anchors remain explicitly unsupported for cost-derived proposals unless a separate real cost/target contract exists. A product without variants can use its actual base-SKU cost. Existing manual anchor editing still uses the current price editor and a complete affected-price review.

Only publish a selection whose requested prices can actually be represented by the existing price model and whose full effective impact the owner explicitly accepted. A global base/variant change with hidden consequences, or a branch variant price that would require a different offset for each variant, is a conflict/unsupported scope, not permission to overwrite other sizes/branches. Never silently modify protected/unselected target prices to force a fit.

If independent per-branch variant prices are necessary, prepare that exact central pricing-model extension separately and verify every consumer before enabling it; an arbitrary branch-variant target cannot be smuggled into the current one-offset model. Keep the initial tool functional for supported product/global-variant/branch-base targets with clear capabilities and affected-price preview.

New products may calculate a draft before first save, using normal product validation and a stable local draft identity; an unsaved row cannot call a publication endpoint as an existing product. Editing ingredients in the recipe workflow or Step3 bulk import only invalidates suggestions. Actual prices change only through the reviewed price publication action.

## 4. Proposed persistent settings/rule schema — reference only

Validate against current schema before implementation. These are new proposed definitions, not verified/applied migrations. Reuse current CafeSettings, Product, ProductVariant, Branch, User, IdempotencyKey and AuditLog patterns. Add named reverse relation arrays as appropriate; enforce cafe/branch/product/variant consistency server-side and in suitable constraints. Do not introduce a duplicate ledger or persist private preview/customer data unnecessarily.

```prisma
enum MenuPricingCostSource {
  DIRECT
  RECIPE
}

enum MenuPricingRounding {
  NONE
  NEAREST
  UP
}

enum MenuPricingTarget {
  PRODUCT_BASE
  GLOBAL_VARIANT
  BRANCH_BASE
}

model MenuPricingRule {
  id                          String                @id @default(cuid())
  cafeId                      String
  productId                   String
  variantId                   String?
  branchId                    String?
  sourceBranchId              String?
  target                      MenuPricingTarget
  targetKey                   String                @db.VarChar(256)
  costSource                  MenuPricingCostSource
  directCostOverride          Decimal?              @db.Decimal(12, 2)
  multiplier                  Decimal               @db.Decimal(8, 3)
  roundingMode                MenuPricingRounding   @default(NONE)
  roundingStep                Decimal?              @db.Decimal(10, 2)
  manualOverride              Boolean               @default(false)
  lastAppliedPrice            Decimal?              @db.Decimal(10, 2)
  lastAppliedInputFingerprint String?               @db.VarChar(64)
  revision                    Int                   @default(0)
  updatedById                 String
  createdAt                   DateTime              @default(now())
  updatedAt                   DateTime              @updatedAt
  cafe                        Cafe                  @relation(fields: [cafeId], references: [id], onDelete: Restrict)
  product                     Product               @relation(fields: [productId], references: [id], onDelete: Restrict)
  variant                     ProductVariant?       @relation(fields: [variantId], references: [id], onDelete: Restrict)
  branch                      Branch?               @relation("MenuPricingTargetBranch", fields: [branchId], references: [id], onDelete: Restrict)
  sourceBranch                Branch?               @relation("MenuPricingCostBranch", fields: [sourceBranchId], references: [id], onDelete: Restrict)
  updatedBy                   User                  @relation("MenuPricingRuleActor", fields: [updatedById], references: [id], onDelete: Restrict)

  @@unique([cafeId, targetKey])
  @@index([cafeId, productId])
  @@index([cafeId, branchId, manualOverride])
  @@index([cafeId, sourceBranchId])
}
```

Proposed CafeSettings fields: autoPricingEnabled Boolean defaultfalse; autoPricingDefaultMultiplier Decimal(8,3) default2.000; autoPricingRoundingMode MenuPricingRounding defaultNONE; autoPricingRoundingStep Decimal(10,2) nullable. Settings do not publish prices. Initial settings/rule APIs remain owner-only plus current cost/menu/price authority; do not invent new implicit permissions for cashiers.

Server constructs canonical targetKey from target/product/variant/branch IDs, never trusts a client-supplied key. Add exact SQL CHECK constraints for target shape: PRODUCT_BASE has no variant/branch; GLOBAL_VARIANT requires variant/no branch; BRANCH_BASE requires branch/no variant. Constrain multiplier to greater than0 and at most100, nonnegative optional direct cost, and roundingStep absent for NONE/positive for NEAREST or UP. RECIPE requires sourceBranchId and no directCostOverride; DIRECT requires no sourceBranchId. A branch-target RECIPE source must match its target branch in the initial contract. Scope keys plus constraints prevent nullable-unique duplicates. directCostOverride is an explicitly scoped pricing estimate, not a second product/stock-cost source or an automatic copy of Product.costPrice. Add distinct named Branch back-relations for target and source, and verify both belong to the authorized cafe.

Persist manualOverride and last-applied provenance atomically with the relevant price update. Current externally edited catalog price/revision preconditions still need checking; this model alone does not protect against other catalog editors. Ordinary rule/settings saves require expected revision/concurrency checks and transactional audits. A separate publication receipt model is not proposed: reuse IdempotencyKey and audited results.

## 5. Preview, publication and transaction boundaries

Proposed routes, adapted to conventions: GET/PATCH /api/menu-pricing/settings; POST /api/menu-pricing/preview; POST /api/menu-pricing/apply. Proposed UI may extend the menu workspace with a shared component rather than introduce an unrelated page. Use strict Zod schemas, operation allowlists, bounded selections (initial maximum100 target rows), exact values and safe source/target IDs. Reuse compatible current product input types; do not broadly rewrite old APIs.

Preview is read-only: resolve current actor/tenant/branch, settings/rules, products/variants/branch overrides, eligible costs and all affected effective prices under a coherent read snapshot. Return per-row suggestions/errors, current/final price, dependencies, coverage and a server-authenticated preview token/fingerprint bound to actor/scope/inputs/versions/expiry. Do not mark an estimate eligible just because the browser posted a cost. Validate tamper, expiry and selection identity on apply.

Apply receives selected final prices and their stable intent key; manual final values are intentionally allowed to differ from suggestions and rounding. Revalidate their precision/authority/target and every relevant preview precondition, including costs/recipe verification, product/variant/branch prices, policy, settings/rule revision and active state. Define the acceptance read/lock point and compare against the preview there. A changed dependency before acceptance requires refreshed review; later cost changes generate future suggestions rather than rewriting an accepted publication.

Use the existing protected transaction and current canonical price-update helpers with deterministic locking/optimistic concurrency appropriate to their write paths. Review interactions with existing menu PATCH mutations, not just new-route concurrency. The selected bounded batch, rule/manual-override updates, before/after audit including effective impacts, and replayable idempotency outcome commit atomically. Any conflict rolls back that selected batch with actionable row errors. Unselected invalid/unavailable rows are not silently included or changed.

Same intent key and canonical payload replay the same result after a lost response/reload; changed payload with the same key is refused. Do not publish one row twice, duplicate audit effects or create new keys after an uncertain commit. If a large menu requires multiple batches, show per-batch receipts and partial completion honestly instead of claiming whole-menu atomicity.

Target updates must not delete/recreate unrelated variants, stock bindings or other branch prices through the broad existing product-edit payload. Invalidate current menu caches appropriately and reconcile effective server/POS/QR prices. Existing placed orders retain historical item/charge/cost snapshots; carts/orders follow their existing price/revalidation contract. No automatic amendment of open invoices, payment/refund, stock write or accounting entry.

Under planned shared-LAN addition8, catalog pricing writes must obey the branch/coordinator authority contract. Do not permit the cloud pricing tool to become a second live branch writer. Until that integration exists, do not advertise disconnected publication; prepared suggestions can be drafts, not an accepted shared price change.

## 6. Delivery and meaningful acceptance

**9A:** explicit cost sources and target-impact contract, optional settings, exact pure math and editable draft UX. **9B:** preview and selected publication with persistent manual overrides, idempotency, authorization/concurrency and audit. **9C:** POS/QR/variants/branches, recipe-import interaction, owner visual acceptance and exact supported-scope/coverage handoff. No automatic Step3/4/8 execution, live repricing or deployment.

Required evidence on synthetic verified disposable data only:

1. OFF has no pricing effect; ON alone has none. Cost16.25 ×2 proposes32.50, editable final35.00 publishes35.00; manual35 remains after recomputation/refresh/draft recovery until explicit reset. A different deliberately chosen decimal final remains allowed.
2. DIRECT versus RECIPE, explicit override scope, variants/inheritance and branch ingredient identities produce the right cost. Global pricing with two different branch costs requires and uses the chosen reference branch, not an arbitrary branch/average. Cost-derived pricing for a variant offset anchor is refused unless its own supported cost contract exists. Missing/unverified/inactive/ambiguous ingredients cannot become zero. Recipe quantity unit conversion/waste/per-line rounding agrees with reviewed current rules; invalid precision/overflow fail.
3. Multiplier2/3/custom, NONE/NEAREST/UP and increment/tie boundaries use exact expected values. Final manual price is never forced to the rounded suggestion. Cost/reference estimates are not written as historical inventory/COGS.
4. Existing branch overrides and multiple variants expose their full effective impact. An unsupported independent branch-variant target or an unselected/protected sibling change cannot be silently applied. POS, API order pricing, QR and the published menu agree.
5. Cost/recipe/price/policy changes between preview and apply, two publishers, manual edits outside this tool, expired/tampered preview and double/lost-response retries produce safe conflicts or one committed batch/receipt, never partial hidden repricing.
6. Two cafes, branch-restricted users and cashiers prove read/write/cost isolation on routes, details, exports and direct URLs. Old orders/receipts/revisions/payments/stock/accounting retain exact prior values.
7. Recipe save/import, cost updates, disabling/re-enabling, report opening, navigation and app restart never publish prices by themselves. Test mobile/desktop editing, keyboard, loading/error states, selection preservation and real before/after price preview.

Run targeted pure/authorization/runtime checks plus types/lint/build/browser checks proportionate to shared price-write changes. Do not use owner data or provision/restart databases when a target is unavailable; finish independent work and identify the unverified portion. Handoff includes exact source/target/rounding contracts, price-impact examples, manual-override behavior, schema proposal/application status, data-source gaps, batch receipts, tests, preview and rollback using guarded new edits rather than blind historical reset.

Final status: COMPLETE / PARTIALLY COMPLETE / BLOCKED / NEEDS OWNER DECISION. Distinguish documentation, implementation, disposable verification, owner acceptance, actual menu repricing and deployment.
