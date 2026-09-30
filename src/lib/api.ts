import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { Prisma } from "@prisma/client";
import { getSession, type SessionUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { type Permission } from "@/lib/permissions";
import { resolvePermissions } from "@/lib/perms/effective";
import { primaryKey } from "@/lib/perms/catalog";
import {
  getCafeSettings,
  FEATURE_DISABLED_MESSAGE,
  type FeatureFlag,
  type WorkflowSwitch,
} from "@/lib/cafe-settings";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const DENIED = "ليس لديك صلاحية لتنفيذ هذا الإجراء";

// Every route handler resolves auth through this: verifies the session and
// checks the acting user's EFFECTIVE permission (custom cafe role ± per-user
// overrides, gated by feature flags). Legacy `Permission` strings are mapped
// to their canonical key so existing call sites keep working while honouring
// custom roles.
/**
 * A signed session AND an account that is still allowed to use it.
 *
 * The cookie is a bearer token with a twelve-hour life, so on its own it
 * says only "this was true when it was issued". Deactivating a user or
 * suspending a café wrote nothing the token could notice: login checked
 * `isActive`, `archivedAt` and the café's status, which stopped the next
 * sign-in and did nothing about the session already in the fired cashier's
 * browser — who kept collecting payments, closing shifts and accepting
 * custody until the token expired.
 *
 * So every protected request now re-reads the account. That is one indexed
 * primary-key lookup, taken deliberately in preference to a cache: a
 * revocation that takes effect "within a few seconds" is a revocation the
 * person revoking cannot rely on.
 *
 * This lives here rather than in `getSession`, because `src/proxy.ts` — the
 * edge middleware — imports from `@/lib/auth`, and Prisma cannot be pulled
 * into that bundle. `@/lib/api` is server-only, and is the door every
 * guarded route already comes through.
 */
export async function requireActiveSession(): Promise<SessionUser> {
  const session = await getSession();
  if (!session) throw new ApiError(401, "سجّل دخولك الأول");

  const account = await db.user.findUnique({
    where: { id: session.id },
    select: {
      isActive: true,
      archivedAt: true,
      cafe: { select: { isActive: true } },
    },
  });

  // A token for a user who no longer exists is not a session.
  if (!account) throw new ApiError(401, "سجّل دخولك الأول");
  if (!account.isActive || account.archivedAt) {
    throw new ApiError(403, "الحساب موقوف — كلم المدير");
  }
  if (account.cafe && !account.cafe.isActive) {
    throw new ApiError(403, "تم إيقاف حساب الكافيه، برجاء التواصل مع إدارة المنصة");
  }
  return session;
}

export async function requirePermission(
  permission: Permission
): Promise<SessionUser> {
  const session = await requireActiveSession();
  const key = primaryKey(permission);
  const { keys } = await resolvePermissions(session);
  if (!key || !keys.has(key)) {
    throw new ApiError(403, DENIED);
  }
  return session;
}

// Granular guard: checks a specific new permission key. Use for routes that
// need finer control than the legacy Permission strings (staff, roles,
// inventory transactions, settings edit, report export, profit view…).
export async function requireKey(key: string, deniedMessage?: string): Promise<SessionUser> {
  const session = await requireActiveSession();
  const { keys } = await resolvePermissions(session);
  if (!keys.has(key)) {
    throw new ApiError(403, deniedMessage ?? DENIED);
  }
  return session;
}

// Like requireKey but requires the acting user to hold ALL listed keys.
export async function requireAllKeys(...required: string[]): Promise<SessionUser> {
  const session = await requireActiveSession();
  const { keys } = await resolvePermissions(session);
  if (!required.every((k) => keys.has(k))) {
    throw new ApiError(403, DENIED);
  }
  return session;
}

// Tenant isolation: non-super-admins are always pinned to their own
// cafeId regardless of what the request asks for. Super admins must
// name a cafe explicitly (via ?cafeId= or body.cafeId).
export function resolveCafeId(
  session: SessionUser,
  requestedCafeId?: string | null
): string {
  if (session.role === "SUPER_ADMIN") {
    if (!requestedCafeId) {
      throw new ApiError(400, "cafeId is required for super admin requests");
    }
    return requestedCafeId;
  }
  if (!session.cafeId) throw new ApiError(403, "الحساب مش مرتبط بكافيه");
  return session.cafeId;
}

// Branch-pinned staff (cashier, kitchen, inventory) can only act on
// their own branch; owners/managers of the cafe may pick any branch.
export function resolveBranchId(
  session: SessionUser,
  requestedBranchId?: string | null
): string {
  if (session.branchId) {
    if (requestedBranchId && requestedBranchId !== session.branchId) {
      throw new ApiError(403, "ليس لديك صلاحية على فرع تاني");
    }
    return session.branchId;
  }
  if (!requestedBranchId) throw new ApiError(400, "اختار الفرع الأول");
  return requestedBranchId;
}

// Feature gate: throws 403 if the cafe has the module disabled. Super
// admins (no cafeId) bypass — they operate at platform level. Call AFTER
// requirePermission so role checks run first.
export async function requireFeature(
  session: SessionUser,
  feature: FeatureFlag | WorkflowSwitch
): Promise<void> {
  if (session.role === "SUPER_ADMIN") return;
  if (!session.cafeId) throw new ApiError(403, "الحساب مش مرتبط بكافيه");
  const settings = await getCafeSettings(session.cafeId);
  if (!settings[feature]) {
    throw new ApiError(403, FEATURE_DISABLED_MESSAGE);
  }
}

// ── uniqueness conflicts ──────────────────────────────────────────────────
//
// Sequence numbers in this product are allocated by reading the branch's
// current maximum and adding one. That read takes no lock under READ
// COMMITTED — the default here, and the only isolation level the repository
// configures — so two concurrent tills are handed the same number and the
// second insert is refused by `@@unique([branchId, orderNumber])`.
//
// The constraint is right; losing the sale over it was not. `retryOnUniqueConflict`
// re-runs the whole transaction, which has already rolled back, so the second
// attempt re-reads a maximum that now includes the winner and takes the next
// free number. Bounded on purpose: a conflict that survives three attempts is
// not contention any more, and a retry loop that never gives up would turn a
// genuine constraint bug into a hang.

/** True for a P2002, optionally narrowed to one column of the constraint. */
export function isUniqueConflict(error: unknown, field?: string): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (error.code !== "P2002") return false;
  if (!field) return true;
  const target = error.meta?.target;
  if (Array.isArray(target)) return target.includes(field);
  return typeof target === "string" && target.includes(field);
}

