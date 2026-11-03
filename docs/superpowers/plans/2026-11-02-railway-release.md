# NEXT CUP production release

The owner requested GitHub publication and deployment to the existing Railway app, preserving its menu, dining tables and business data. They confirmed no active orders or unsaved forms and authorized deployment when checks pass.

Target: `moha312m/cafe-operations-system-3`, Railway project `earnest-dream`, production app `cheerful-grace`. Current deployed/main commit: `5314becf8a26385c2ada7e2993293e7188904142`. Candidate starts at integrated commit `7c4e1ae936dc3f508778c9a55626da1f79224450` and adds the 43 workspace paths from the retained changed-file manifest. The older integration adds 34 migration files beyond current main; the workspace itself adds none.

- [x] Identify the existing GitHub source, running app, database service, domain and untouched persistent volume.
- [ ] Verify a current production backup, applied migration history and baseline menu/table/data counts through authorized Railway access.
- [ ] Curate source only; exclude private configuration, fixtures, build output and owner-local files. Run focused tests/lint and a clean isolated production build.
- [ ] Publish the candidate branch to GitHub, preserving main until all production gates pass.
- [ ] Configure the existing app for a database healthcheck, deployment overlap/draining and production webpack build, retaining its database and authentication variables. Do not create a replacement database, seed, reset, overwrite data or enable financial cutover.
- [ ] Release the verified candidate, apply only reviewed pending additive migrations if required, verify the deployed commit, preserved business records and phone/PC routes.
- [ ] Record the exact deployment and rollback path and provide the single HTTPS café URL and ground-test steps.

The connected Railway OAuth tool exposes variable names, not credentials, and offers no backup/SQL tools. Dashboard sign-in was requested for those checks. Local native GitHub authentication works with network access. The connector remains preferred for supported Railway reads/settings; native Git is needed to publish existing local commit history.

The current owner app on local port 3110 and local PostgreSQL5433 remain separate from this cloud release. Keep both running. Do not copy synthetic disposable fixtures or local databases to Railway. Keep Railway AUTH_SECRET, DATABASE_URL, persistent volume and public hostname stable. Retain the old deployment for application rollback; a database restore is a separate recovery action and must never silently erase new orders.

Status: PREPARING. Production deployment has not been triggered.
