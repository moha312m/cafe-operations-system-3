// SEC-002 (R-SEC-01/A2) — guessing passwords must get slower; typing one
// wrong must not.
//
// `POST /api/auth/login` accepted unlimited attempts, against accounts whose
// demo passwords are published in this repository. The throttle added here
// is keyed on the PAIR (email, origin) rather than on the account, because a
// lockout keyed on the account alone is a denial-of-service tool: guess
// wrong at a known address and the real cashier cannot open the till.
//
// The clock is injected, so these prove the cooldown expires without sleeping.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createThrottle } from "@/lib/rate-limit";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function fixed() {
  let now = 1_000_000;
  return {
    now: () => now,
    advance(ms: number) {
      now += ms;
    },
  };
}

const opts = (now: () => number) => ({
  threshold: 3,
  windowMs: 60_000,
  baseCooldownMs: 1_000,
  maxCooldownMs: 8_000,
  now,
});

describe("SEC-002 the login throttle", () => {
  test("attempts below the threshold are never limited", () => {
    const clock = fixed();
    const t = createThrottle(opts(clock.now));
    for (let i = 0; i < 3; i += 1) {
      assert.equal(t.recordFailure("a|1.1.1.1").limited, false, `failure ${i + 1}`);
    }
    assert.equal(t.check("a|1.1.1.1").limited, false);
  });

  test("repeated failures are limited", () => {
    const clock = fixed();
    const t = createThrottle(opts(clock.now));
    for (let i = 0; i < 4; i += 1) t.recordFailure("a|1.1.1.1");
    const verdict = t.check("a|1.1.1.1");
    assert.equal(verdict.limited, true);
    assert.ok(verdict.retryAfterMs > 0);
  });

  test("the cooldown is temporary, never a permanent lock", () => {
    const clock = fixed();
    const t = createThrottle(opts(clock.now));
    for (let i = 0; i < 4; i += 1) t.recordFailure("a|1.1.1.1");
    assert.equal(t.check("a|1.1.1.1").limited, true);

    clock.advance(1_500); // past the first cooldown
    assert.equal(
      t.check("a|1.1.1.1").limited,
      false,
      "a throttle that never lifts is a lockout"
    );
  });

  test("the cooldown grows with persistence but is capped", () => {
    const clock = fixed();
    const t = createThrottle(opts(clock.now));
    let last = 0;
    for (let i = 0; i < 10; i += 1) {
      const v = t.recordFailure("a|1.1.1.1");
      if (v.limited) last = v.retryAfterMs;
    }
    assert.ok(last > 0);
    assert.ok(last <= 8_000, "the cap holds, so this can never become a lock");
  });

  test("keying is per (identity, origin) — one attacker cannot lock a real cashier out", () => {
    const clock = fixed();
    const t = createThrottle(opts(clock.now));
    // An attacker hammering the cashier's address from their own machine…
    for (let i = 0; i < 6; i += 1) t.recordFailure("cashier@demo.com|9.9.9.9");
    assert.equal(t.check("cashier@demo.com|9.9.9.9").limited, true);
    // …must not affect the same cashier signing in from the café.
    assert.equal(
      t.check("cashier@demo.com|10.0.0.5").limited,
      false,
      "the real cashier must still be able to sign in"
    );
  });

  test("a different member of staff behind the same connection is unaffected", () => {
    const clock = fixed();
    const t = createThrottle(opts(clock.now));
    for (let i = 0; i < 6; i += 1) t.recordFailure("waiter@demo.com|10.0.0.5");
    assert.equal(t.check("manager@demo.com|10.0.0.5").limited, false);
  });

  test("a correct password clears the record", () => {
    const clock = fixed();
    const t = createThrottle(opts(clock.now));
    for (let i = 0; i < 4; i += 1) t.recordFailure("a|1.1.1.1");
    assert.equal(t.check("a|1.1.1.1").limited, true);
    t.reset("a|1.1.1.1");
    assert.equal(t.check("a|1.1.1.1").limited, false);
  });

  test("the record does not accumulate across windows", () => {
    const clock = fixed();
    const t = createThrottle(opts(clock.now));
    for (let i = 0; i < 3; i += 1) t.recordFailure("a|1.1.1.1");
    clock.advance(120_000); // two windows later
    assert.equal(
      t.recordFailure("a|1.1.1.1").limited,
      false,
      "yesterday's typos are not today's attack"
    );
  });

  test("the login route consults the throttle before checking a password, and resets on success", () => {
    const source = readFileSync(
      path.join(root, "src/app/api/auth/login/route.ts"),
      "utf8"
    );
    assert.match(source, /loginThrottle\.check\(throttleKey\)/);
    assert.match(source, /loginThrottle\.recordFailure\(throttleKey\)/);
    assert.match(source, /loginThrottle\.reset\(throttleKey\)/);
    // The refusal must be indistinguishable from a wrong password, or it
    // becomes an oracle for which addresses exist.
    assert.match(source, /limited\)\s*\{[\s\S]{0,260}Invalid email or password/);
    // And it must be keyed on the pair, not on the account alone.
    assert.match(source, /\$\{email\.toLowerCase\(\)\}\|\$\{originOf\(request\)\}/);
  });

  test("no schema or migration was required", () => {
    const schema = readFileSync(path.join(root, "prisma/schema.prisma"), "utf8");
    assert.doesNotMatch(schema, /failedAttempts|lockedUntil/);
  });
});
