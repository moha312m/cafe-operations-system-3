// Executes the real JWT, session guard, effective permissions and route handlers.
// Only request cookies and external database/settings/audit boundaries are doubles.
// Live SQL/HTTP acceptance remains a separate required check.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";
import { SignJWT } from "jose";

const nativeRequire = createRequire(import.meta.url);
function host() {
  let cookie: string | null = null;
  const account = { id: "worker", email: "worker@example.invalid", name: "Worker",
    role: "BRANCH_MANAGER", cafeId: "cafe", branchId: "A", isActive: true,
    archivedAt: null, cafe: { isActive: true }, cafeRoleId: "custom",
    cafeRole: { isActive: true, permissions: ["branches.view", "branches.manage", "menu.view"]
      .map(permissionKey => ({ permissionKey, allowed: true })) },
    permissionOverrides: [] as Array<{ permissionKey: string; allowed: boolean }> };
  const branches = [
    { id: "A", cafeId: "cafe", name: "A", phone: null },
    { id: "B", cafeId: "cafe", name: "B", phone: null },
    { id: "X", cafeId: "foreign", name: "X", phone: null },
  ];
  const revoked = new Map<string, { userId: string; tokenId: string; expiresAt: Date }>();
  let assignmentResolutions = 0;
  let cookieCleared = false;
  let failRevocationWrite = false;
  const db = {
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(db),
    $executeRaw: async () => 0,
    $queryRaw: async () => [{ id: account.id }],
    user: { findUnique: async () => structuredClone(account) },
    sessionRevocation: {
      findUnique: async ({ where }: { where: { tokenId: string } }) => revoked.get(where.tokenId) ?? null,
      upsert: async ({ where, create }: { where: { tokenId: string }; create: { userId: string; tokenId: string; expiresAt: Date } }) => {
        if (failRevocationWrite) throw new Error("revocation write unavailable");
        if (!revoked.has(where.tokenId)) revoked.set(where.tokenId, create);
        return revoked.get(where.tokenId);
      },
    },
    branch: {
      findUnique: async ({ where }: { where: { id: string } }) => structuredClone(branches.find(b => b.id === where.id)),
      findMany: async ({ where }: { where: { cafeId: string } }) => structuredClone(branches.filter(b => b.cafeId === where.cafeId)),
      update: async ({ where, data }: { where: { id: string }; data: object }) => {
        const branch = branches.find(b => b.id === where.id)!;
        Object.assign(branch, data); return structuredClone(branch);
      },
    },
  };
  const cache = new Map<string, Record<string, unknown>>();
  function load(file: string): Record<string, unknown> {
    const full = path.resolve(file);
    const existing = cache.get(full); if (existing) return existing;
    const exports: Record<string, unknown> = {}; cache.set(full, exports);
    const code = ts.transpileModule(readFileSync(full, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    }).outputText;
    const require = (id: string): unknown => {
      if (id === "next/headers") return { cookies: async () => ({
        get: () => cookie ? { value: cookie } : undefined,
        delete: () => { cookie = null; cookieCleared = true; },
      }) };
      if (id === "@/lib/db") return { db };
      if (id === "@/lib/audit") return { audit: async () => {} };
      if (id === "@/lib/cafe-settings") return { getCafeSettings: async () => ({}) };
      if (id === "@/lib/staff-branch") return { resolveStaffBranchInTransaction: async () => {
        assignmentResolutions++;
        return { branchId: account.branchId, homeBranchId: "A", temporaryBranchId: null,
          temporaryBranchUntil: null, temporaryBranchStatus: null };
      } };
      if (id.startsWith("@/")) return load("src/" + id.slice(2) + ".ts");
      if (id.startsWith(".")) return load(path.resolve(path.dirname(full), id) + ".ts");
      return nativeRequire(id);
    };
    vm.runInNewContext(code, { exports, require, crypto: globalThis.crypto, TextEncoder,
      process: { env: { NODE_ENV: "test", AUTH_SECRET: "offline-session-test-secret" } },
      Date, console: { error() {} } });
    return exports;
  }
  const auth = load("src/lib/auth.ts") as { createSessionToken: (user: object) => Promise<string> };
  const meRoute = load("src/app/api/auth/me/route.ts") as { GET: () => Promise<Response> };
  const logoutRoute = load("src/app/api/auth/logout/route.ts") as { POST: () => Promise<Response> };
  const patchRoute = load("src/app/api/branches/[id]/route.ts") as { PATCH: (req: Request, context: object) => Promise<Response> };
  const listRoute = load("src/app/api/branches/route.ts") as { GET: (req: object) => Promise<Response>; POST: (req: Request) => Promise<Response> };
  return { account, branches, revoked,
    issue: () => auth.createSessionToken(account),
    use: (token: string | null) => { cookie = token; },
    me: () => meRoute.GET(), logout: () => logoutRoute.POST(),
    patch: (id = "A") => patchRoute.PATCH(new Request("http://localhost/api/branches/" + id,
      { method: "PATCH", body: JSON.stringify({ phone: "unauthorized" }) }), { params: Promise.resolve({ id }) }),
    list: () => listRoute.GET({ nextUrl: new URL("http://localhost/api/branches") }),
    create: () => listRoute.POST(new Request("http://localhost/api/branches", { method: "POST", body: JSON.stringify({ name: "denied" }) })),
    assignments: () => assignmentResolutions,
    cleared: () => cookieCleared,
    failWrite: () => { failRevocationWrite = true; },
  };
}

