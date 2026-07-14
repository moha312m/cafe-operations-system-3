# Deployment Guide — Cafe Ops (Next.js + Prisma + PostgreSQL on Railway)

This app is a Next.js 16 (App Router) project using Prisma with PostgreSQL.
Auth is a signed session cookie via `jose` (there is **no** NextAuth), so the
only auth secret is `AUTH_SECRET`.

---

## 1. Push the project to GitHub

From the project root:

```bash
# if not already a git repo
git init
git add .
git commit -m "Cafe Ops — production ready"

# create an empty repo on GitHub first, then:
git branch -M main
git remote add origin https://github.com/<you>/<repo>.git
git push -u origin main
```

`.gitignore` already excludes `node_modules`, `.next`, `.env*` (real env
files), and `.claude/`. Only `.env.example` is committed — never a real `.env`.

> Verify no secret is tracked: `git ls-files | grep -E "^\.env$"` should print
> nothing.

---

## 2. Deploy on Railway

1. **New Project → Deploy from GitHub repo** → pick this repo. Railway detects
   Next.js (Nixpacks) automatically.
2. **Add a database:** in the project, **New → Database → PostgreSQL**. This
   creates a `Postgres` service exposing `DATABASE_URL`.
3. **Set variables** on the app service (see §3).
4. **Set the pre-deploy / release command** to run migrations (see §5).
5. Railway builds with `npm install` → `npm run build` and starts with
   `npm run start`. Both are already configured in `package.json`.

Railway sets the `PORT` env var automatically and `next start` respects it —
no extra config needed.

---

## 3. Required Railway variables

Set these on the **app service** → Variables:

| Variable        | Required | Value |
|-----------------|----------|-------|
| `DATABASE_URL`  | ✅ | Reference the Postgres plugin: `${{ Postgres.DATABASE_URL }}` |
| `AUTH_SECRET`   | ✅ | A long random string. Generate: `openssl rand -base64 48` |

- `NODE_ENV` is set to `production` automatically by Railway/Next — don't set it.
- There is **no** `NEXTAUTH_SECRET` / `NEXTAUTH_URL` — this app doesn't use NextAuth.
- If `AUTH_SECRET` is missing in production the app logs a loud warning and falls
  back to an insecure default — **always set it**.

Full list with descriptions is in [`.env.example`](.env.example).

---

## 4. Build & start (already configured)

`package.json` scripts:

| Script            | Command                          | Purpose |
|-------------------|----------------------------------|---------|
| `build`           | `prisma generate && next build`  | Railway build step |
| `start`           | `next start`                     | Railway start step |
| `postinstall`     | `prisma generate`                | ensures the Prisma client exists after install |
| `typecheck`       | `tsc --noEmit`                   | CI / local type checking |
| `lint`            | `eslint`                         | CI / local linting |
| `db:migrate`      | `prisma migrate deploy`          | apply migrations in production |
| `db:seed`         | `tsx prisma/seed.ts`             | seed demo data (one-off) |

`prisma` and `tsx` are in **dependencies** (not devDependencies) so
`migrate deploy` and the seed script work in the deployed environment.

---

## 5. Run migrations (pre-deploy / release command)

Migrations must run against the production DB **before** the new build serves
traffic. On Railway, set the service's **Pre-deploy Command** (Settings →
Deploy) to:

```bash
npx prisma migrate deploy
```

This applies all 13 committed migrations idempotently. It never resets data and
is safe to run on every deploy. If you prefer to run it manually once:

```bash
railway run npx prisma migrate deploy
```

> Do **not** use `prisma migrate dev` or `prisma db push` in production — they
> can drift or reset the schema.

---

## 6. Seed demo data (safely, optional)

The seed is **idempotent-ish**: it bails out if the super-admin user already
exists, so it won't duplicate data. Run it once, manually, after the first
migration — never as part of every deploy:

```bash
railway run npm run db:seed
```

This creates the demo cafe **قهوة المدينة**, its branches, menu, inventory, and
recipes, plus demo logins (owner `owner@qahwa.local` / `password123`, etc.).

**For a real customer**, skip seeding and instead create the first cafe + owner
through the app as a super admin, or write a minimal production seed. Change all
demo passwords before going live.

---

## 7. Post-deploy checklist

- [ ] `AUTH_SECRET` set to a strong random value (not the demo one)
- [ ] `DATABASE_URL` points to the Railway Postgres plugin
- [ ] Pre-deploy command runs `npx prisma migrate deploy`
- [ ] App loads at the Railway URL and `/login` works
- [ ] Demo passwords rotated or demo data not seeded in production
- [ ] Public QR menu opens at `/menu/<cafeSlug>/<branchSlug>` (uses the deploy
      origin automatically — no hardcoded host)

---

## Notes & risks

- **Node version:** pinned to Node 22 via `.nvmrc` and `engines` in
  `package.json`. Railway respects `.nvmrc`.
- **HTTPS:** the session cookie is marked `secure` only when
  `NODE_ENV=production`, so it requires HTTPS — Railway provides this by default.
- **Public QR endpoints** (`/api/qr/[branchId]`) are intentionally unauthenticated
  and safe (menu data only, orders always land in the waiter-approval queue).
  Consider adding rate limiting before heavy public traffic.
- **Connection pooling:** for higher traffic, put the DB behind a pooler
  (Railway PgBouncer / Prisma Accelerate) and point `DATABASE_URL` at it.
