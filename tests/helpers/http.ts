// Minimal cookie-aware HTTP client for tests that must exercise a real API
// route rather than a service function. SHIFT-003 is about what the server
// hands the cashier's browser, so it can only be tested at this boundary.
//
// Credentials are the local seed fixtures from prisma/seed.ts — no secret is
// introduced here that the repository does not already contain.

/**
 * The server these tests drive.
 *
 * There is no default. It used to fall back to `http://localhost:3000`, which
 * is the developer's own dev server — connected to the developer's own
 * database. A suite that reached that fallback would create fixtures in the
 * test database and then exercise the API against real café data, which is
 * the split-brain failure TOOLING-005 exists to prevent.
 *
 * `npm test` sets this to the test server on :3100. Anything else refuses.
 */
export const BASE = (() => {
  const url = process.env.TEST_BASE_URL;
  if (!url) {
    throw new Error(
      "TEST_BASE_URL is not set, and there is no default: falling back to " +
        "localhost:3000 would point HTTP tests at the developer's dev server " +
        "and their own database. Run `npm test`, which starts the suite " +
        "against the isolated test server. See TESTING.md."
    );
  }
  return url;
})();

const jars = new Map<string, string>();

/** Fail loudly rather than skipping when the dev server is not running. */
export async function requireServer() {
  try {
    const r = await fetch(`${BASE}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    if (r.status === 404) {
      throw new Error(
        `Dev server at ${BASE} is serving 404 for API routes — clear .next and restart`
      );
    }
  } catch (e) {
    throw new Error(
      `Dev server not reachable at ${BASE}: ${(e as Error).message}. ` +
        `Start it before running these tests.`
    );
  }
}

export async function login(email: string, password: string) {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!r.ok) throw new Error(`login ${email} failed: ${r.status}`);
  jars.set(email, (r.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; "));
}

export async function as<T = Record<string, unknown>>(
  email: string,
  path: string,
  init: RequestInit = {}
): Promise<{ status: number; body: T; text: string }> {
  const r = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      cookie: jars.get(email) ?? "",
      ...(init.headers ?? {}),
    },
  });
  const text = await r.text();
  let body: T;
  try { body = JSON.parse(text) as T; } catch { body = {} as T; }
  return { status: r.status, body, text };
}