test("logout rejects the exact captured token at auth/me and branch PATCH, without affecting a second login", async () => {
  const h = host(), first = await h.issue(), second = await h.issue();
  assert.ok(first !== second, "same-second logins must have distinct revocation identities");
  h.use(first); assert.equal((await h.me()).status, 200);
  assert.equal((await h.logout()).status, 200); assert.equal(h.cleared(), true);
  const rows = structuredClone(h.branches), resolved = h.assignments();
  h.use(first); assert.equal((await h.me()).status, 401);
  assert.equal((await h.patch()).status, 401);
  assert.deepEqual(h.branches, rows); assert.equal(h.assignments(), resolved);
  h.use(second); assert.equal((await h.me()).status, 200);
  assert.equal((await h.patch()).status, 200);
});

test("a legacy JWT without jti stays valid until its own logout, then exact replay is denied", async () => {
  const h = host();
  const legacy = await new SignJWT({ ...h.account }).setProtectedHeader({ alg: "HS256" })
    .setSubject("worker").setIssuedAt().setExpirationTime("2h")
    .sign(new TextEncoder().encode("offline-session-test-secret"));
  const second = await h.issue();
  h.use(legacy); assert.equal((await h.me()).status, 200);
  assert.equal((await h.logout()).status, 200);
  h.use(legacy); assert.equal((await h.me()).status, 401);
  const rows = structuredClone(h.branches);
  assert.equal((await h.patch()).status, 401); assert.deepEqual(h.branches, rows);
  h.use(second); assert.equal((await h.me()).status, 200);
  const saved = [...h.revoked.values()][0];
  assert.ok(saved); assert.ok(saved.expiresAt.getTime() < Date.now() + 2 * 3600000 + 1000,
    "revocation retains JWT expiry, not a new twelve-hour bound");
});

test("removing branches.manage on an existing session denies PATCH/POST but preserves viewing", async () => {
  const h = host(); h.use(await h.issue());
  assert.equal((await h.patch()).status, 200);
  h.account.permissionOverrides.push({ permissionKey: "branches.manage", allowed: false });
  const rows = structuredClone(h.branches);
  assert.equal((await h.patch()).status, 403);
  assert.equal((await h.create()).status, 403);
  assert.deepEqual(h.branches, rows);
  assert.equal((await h.list()).status, 200); assert.equal((await h.me()).status, 200);
});

test("legacy signature encoding variants share revocation identity", async () => {
  const h = host();
  const legacy = await new SignJWT({ ...h.account }).setProtectedHeader({ alg: "HS256" })
    .setSubject("worker").setIssuedAt().setExpirationTime("2h")
    .sign(new TextEncoder().encode("offline-session-test-secret"));
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const variant = legacy.slice(0, -1) + alphabet[alphabet.indexOf(legacy.at(-1)!) ^ 1];
  h.use(variant); assert.equal((await h.me()).status, 200, "jose accepts the same signature bytes with alternate pad bits");
  h.use(legacy); assert.equal((await h.logout()).status, 200);
  h.use(variant); assert.equal((await h.me()).status, 401);
  const rows = structuredClone(h.branches);
  assert.equal((await h.patch()).status, 401); assert.deepEqual(h.branches, rows);
});

test("custom-role permission removal is re-read on the existing token", async () => {
  const h = host(); h.use(await h.issue());
  h.account.cafeRole.permissions = h.account.cafeRole.permissions.filter(p => p.permissionKey !== "branches.manage");
  const rows = structuredClone(h.branches);
  assert.equal((await h.patch()).status, 403); assert.deepEqual(h.branches, rows);
  assert.equal((await h.list()).status, 200);
});

test("authorized branch management still denies foreign tenant and branch writes", async () => {
  const h = host(); h.use(await h.issue()); const rows = structuredClone(h.branches);
  assert.equal((await h.patch("B")).status, 403);
  assert.equal((await h.patch("X")).status, 403); assert.deepEqual(h.branches, rows);
});

test("expired and absent sessions cannot write protected rows", async () => {
  const h = host(); const rows = structuredClone(h.branches);
  const expired = await new SignJWT({ ...h.account }).setProtectedHeader({ alg: "HS256" })
    .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
    .sign(new TextEncoder().encode("offline-session-test-secret"));
  for (const token of [expired, null]) {
    h.use(token); assert.equal((await h.me()).status, 401); assert.equal((await h.patch()).status, 401);
  }
  assert.deepEqual(h.branches, rows);
});

test("failed durable revocation cannot report logout success or clear the only retry token", async () => {
  const h = host(); h.use(await h.issue()); h.failWrite();
  assert.equal((await h.logout()).status, 500); assert.equal(h.cleared(), false);
});
