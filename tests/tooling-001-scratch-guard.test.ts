// TOOLING-001 — a migration reset that refuses to point at anything real.
//
// This milestone adds eleven migrations. Verifying one means running
// `prisma migrate reset`, which drops every table it can reach. The only
// database configured in this repository is the live local one, and the
// distance between "verify the migration" and "erase the café" is a single
// stale environment variable.
//
// So the reset is not available as a bare command. It is available only
// through a script whose guard must pass four independent checks first, and
// the guard is exported separately from the thing it guards — which is why
// every test below can assert the refusal without any test ever running a
// reset, or even touching the database.
//
// The fourth check (an explicit flag) exists because the first three are
// properties of the environment, and an environment can be wrong without
// anybody noticing. The flag is the one check that requires a person to have
// decided, at the moment of running, that erasure is what they meant.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { assertScratchUrl } from "../scripts/scratch-db.mjs";

const REAL = "postgresql://u:p@localhost:5432/cafe_ops";
const SCRATCH = "postgresql://u:p@localhost:5432/cafe_ops_scratch";
const GO = ["--i-understand-this-erases"];

/** The message a refusal produced, or null if it did not refuse. */
function refusal(
  scratch: string | undefined,
  primary: string | undefined,
  flags: string[]
): string | null {
  try {
    assertScratchUrl(scratch, primary, flags);
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

describe("TOOLING-001 scratch database guard", () => {
  test("an unset SCRATCH_DATABASE_URL refuses", () => {
    const msg = refusal(undefined, REAL, GO);
    assert.ok(msg, "no scratch URL must never fall back to DATABASE_URL");
    assert.match(msg, /SCRATCH_DATABASE_URL/);
  });

  test("a URL whose database is not a scratch database refuses", () => {
    // The exact shape of the accident this prevents: someone copies
    // DATABASE_URL into SCRATCH_DATABASE_URL to "make it work".
    const msg = refusal(REAL, REAL, GO);
    assert.ok(msg, "cafe_ops is the live database and must be refused");
    assert.match(msg, /_scratch/, "the rule that was broken must be stated");
  });

  test("a scratch URL identical to DATABASE_URL refuses", () => {
    // Belt and braces: even if the live database were itself named
    // `..._scratch`, pointing the reset at the configured primary is the
    // one thing this script exists to prevent.
    const same = SCRATCH;
    const msg = refusal(same, same, GO);
    assert.ok(msg, "the scratch target must differ from the primary");
    assert.match(msg, /DATABASE_URL/);
  });

  test("a valid scratch URL without the explicit flag refuses", () => {
    const msg = refusal(SCRATCH, REAL, []);
    assert.ok(msg, "erasure must be stated at the moment of running");
    assert.match(msg, /--i-understand-this-erases/);
  });

  test("a valid scratch URL with the flag returns cleanly", () => {
    assert.equal(
      refusal(SCRATCH, REAL, GO), null,
      "the guard must permit the case it exists to make safe"
    );
    // A URL with query parameters is still a scratch URL — the database name
    // is the path segment, and `?schema=public` is what Prisma appends.
    assert.equal(
      refusal(`${SCRATCH}?schema=public&connection_limit=1`, REAL, GO), null,
      "connection parameters must not defeat the name check"
    );
  });

  test("the refusal names the database it refused, so the operator sees what was wrong", () => {
    const msg = refusal(REAL, undefined, GO);
    assert.ok(msg);
    assert.match(
      msg, /cafe_ops/,
      "a guard that says only 'refused' teaches the operator nothing"
    );
  });
});
