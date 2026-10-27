# Pilot release runbook (release/pilot-r10-20261027)

Scope: deploy this release to a Railway environment (staging first, production only after the
owner's explicit approval), migrate the database, verify, and roll back or recover if needed.
This file holds no secrets and no café data.

## 1. Topology

- Source: this GitHub repository. `main` auto-deploys the Railway **production** environment, so this
  branch must not be merged until production approval is given.
- App: Railway service built with `npm ci` → `npm run build` (`prisma generate && next build`), started
  with `npm run start` (`next start`, honours `PORT`).
- Database: Railway PostgreSQL in the same project/environment, connected directly (no pooler).
  The app uses transaction-scoped locks only (`FOR UPDATE`, `pg_advisory_xact_lock`, `SET LOCAL`).
- Staging is a separate Railway environment with its own PostgreSQL. Never point staging at the
  production database or the reverse.

## 2. Required variables (per environment)

| Variable | Value |
|---|---|
| `DATABASE_URL` | `${{ Postgres.DATABASE_URL }}` of the same environment |
| `AUTH_SECRET` | 48+ random bytes, different per environment (`openssl rand -base64 48`) |

Uploaded place photos/receipt images are written to `PLACE_MEDIA_ROOT` (default `./.private/place-media`).
Railway's container filesystem is replaced on every deploy, so if these uploads are used in the pilot,
attach a Railway volume (e.g. mounted at `/data`) and set `PLACE_MEDIA_ROOT=/data/place-media`; include
that volume in backups. Without a volume, uploaded files are lost at the next deploy (database rows remain).

Do not set `ALLOW_DEMO_SEED`, test flags, `TEST_*`, local database URLs, or AI/WhatsApp keys unless the
owner has approved that integration for that environment. Never run `prisma/seed.ts` on production
(it refuses `NODE_ENV=production`; keep it that way).

## 3. Deploy steps

1. Settings → Deploy → **Pre-deploy command**: `npx prisma migrate deploy`
   (applies only pending migrations; fails the deploy instead of starting a half-migrated app).
2. Settings → Deploy → **Healthcheck path**: `/api/health` (200 = app up and database reachable,
   503 = database unreachable; returns no business data).
3. Deploy the reviewed commit (staging: this branch; production: `main` after approval and merge).
4. Verify: `/api/health` 200 with the expected commit; login page 200; an authorized user can open the
   dashboard; `npx prisma migrate status` reports no pending/failed migrations.

## 4. Migrations in this release

Production's current schema is unknown to the release author (no Railway access). Before the production
deploy, read its `_prisma_migrations` table and compare with `prisma/migrations/`:
- Every migration already applied in production must exist here with the same name.
- Pending ones are applied in name order by `migrate deploy`.
- If production holds a migration not present here, STOP: do not deploy.

`20261011210000_finished_goods_sales` sorts before the seven 2026-10-24/25 migrations. A database that
already has the 2026-10-24/25 migrations but not this one (the R7/R9 local clone lineage) receives it out
of order; that path was rehearsed separately (see the release evidence) and is not a production path.

## 5. Backup and recovery

- Before every production migration: take a Railway PostgreSQL backup (or `pg_dump -Fc`) and record its
  identifier, time and size. A backup is only trusted after a test restore into a separate database.
- Restore target is always a NEW database/environment; compare row counts and key totals, then switch
  `DATABASE_URL` only with explicit approval. Never restore an old backup over newer business data.

## 6. Rollback / forward recovery

- App-only problem, no schema change applied: redeploy the previous successful deployment in Railway.
- After this release's migrations have run, the previous app version is NOT proven compatible with the new
  schema. Prefer forward recovery: fix and redeploy. Restoring the pre-deploy backup discards every sale,
  payment and stock movement since the backup, so it needs the owner's explicit decision and a
  reconciliation of what would be lost.

## 7. Health and logs

- `/api/health` for liveness/database; Railway deploy logs for build and migration output.
- Server errors are logged with the route; user-facing messages never include stack traces or secrets.
