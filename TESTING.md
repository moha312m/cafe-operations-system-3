# Running the tests

Automated tests run against a **dedicated disposable database**. They never
touch the database your dev server uses, and they are not able to: the harness
refuses to start unless it can prove otherwise.

## Why

These are integration tests. They create cafés, take orders, collect payments
and sign users in — against a real Postgres, because a cash-custody invariant
is only meaningful if the database agrees with it.

For a long time that database was whichever one `.env` named, which in
practice was the developer's own — the one holding real café data. `npm test`
ran `node --env-file-if-exists=.env …`, `.env` carries `DATABASE_URL`, and
`new PrismaClient()` reads it. One full run left **552 audit rows** in the
real café's records, moved `lastLoginAt` on its staff accounts, and drifted
`updatedAt` on Branch and CafeSettings. Nothing was corrupted and nothing was
deleted; the writes simply happened in the wrong place.

Two separate invariants now hold:

| | |
| --- | --- |
| **TOOLING-004** | no cleanup helper may DELETE a non-test café |
| **TOOLING-005/006** | no automated test may WRITE to a non-test database |

## The layout

```
  your work                          automated tests
  ─────────────────────              ─────────────────────
  dev server   :3000                 test server   :3100
  database     :5433/postgres        database      :5434/cafe_ops_test
                                                   + disposable marker
```

Two separate PostgreSQL **clusters**, on different ports, with different data
directories. Not two schemas, not two café ids — the isolation is at the
process boundary, so a misconfiguration cannot quietly cross it.

## Commands

```bash
npm run testdb:up
```
Creates the disposable cluster (first run), starts it on **5434**, creates
`cafe_ops_test`, applies migrations, stamps the marker, and seeds the demo
café and demo accounts. Safe to re-run — every step is idempotent.

```bash
npm run testserver
```
Starts the app on **3100** against the test database. Leave it running. Your
own `npm run dev` on :3000 is unaffected and keeps using your database.

```bash
npm test
```
Verifies the whole environment, then runs the suite. Pass paths to narrow it:
`npm test tests/stock-001-movement-precision.test.ts`.

```bash
npm run testdb:status     # where is it, is it running, what URL
npm run testdb:down       # stop the cluster, keep the data
npm run testdb:destroy    # delete the cluster entirely
```

## What `npm test` checks before running anything

1. **The URL is a test URL.** The database must be named `cafe_ops_test`
   (an optional `_suffix` is allowed). `postgres` is refused by name.
2. **The database says it is disposable.** It must contain the
   `_disposable_test_database` marker row. A name is a heuristic —
   `cafe_ops_test` typed against port 5433 would look just as convincing. A
   marker can only exist in a database somebody provisioned as throwaway, so
   it is positive proof rather than trust.
3. **The server reads the same database.** The runner writes a uniquely-named
   café into the test database and asks the server on :3100 to render its
   public menu. If the server cannot see it, the run stops with `SPLIT BRAIN`
   rather than creating fixtures in one database and exercising another.

Any of these failing stops the run with a message saying what to do. A typo
fails **closed**.

`npm test` does not read `.env` at all. It supplies `DATABASE_URL` to the test
process itself, so there is no `.env` editing back and forth and no way to
inherit your own database by accident.

## Verifying which database a run used

```bash
npm run testdb:status
```

and from inside any suite:

```
tests/tooling-006-isolation-boundary.test.ts
```

which opens a second connection to the database on :5433 and asserts that
audit rows, login timestamps, orders, payments and shifts created by a real
HTTP test appear **only** in the test database. It is not mocked — the
original failure was a correct function call against the wrong database, and
only two live connections can show the difference.

## Troubleshooting

**`Refusing to run automated tests against database "postgres"`**
The guard working. You are pointed at your own database — run `npm test`
rather than `node --test` directly.

**`carries no _disposable_test_database marker`**
The database was not provisioned by `testdb:up`, or was reset. Re-run
`npm run testdb:up`.

**`SPLIT BRAIN: the test server is not reading the test database`**
The server on :3100 was started with the wrong `DATABASE_URL` — most likely a
plain `npm run dev`. Restart it with `npm run testserver`.

**`The disposable test PostgreSQL cluster is not running`**
`npm run testdb:up`.

## Where things live

| | |
| --- | --- |
| Test cluster data | `C:\Dev\_nextcup_test_postgres\pgdata` |
| Test cluster log | `C:\Dev\_nextcup_test_postgres\pg.log` |
| PostgreSQL binaries | `C:\Dev\_nextcup_postgres\pg17\bin` (shared) |

The test cluster is disposable by design. If it misbehaves,
`npm run testdb:destroy && npm run testdb:up` rebuilds it from nothing in
about a minute, and no real data is involved at any point.
