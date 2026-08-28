// TOOLING-005 — no automated test write may reach a non-test database.
//
// TOOLING-004 established that no cleanup helper may delete a non-test CAFÉ.
// That invariant held, and it was not enough. A full `npm test` still wrote
// into the owner's real database: 552 AuditLog rows tagged to the owner café,
// `lastLoginAt` moved on the owner's staff accounts, `updatedAt` drift on
// Branch and CafeSettings. Nothing deleted a café; everything simply happened
// in the wrong database.
//
// The two invariants are different and both must hold:
//
//   TOOLING-004  no cleanup may DELETE a non-test café
//   TOOLING-005  no test may WRITE to a non-test database
//
// The root cause was a single line. `npm test` ran
// `node --env-file-if-exists=.env …`, `.env` carries the owner's
// DATABASE_URL, and `new PrismaClient()` reads it. Every fixture, every login
// and every audit row followed from that one fact.
//
// So the guard refuses to trust the environment. It requires four independent
// things to be true, and a typo in any of them fails CLOSED:
//
//   1. we are inside the test runner            (NODE_TEST_CONTEXT)
//   2. we are not in production                 (NODE_ENV)
//   3. the database NAME matches the approved test convention
//   4. the database itself carries a marker somebody deliberately created
//
// The fourth is the one that matters. A name is a heuristic — it can be
// typed onto the wrong server. A marker row can only exist in a database that
// was provisioned as disposable, so it is positive proof rather than trust.
//
// These cases are pure: they call the guard with values, never a live
// connection, so the suite can prove a refusal without any database being
// reachable and without ever pointing anything at the owner's.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  assertTestDatabaseUrl,
  TEST_DB_NAME_PATTERN,
} from "../scripts/test-db.mjs";

const TEST_URL = "postgresql://postgres@127.0.0.1:5434/cafe_ops_test";
const OWNER_URL = "postgresql://postgres:pw@127.0.0.1:5433/postgres";

/** The message a refusal produced, or null if it did not refuse. */
function refusal(
  url: string | undefined,
  env: Record<string, string | undefined> = {}
): string | null {
  try {
    assertTestDatabaseUrl(url, {
      NODE_TEST_CONTEXT: "test",
      NODE_ENV: "test",
      ...env,
    });
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

describe("TOOLING-005 the test-database guard fails closed", () => {
  test("the owner database is refused by name", () => {
    // The exact accident this exists to stop: the harness inheriting the
    // developer's own DATABASE_URL out of .env.
    const msg = refusal(OWNER_URL);
    assert.ok(msg, "a database named `postgres` must never be written to by tests");
    assert.match(msg, /postgres/);
  });

  test("a database whose name is not test-tagged is refused", () => {
    const msg = refusal("postgresql://postgres@127.0.0.1:5434/cafe_ops");
    assert.ok(msg, "only the approved naming convention may be written to");
    assert.match(msg, /cafe_ops_test/);
  });

  test("the approved test database is allowed", () => {
    assert.equal(refusal(TEST_URL), null);
  });

  test("an unset DATABASE_URL refuses rather than defaulting", () => {
    const msg = refusal(undefined);
    assert.ok(msg, "absence must not fall back to anything");
    assert.match(msg, /DATABASE_URL/);
  });

  test("an unparseable URL refuses", () => {
    const msg = refusal("not-a-url");
    assert.ok(msg);
    assert.match(msg, /connection URL/i);
  });

  test("outside the test runner it refuses even a correct URL", () => {
    // NODE_TEST_CONTEXT is set by `node --test` itself, so this is the
    // runner's own signal rather than a flag someone has to remember. Its
    // absence means an ad-hoc script imported the helpers, and such a script
    // gets no write power from them.
    const msg = refusal(TEST_URL, { NODE_TEST_CONTEXT: undefined });
    assert.ok(msg, "a stray script must not acquire test-fixture powers");
    assert.match(msg, /NODE_TEST_CONTEXT/);
  });

  test("NODE_ENV=production refuses even a correctly named test database", () => {
    const msg = refusal(TEST_URL, { NODE_ENV: "production" });
    assert.ok(msg, "production is never a place to run destructive fixtures");
    assert.match(msg, /production/i);
  });

  test("the refusal names the database it refused, so a typo is diagnosable", () => {
    const msg = refusal("postgresql://postgres@127.0.0.1:5433/cafe_ops_prod");
    assert.ok(msg);
    assert.match(msg, /cafe_ops_prod/, "the message must show what was actually connected to");
  });

  test("the approved pattern accepts a suffixed test database and nothing looser", () => {
    // Suffixes are allowed so parallel or per-branch test databases remain
    // possible; the prefix is what carries the meaning.
    assert.ok(TEST_DB_NAME_PATTERN.test("cafe_ops_test"));
    assert.ok(TEST_DB_NAME_PATTERN.test("cafe_ops_test_2"));
    assert.ok(!TEST_DB_NAME_PATTERN.test("postgres"));
    assert.ok(!TEST_DB_NAME_PATTERN.test("cafe_ops"));
    assert.ok(!TEST_DB_NAME_PATTERN.test("test_cafe_ops"));
    assert.ok(!TEST_DB_NAME_PATTERN.test("cafe_ops_testing_prod"), "no loose containment");
  });
});
