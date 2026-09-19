// A small in-memory throttle, for the one thing that has none.
//
// `POST /api/auth/login` accepted unlimited attempts. Combined with a seed
// that plants accounts whose passwords are published in this repository,
// that is not a theoretical weakness. The repository already contains a
// limiter — the public AI endpoint has one — so this is the same idea,
// extracted so the login route can share it and tests can drive its clock.
//
// ── WHY A THROTTLE AND NOT A LOCKOUT ──
//
// Locking an ACCOUNT after N failures hands an attacker a denial-of-service
// tool: guess wrong at a known address and the real cashier cannot open the
// till. So the counter is keyed on the PAIR (identity, origin) and the
// penalty is a short, growing cooldown rather than a lock. A café where six
// staff sign in from one NAT'd connection at shift change is unaffected,
// because each of them is a different pair.
//
// ── WHAT THIS DELIBERATELY IS NOT ──
//
// It is per-process and in memory, so it resets on deploy and does not see
// sibling instances. That is a real limit, taken knowingly for this stage:
// it closes single-node brute force now, and a shared or durable limiter is
// required before a multi-instance production launch. It is recorded in the
// stage handoff rather than left for someone to discover.

export type ThrottleVerdict = {
  /** True when the caller should be refused without checking a password. */
  limited: boolean;
  /** How long until the next attempt is allowed, in milliseconds. */
  retryAfterMs: number;
};

type Entry = { failures: number; blockedUntil: number; firstFailureAt: number };

export type ThrottleOptions = {
  /** Failures tolerated inside one window before a cooldown starts. */
  threshold: number;
  /** The window over which failures accumulate. */
  windowMs: number;
  /** The first cooldown; it doubles per additional failure, up to the cap. */
  baseCooldownMs: number;
  /** The longest a cooldown may ever be — a throttle, never a lock. */
  maxCooldownMs: number;
  /** Injectable clock, so tests do not sleep. */
  now?: () => number;
};

export function createThrottle(options: ThrottleOptions) {
  const now = options.now ?? Date.now;
  const entries = new Map<string, Entry>();

  /** Forget anything that can no longer matter, so the map cannot grow forever. */
  function sweep(at: number) {
    for (const [key, entry] of entries) {
      const expired =
        at > entry.blockedUntil && at - entry.firstFailureAt > options.windowMs;
      if (expired) entries.delete(key);
    }
  }

  return {
    /** Asked BEFORE a password is checked. Never mutates. */
    check(key: string): ThrottleVerdict {
      const at = now();
      const entry = entries.get(key);
      if (!entry) return { limited: false, retryAfterMs: 0 };
      if (at < entry.blockedUntil) {
        return { limited: true, retryAfterMs: entry.blockedUntil - at };
      }
      return { limited: false, retryAfterMs: 0 };
    },

    /** One wrong password. Starts or extends the cooldown once past the threshold. */
    recordFailure(key: string): ThrottleVerdict {
      const at = now();
      sweep(at);
      const existing = entries.get(key);
      const entry: Entry =
        existing && at - existing.firstFailureAt <= options.windowMs
          ? existing
          : { failures: 0, blockedUntil: 0, firstFailureAt: at };

      entry.failures += 1;
      if (entry.failures > options.threshold) {
        const over = entry.failures - options.threshold - 1;
        const cooldown = Math.min(
          options.baseCooldownMs * 2 ** over,
          options.maxCooldownMs
        );
        entry.blockedUntil = at + cooldown;
      }
      entries.set(key, entry);
      return entry.blockedUntil > at
        ? { limited: true, retryAfterMs: entry.blockedUntil - at }
        : { limited: false, retryAfterMs: 0 };
    },

    /**
     * A correct password clears the record.
     *
     * Without this, a cashier who mistypes four times and then succeeds would
     * carry those failures into their next sign-in an hour later.
     */
    reset(key: string) {
      entries.delete(key);
    },

    /** Test seam only. */
    size() {
      return entries.size;
    },
  };
}

export type Throttle = ReturnType<typeof createThrottle>;
