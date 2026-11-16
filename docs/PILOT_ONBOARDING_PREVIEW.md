# Pilot onboarding preview
Use PILOT_ONBOARDING_TEMPLATE.json as a blank collection template. Null/empty
values mean UNKNOWN, never zero, a default credential, or permission to import.
This template is not an executable universal importer.

## Validate and show before any apply
1. Confirm exact target cafe/branch and whether real data already exists. Resolve
   names uniquely within that tenant (the native importers identify a product by
   category + product name, add-ons/variants by name, ingredients by inventory item
   name or id). Reject duplicates, unknown references, inactive/foreign branches,
   destructive replacements and missing required fields. Cafe inventory enforcement
   must be STRICT for the pilot (the schema default for a new cafe; confirm it through
   /api/cafe/inventory-policy).
   Branch reporting hours (`reportingHours`) are an append-only setting that requires a
   FUTURE effective date in the branch's timezone; until one takes effect, reports use
   the calendar day. Set it at least a day before the first shift, not on the day.
2. Staff: supported role and same-branch assignment, explicit grants/denials,
   discount permission AND numeric limit. Never infer privileged roles. Credentials
   are provisioned privately; no passwords, default accounts or secret fields in
   this file or the public repository.
3. Menu/prices: the native menu import requires a product price greater than zero;
   cost, variant and add-on prices are nonnegative; all money has at most 2 decimals.
   Rows with the same category + product name form one product, and each row may add a
   variant (name AND price) or an add-on (name AND price). The import does not set a
   stock mode or SKU: products stay RECIPE (the default) and finished-goods sales stay
   disabled. Prices are authoritative catalog inputs, never copied from a test bill.
4. Every sellable product/variant AND add-on needs a complete recipe. Ingredients must
   already exist as inventory items (create them first, with no opening quantity), so
   resolve ingredient units/branch, positive quantities (up to 3 decimals), waste 0-100,
   duplicate ingredients and valid conversions against them. STRICT policy remains required.
   Human review/verification follows recipe imports that clear prior confirmation.
5. Opening quantities/cash and supplier balances require real counted/documented
   values, identity and date. Blank does not become zero. Menu/recipe import does
   not post opening stock, money or supplier transactions. Enter those separately
   through supported audited workflows after the owner's approved preview.
6. Handover: FULL or SELECTED with explicit selected items including all required
   critical items; empty SELECTED is a close blocker. Show intended count scope
   without expected quantities to staff. Set the active owner refund approver
   (mode OWNER_REQUEST, OWNER_PASSCODE or EITHER) and verify drawer custody before
   operating refunds.

Supported order of work (each step needs its own approval and readback): cafe/owner ->
branch reporting hours -> staff and permissions -> inventory items (no quantity) ->
menu preview/import -> recipe preview/import and human verification -> owner approval
settings -> audited purchases/counts for counted opening stock -> opening cash and
handover scope -> first supervised shift.

Preview output design: version/hash, exact target, each row's CREATE/UPDATE/SKIP/
ERROR, before/after fields, validation reasons and cross-reference resolutions.
Zero writes during preview. Apply must revalidate tenant/permissions/catalog
versions and reject a changed or expired preview; require an explicit approved
version and idempotency key. Show counts and financial/stock impact separately.
Do not invent a universal apply endpoint: the current app implements native menu
and recipe previews; other sections need reviewed admin actions.

## Existing supported routes
- Existing legitimate SUPER_ADMIN -> POST /api/cafes creates cafe, main branch and
  owner atomically (platform.manage). There is no unattended production bootstrap.
  If no legitimate SUPER_ADMIN exists, stop for a reviewed one-off bootstrap design;
  do not run the demo seed.
- Menu: POST /api/menu-import/preview; apply only after approved validated rows.
- Recipes: POST /api/recipe-import/preview, then /api/recipe-import with its bound,
  expiring previewToken. This does not seed stock or prices.
- Configure owner approvals via /api/cafe/owner-action-settings with the active
  owner's current password, entered privately. No credential belongs in this template.

R11 locally exercised missing add-on fail-closed, valid add-on preview/import and
exact base/add-on deduction. Full production onboarding remains unexecuted and
requires the owner's facts and values.