export async function retryOnUniqueConflict<T>(
  run: () => Promise<T>,
  {
    field,
    message,
    attempts = 3,
  }: { field?: string; message: string; attempts?: number }
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await run();
    } catch (e) {
      if (!isUniqueConflict(e, field)) throw e;
      // Out of attempts: report the conflict in the café's own words rather
      // than letting a raw Prisma error decide what the cashier reads.
      if (attempt >= attempts) throw new ApiError(409, message);
    }
  }
}

export function handleApiError(error: unknown): NextResponse {
  if (error instanceof ApiError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  if (error instanceof ZodError) {
    const first = error.issues[0];
    return NextResponse.json(
      { error: `${first.path.join(".")}: ${first.message}` },
      { status: 400 }
    );
  }
  // A uniqueness collision is contention, not a fault: two tills asking for
  // the same order number in the same millisecond, or two devices opening the
  // same shift. The database is doing its job by refusing the second one, and
  // the caller needs to be told it lost a race — not shown the unexpected-error
  // page, which is what an unmapped P2002 produced (R-POS-02B1).
  //
  // Deliberately above `console.error`: this is an expected outcome under
  // load, and logging it as a fault would teach whoever reads the log to
  // ignore real ones. Routes that can retry do so before reaching here.
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
    return NextResponse.json(
      { error: "في عملية تانية حصلت في نفس اللحظة — جرّب تاني" },
      { status: 409 }
    );
  }
  console.error(error);
  // Schema drift (P2021 missing table / P2022 missing column) means the app
  // was deployed without running the pending migration — tell the caller
  // it's a temporary maintenance state, not a mystery.
  if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    (error.code === "P2021" || error.code === "P2022")
  ) {
    return NextResponse.json(
      { error: "النظام بيتم تحديثه حاليًا — حاول تاني بعد دقيقة" },
      { status: 503 }
    );
  }
  if (error instanceof Prisma.PrismaClientInitializationError) {
    return NextResponse.json(
      { error: "في مشكلة مؤقتة في الاتصال — حاول تاني بعد لحظات" },
      { status: 503 }
    );
  }
  return NextResponse.json({ error: "حصل خطأ غير متوقع — جرّب تاني" }, { status: 500 });
}
