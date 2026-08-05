import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { getSession, type SessionUser } from "@/lib/auth";
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
export async function requirePermission(
  permission: Permission
): Promise<SessionUser> {
  const session = await getSession();
  if (!session) throw new ApiError(401, "سجّل دخولك الأول");
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
export async function requireKey(key: string): Promise<SessionUser> {
  const session = await getSession();
  if (!session) throw new ApiError(401, "سجّل دخولك الأول");
  const { keys } = await resolvePermissions(session);
  if (!keys.has(key)) {
    throw new ApiError(403, DENIED);
  }
  return session;
}

// Like requireKey but requires the acting user to hold ALL listed keys.
export async function requireAllKeys(...required: string[]): Promise<SessionUser> {
  const session = await getSession();
  if (!session) throw new ApiError(401, "سجّل دخولك الأول");
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
  console.error(error);
  return NextResponse.json({ error: "حصل خطأ غير متوقع — جرّب تاني" }, { status: 500 });
}
