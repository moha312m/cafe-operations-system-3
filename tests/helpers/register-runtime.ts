import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { PrismaClient, type Role } from "@prisma/client";
import { SYSTEM_ROLE_MAP, type SystemRoleCode } from "@/lib/perms/templates";

export const REGISTER_ORIGIN = "http://127.0.0.1:3162";
const DATABASE = "postgresql://postgres@127.0.0.1:55439/cafe_ops_test_register?schema=public";
export const registerDb = new PrismaClient({ datasourceUrl: DATABASE });
export type Actor = { id: string; name: string; email: string; cookie: string };

let verified: Promise<void> | undefined;
async function verifyDatabase() {
  assert.equal(process.env.DATABASE_URL, DATABASE);
  assert.equal(process.env.TEST_BASE_URL, REGISTER_ORIGIN);
  const [identity] = await registerDb.$queryRaw<{ name: string; host: string; port: number; directory: string }[]>`
    SELECT current_database() AS name, host(inet_server_addr()) AS host, inet_server_port() AS port,
      current_setting('data_directory') AS directory
  `;
  assert.equal(identity.name, "cafe_ops_test_register");
  assert.equal(identity.host, "127.0.0.1");
  assert.equal(identity.port, 55439);
  assert.ok(identity.directory.replaceAll("\\", "/").endsWith("/nextcup-register-followup-20261115/verification-pg/pgdata"));
  const marker = await registerDb.$queryRaw<{ id: number }[]>`SELECT id FROM public._disposable_test_database`;
  assert.deepEqual(marker, [{ id: 1 }]);
}

export function registerPage(path: string, actor?: Actor) {
  assert.ok(path.startsWith("/") && !path.startsWith("//"));
  return fetch(REGISTER_ORIGIN + path, {
    redirect: "manual",
    signal: AbortSignal.timeout(45_000),
    headers: actor ? { cookie: actor.cookie } : undefined,
  });
}

export async function registerApi<T = unknown>(actor: Actor, path: string, method = "GET", body?: unknown, key?: string) {
  assert.ok(path.startsWith("/api/"));
  const response = await fetch(REGISTER_ORIGIN + path, {
    method,
    redirect: "manual",
    signal: AbortSignal.timeout(45_000),
    headers: {
      cookie: actor.cookie,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(key ? { "Idempotency-Key": key } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() as T, headers: response.headers };
}

export function expectStatus<T>(result: { status: number; body: T }, status: number): T {
  assert.equal(result.status, status, JSON.stringify(result.body));
  return result.body;
}

export async function registerFixture(label: string) {
  await (verified ??= verifyDatabase());
  const tag = `REGISTER-${label}-${randomUUID().slice(0, 8)}`;
  const cafe = await registerDb.cafe.create({
    data: {
      name: tag, slug: tag.toLowerCase(), currency: "EGP",
      settings: { create: { stockCountPolicy: "NO_SHIFT_COUNT", inventoryEnabled: false, kitchenScreenEnabled: true } },
      branches: { create: [{ name: `${tag} Main`, menuSlug: "main" }, { name: `${tag} Annex`, menuSlug: "annex" }] },
    },
    include: { branches: true },
  });
  const branch = cafe.branches.find((b) => b.menuSlug === "main")!;
  const annex = cafe.branches.find((b) => b.menuSlug === "annex")!;
  // The fresh cafe is the correspondence probe before any authenticated API writes.
  const menu = await registerPage(`/menu/${cafe.slug}/main`);
  assert.equal(menu.status, 200);
  assert.ok((await menu.text()).includes(tag), "server does not read the same disposable database");
  const password = randomUUID();
  const passwordHash = await bcrypt.hash(password, 10);
  async function makeActor(code: SystemRoleCode, role: Role, branchId: string | null): Promise<Actor> {
    const keys = SYSTEM_ROLE_MAP[code].keys;
    // Login initializes system roles for this new fixture cafe.
    const sessionRole = await registerDb.cafeRole.upsert({
      where: { cafeId_code: { cafeId: cafe.id, code } },
      create: { cafeId: cafe.id, name: code, code, permissions: { create: keys.map((permissionKey) => ({ permissionKey, allowed: true })) } },
      update: {},
    });
    const user = await registerDb.user.create({
      data: { cafeId: cafe.id, branchId, role, cafeRoleId: sessionRole.id, name: code, email: `${cafe.slug}-${code.toLowerCase()}@example.invalid`, passwordHash },
      select: { id: true, name: true, email: true },
    });
    const response = await fetch(REGISTER_ORIGIN + "/api/auth/login", {
      method: "POST", signal: AbortSignal.timeout(45_000),
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: user.email, password }),
    });
    assert.equal(response.status, 200, await response.text());
    const cookie = response.headers.getSetCookie().map((entry) => entry.split(";")[0]).join("; ");
    assert.match(cookie, /cafeops_session=/);
    return { ...user, cookie };
  }

  const owner = await makeActor("OWNER", "CAFE_OWNER", null);
  const manager = await makeActor("MANAGER", "BRANCH_MANAGER", branch.id);
  const cashier = await makeActor("CASHIER", "CASHIER", branch.id);
  const waiter = await makeActor("WAITER", "WAITER", branch.id);
  const makeProduct = async () => {
    const category = await registerDb.menuCategory.create({ data: { cafeId: cafe.id, name: "مشروبات تجريبية" } });
    const product = await registerDb.product.create({ data: { cafeId: cafe.id, categoryId: category.id, name: "قهوة اختبار", basePrice: 50 } });
    await registerDb.recipe.create({
      data: { cafeId: cafe.id, productId: product.id, notApplicable: true, notApplicableReason: "Synthetic stockless item" },
    });
    return product;
  };

  return { cafe, branch, annex, owner, manager, cashier, waiter, makeProduct };
}
export type RegisterFixture = Awaited<ReturnType<typeof registerFixture>>;

export async function openRegister(actor: Actor, branchId: string, openingCashAmount = 2000) {
  const body = expectStatus(await registerApi<{ shift: { id: string } }>(actor, "/api/shifts", "POST", { branchId, openingCashAmount }), 201);
  return body.shift.id;
}
