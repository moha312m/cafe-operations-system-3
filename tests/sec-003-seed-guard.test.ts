// SEC-003 (R-SEC-01/A3) — demo credentials must not be creatable in production.
//
// `prisma/seed.ts` creates a SUPER_ADMIN and six staff logins whose passwords
// are published in this repository. Its only guard was a check for an
// existing admin row — an IDEMPOTENCY check, which stops a second run and
// says nothing about a first run against a real café's database, while the
// deployment guide instructs the operator to run it on the host.
//
// The shape of the fix is borrowed from the test harness, which refuses to
// write to a database that has not proved it is disposable. The seed now
// refuses production outright, and refuses any database that does not name
// itself a demo database.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertSeedAllowed } from "../prisma/seed";
import { TEST_DATABASE_URL } from "../scripts/test-db.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REAL = "postgresql://postgres@10.0.0.9:5432/cafe_ops";

describe("SEC-003 the seed refuses to plant demo credentials", () => {
  test("production is refused outright, whatever the database is called", () => {
    assert.throws(
      () =>
        assertSeedAllowed({
          NODE_ENV: "production",
          DATABASE_URL: "postgresql://postgres@127.0.0.1:5434/cafe_ops_test",
        }),
      /SEED_REFUSED_PRODUCTION/
    );
  });

  test("a database that is not a demo database is refused", () => {
    assert.throws(
      () => assertSeedAllowed({ NODE_ENV: "development", DATABASE_URL: REAL }),
      /SEED_REFUSED_NOT_A_DEMO_DATABASE/
    );
  });

  test("a near-miss name does not slip through", () => {
    // `cafe_ops` is the real one; nothing that merely contains a demo word
    // should pass either.
    for (const name of ["cafe_ops", "cafe_ops_production", "prod_cafe_ops_demo"]) {
      assert.throws(
        () =>
          assertSeedAllowed({
            NODE_ENV: "development",
            DATABASE_URL: `postgresql://postgres@127.0.0.1:5432/${name}`,
          }),
        /SEED_REFUSED_NOT_A_DEMO_DATABASE/,
        `"${name}" must be refused`
      );
    }
  });

  test("a missing or unreadable DATABASE_URL is refused rather than guessed at", () => {
    assert.throws(
      () => assertSeedAllowed({ NODE_ENV: "development" }),
      /SEED_REFUSED_NO_DATABASE_URL/
    );
    assert.throws(
      () => assertSeedAllowed({ NODE_ENV: "development", DATABASE_URL: "not-a-url" }),
      /SEED_REFUSED_UNREADABLE_DATABASE_URL/
    );
  });

  test("the disposable test database is still allowed — the suite depends on it", () => {
    assert.doesNotThrow(() =>
      assertSeedAllowed({ NODE_ENV: "test", DATABASE_URL: TEST_DATABASE_URL })
    );
  });

  test("an operator may override for a non-production environment, by name", () => {
    assert.doesNotThrow(() =>
      assertSeedAllowed({
        NODE_ENV: "development",
        DATABASE_URL: REAL,
        ALLOW_DEMO_SEED: "yes",
      })
    );
    // …but the override cannot reach production.
    assert.throws(
      () =>
        assertSeedAllowed({
          NODE_ENV: "production",
          DATABASE_URL: REAL,
          ALLOW_DEMO_SEED: "yes",
        }),
      /SEED_REFUSED_PRODUCTION/
    );
  });

  test("no refusal quotes a credential", () => {
    try {
      assertSeedAllowed({ NODE_ENV: "development", DATABASE_URL: REAL });
      assert.fail("expected a refusal");
    } catch (e) {
      const message = (e as Error).message;
      for (const secret of ["admin1234", "password123", "owner1234"]) {
        assert.equal(message.includes(secret), false);
      }
    }
  });

  test("the guard runs before anything is read or written", () => {
    const source = readFileSync(path.join(root, "prisma/seed.ts"), "utf8");
    const guard = source.indexOf("assertSeedAllowed()");
    const firstQuery = source.indexOf("await db.");
    assert.ok(guard > 0, "main() must call the guard");
    assert.ok(
      guard < firstQuery,
      "the refusal must come before the first database call"
    );
  });
});
