# Cafe Ops — multi-tenant cafe & restaurant operations SaaS

MVP built with **Next.js 16 (App Router) · TypeScript · PostgreSQL · Prisma 6 · Tailwind CSS 4 · shadcn/ui (Base UI)**.

## Running locally

```bash
npm install
# .env needs DATABASE_URL and AUTH_SECRET (see .env in repo)
npx prisma migrate dev
npx prisma db seed
npm run dev
```

### Demo accounts (from the seed)

| Role | Email | Password |
|---|---|---|
| Super Admin | admin@cafeops.dev | admin1234 |
| Cafe Owner | owner@demo.com | owner1234 |
| Branch Manager (Downtown) | manager@demo.com | manager123 |
| Cashier (Downtown) | cashier@demo.com | cashier123 |
| Kitchen/Barista (Downtown) | kitchen@demo.com | kitchen123 |

## Multi-tenancy model

Shared database, **row-level isolation by `cafeId`**:

- Every tenant-owned table (`Branch`, `User`, `MenuCategory`, `Product`, `AddOn`, `Order`, `Payment`, `InventoryItem`, `AuditLog`) carries a `cafeId` column.
- The API layer never trusts a client-supplied cafe id for tenant users: `resolveCafeId()` in [src/lib/api.ts](src/lib/api.ts) pins every request to the session's `cafeId`. Only `SUPER_ADMIN` may name a cafe explicitly.
- Object-level checks re-verify ownership on every read/update of a record fetched by id (order, product, branch, user…), so cross-tenant access by guessed id returns 403.
- Branch-pinned staff (cashier / kitchen / inventory / branch manager) are additionally confined to their `branchId` via `resolveBranchId()`.

## Roles & permissions

Defined in [src/lib/permissions.ts](src/lib/permissions.ts) as a role → permission matrix that both the API guards and the UI nav consume.

| Permission | SUPER_ADMIN | CAFE_OWNER | BRANCH_MANAGER | CASHIER | KITCHEN | INVENTORY_MANAGER |
|---|---|---|---|---|---|---|
| platform:manage | ✅ | — | — | — | — | — |
| cafe:manage | ✅ | ✅ | — | — | — | — |
| branches:manage | ✅ | ✅ | ✅ (own branch) | — | — | — |
| users:manage | ✅ | ✅ | ✅ (own branch, lower roles) | — | — | — |
| menu:manage | ✅ | ✅ | — | — | — | — |
| menu:read | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| orders:create | ✅ | ✅ | ✅ | ✅ | — | — |
| orders:read / update-status | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| orders:cancel | ✅ | ✅ | ✅ | — | — | — |
| payments:create / read | ✅ | ✅ | ✅ | ✅ | — | — |
| dashboard:read / reports:read | ✅ | ✅ | ✅ | — | — | — |
| inventory:manage / read | ✅ | ✅ | ✅ | — | — | ✅ |
| audit:read | ✅ | ✅ | ✅ | — | — | — |

Privilege escalation is blocked by `MANAGEABLE_ROLES` (e.g. a branch manager can only create cashier/kitchen/inventory accounts).

## Pages

| Route | Purpose | Who sees it |
|---|---|---|
| `/login` | Sign in | public |
| `/dashboard` | Today's KPIs, 7-day revenue chart, top products, branch filter | owner, manager |
| `/pos` | POS order screen: category tabs, product grid, variant/add-on picker, cart, discount, payment | cashier, manager, owner |
| `/orders` | Live order board (Pending → Preparing → Ready), take payment, cancel, complete; polls every 5 s | kitchen, cashier, manager, owner |
| `/menu` | Categories, products (variants & add-ons), add-ons management | owner |
| `/branches` | Branch CRUD | owner, manager |
| `/staff` | Staff accounts, role & branch assignment, enable/disable | owner, manager |
| `/reports` | Daily sales report: totals, payment-method / branch / item breakdowns, date picker | owner, manager |
| `/audit` | Audit trail viewer | owner, manager, super admin |
| `/admin/cafes` | Tenant onboarding (cafe + owner + main branch), suspend/reactivate | super admin |

Unauthenticated visitors are redirected to `/login` by [src/proxy.ts](src/proxy.ts) (Next 16's replacement for `middleware.ts`).

## API routes

All under `src/app/api/`, JSON, session-cookie auth (12 h JWT via `jose`), every handler guarded by `requirePermission()`:

- `POST /api/auth/login` · `POST /api/auth/logout` · `GET /api/auth/me`
- `GET|POST /api/cafes` · `GET|PATCH /api/cafes/:id` (super admin / owner)
- `GET|POST /api/branches` · `PATCH /api/branches/:id`
- `GET|POST /api/users` · `PATCH /api/users/:id`
- `GET|POST /api/categories` · `PATCH|DELETE /api/categories/:id`
- `GET|POST /api/products` · `PATCH|DELETE /api/products/:id` (variants & add-ons inline)
- `GET|POST /api/addons`
- `GET|POST /api/orders` · `GET /api/orders/:id` · `PATCH /api/orders/:id/status`
- `POST /api/payments`
- `GET /api/dashboard` · `GET /api/reports/daily?date=YYYY-MM-DD&branchId=`
- `GET /api/audit`

### Domain rules enforced server-side

- **Order pricing is computed on the server** from the current menu (base price + variant delta + add-ons, discount capped at subtotal, cafe tax rate applied). The client sends only ids and quantities.
- Order items **snapshot names & prices** at sale time, so later menu edits never rewrite history.
- Order status follows a **state machine**: `PENDING → PREPARING → READY → COMPLETED`, cancellation only before READY, and **completion requires full payment**.
- Payments can't exceed the remaining balance; paying a cancelled order is rejected.
- Every mutation writes an `AuditLog` row (`order.create`, `payment.create`, `product.update`, `auth.login`, …).

## Schema

See [prisma/schema.prisma](prisma/schema.prisma): `Cafe → Branch/User/MenuCategory/Product(+Variant,+AddOn) → Order(+OrderItem+OrderItemAddOn) → Payment`, plus `InventoryItem` (minimal stock surface for the inventory role) and `AuditLog`.

## Post-MVP ideas

- Inventory UI + recipe-based stock depletion on order completion
- Refunds and split payments (schema already supports partial payments & `REFUNDED` status)
- Kitchen display auto-refresh via SSE/websockets instead of polling
- Per-branch menu availability overrides
- CSV export of the daily report
