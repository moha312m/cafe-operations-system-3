# Pilot onboarding preview
Use PILOT_ONBOARDING_TEMPLATE.json as a blank collection template. Null/empty
values mean UNKNOWN, never zero, a default credential, or permission to import.
This template is not an executable universal importer.

## Validate and show before any apply
1. Confirm exact target cafe/branch and whether real data already exists. Resolve
   external keys uniquely within that tenant. Reject duplicates, unknown references,
   inactive/foreign branches, destructive replacements and missing required fields.
2. Staff: supported role and same-branch assignment, explicit grants/denials,
   discount permission AND numeric limit. Never infer privileged roles. Credentials
   are provisioned privately; no passwords, default accounts or secret fields in
   this file or the public repository.
3. Menu/prices: nonnegative exact money (maximum 2 decimals), variant/add-on links
   unique and active. Recipe pilot uses RECIPE products; finished-goods sales stay
   disabled. Prices are authoritative catalog inputs, never copied from a test bill.
4. Every sellable product/variant AND add-on needs a complete recipe. Resolve
   ingredient units/branch, positive quantities (up to 3 decimals), waste 0-100,
   duplicate ingredients and valid conversions. STRICT policy remains required.
   Human review/verification follows recipe imports that clear prior confirmation.
5. Opening quantities/cash and supplier balances require real counted/documented
   values, identity and date. Blank does not become zero. Menu/recipe import does
   not post opening stock, money or supplier transactions. Enter those separately
   through supported audited workflows after the owner's approved preview.
6. Handover: FULL or SELECTED with explicit selected items including all required
   critical items; empty SELECTED is a close blocker. Show intended count scope
   without expected quantities to staff. Set the active owner refund approver and
   verify drawer custody before operating refunds.

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
