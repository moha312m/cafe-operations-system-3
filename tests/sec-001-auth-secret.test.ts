// SEC-001 (R-SEC-01/A1) — production must not run on a guessable signing key.
//
// `AUTH_SECRET` signs the session cookie, and `verifySessionToken` trusts the
// payload's role and cafeId wholesale. The module used to resolve the key as
// `process.env.AUTH_SECRET ?? "insecure-dev-secret"` at import time, logging
// an error in production and carrying on — so one missing environment
// variable meant every session was signed with a string published in this
// repository, and anyone could mint a SUPER_ADMIN cookie for any tenant.
//
// The resolver is pure in its `env`, so every refusal is provable here
// without a process, a server, or a database.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveAuthSecret } from "@/lib/auth";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STRONG = "x".repeat(32);

describe("SEC-001 the signing key fails closed in production", () => {
  test("a missing secret is refused", () => {
    assert.throws(
      () => resolveAuthSecret({ NODE_ENV: "production" }),
      /AUTH_SECRET_MISSING/
    );
  });

  test("an empty secret is refused", () => {
    assert.throws(
      () => resolveAuthSecret({ NODE_ENV: "production", AUTH_SECRET: "" }),
      /AUTH_SECRET_MISSING/
    );
  });

  test("the published development default is refused BY NAME", () => {
    // The specific value that used to be the fallback. A deploy that copied
    // it out of the repository must not start.
    assert.throws(
      () =>
        resolveAuthSecret({
          NODE_ENV: "production",
          AUTH_SECRET: "insecure-dev-secret",
        }),
      /AUTH_SECRET_IS_DEFAULT/
    );
  });

  test("a short secret is refused", () => {
    assert.throws(
      () => resolveAuthSecret({ NODE_ENV: "production", AUTH_SECRET: "short" }),
      /AUTH_SECRET_TOO_WEAK/
    );
  });

  test("a proper secret is accepted", () => {
    assert.equal(
      resolveAuthSecret({ NODE_ENV: "production", AUTH_SECRET: STRONG }),
      STRONG
    );
  });

  test("non-production keeps a working default, so local and test runs are unaffected", () => {
    assert.equal(typeof resolveAuthSecret({ NODE_ENV: "development" }), "string");
    assert.equal(typeof resolveAuthSecret({ NODE_ENV: "test" }), "string");
    assert.equal(
      resolveAuthSecret({ NODE_ENV: "test", AUTH_SECRET: STRONG }),
      STRONG
    );
  });

  test("no refusal ever carries the secret value", () => {
    // An error that quotes the key would put it in logs and stack traces —
    // the thing this test exists to keep out of them.
    for (const env of [
      { NODE_ENV: "production", AUTH_SECRET: "" },
      { NODE_ENV: "production", AUTH_SECRET: "insecure-dev-secret" },
      { NODE_ENV: "production", AUTH_SECRET: "a-short-but-real-secret" },
    ]) {
      try {
        resolveAuthSecret(env);
        assert.fail(`expected a refusal for ${JSON.stringify(env.NODE_ENV)}`);
      } catch (e) {
        const message = (e as Error).message;
        if (env.AUTH_SECRET && env.AUTH_SECRET !== "insecure-dev-secret") {
          assert.equal(
            message.includes(env.AUTH_SECRET),
            false,
            "the refusal must not quote the secret"
          );
        }
      }
    }
  });

  test("nothing resolves the key at import time — the build stays green without it", () => {
    // The original comment said the throw was omitted "to avoid breaking the
    // build step". The answer is WHERE it is called, not whether it throws:
    // module load must stay inert so `next build` never triggers it.
    const source = readFileSync(path.join(root, "src/lib/auth.ts"), "utf8");
    assert.doesNotMatch(
      source,
      /^const secret = /m,
      "the key must not be resolved at module scope"
    );
    assert.match(source, /function secretBytes\(\)/);
    assert.match(source, /cachedSecret \?\?=/, "resolved lazily, once per process");
  });
});
