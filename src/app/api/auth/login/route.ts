import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import {
  verifyPassword,
  createSessionToken,
  setSessionCookie,
  type SessionUser,
} from "@/lib/auth";
import { audit } from "@/lib/audit";
import { handleApiError, ApiError } from "@/lib/api";
import { ensureCafeRoles } from "@/lib/perms/roles";
import { createThrottle } from "@/lib/rate-limit";

// Five wrong passwords for one (email, origin) pair inside ten minutes, then
// a cooldown that starts at fifteen seconds and doubles to at most five
// minutes. A mistyped password costs nothing; a script gets slower than it
// is worth. Per-process and in memory — see the module comment for what that
// does and does not cover.
const loginThrottle = createThrottle({
  threshold: 5,
  windowMs: 10 * 60_000,
  baseCooldownMs: 15_000,
  maxCooldownMs: 5 * 60_000,
});

/** The caller's origin, as far as a proxied request can tell us. */
function originOf(request: NextRequest): string {
  const forwarded = request.headers.get("x-forwarded-for");
  return (forwarded?.split(",")[0] ?? "").trim() || "unknown";
}

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export async function POST(request: NextRequest) {
  try {
    const { email, password } = loginSchema.parse(await request.json());

    // Keyed on the PAIR, so one attacker cannot lock out a real cashier by
    // guessing at their address, and one busy café behind a single IP does
    // not throttle its own staff.
    const throttleKey = `${email.toLowerCase()}|${originOf(request)}`;
    if (loginThrottle.check(throttleKey).limited) {
      // Deliberately the same refusal as a wrong password: a distinct
      // "you are throttled" answer would confirm the address exists.
      throw new ApiError(401, "Invalid email or password");
    }

    const user = await db.user.findUnique({
      where: { email: email.toLowerCase() },
      include: { cafe: { select: { isActive: true } } },
    });

    // Same error for wrong email and wrong password.
    if (!user || !(await verifyPassword(password, user.passwordHash))) {
      loginThrottle.recordFailure(throttleKey);
      throw new ApiError(401, "Invalid email or password");
    }
    if (!user.isActive || user.archivedAt) {
      throw new ApiError(403, "الحساب موقوف — كلم المدير");
    }
    if (user.cafe && !user.cafe.isActive) {
      throw new ApiError(403, "تم إيقاف حساب الكافيه، برجاء التواصل مع إدارة المنصة");
    }

    // The password was right: this pair is not under attack.
    loginThrottle.reset(throttleKey);

    await db.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    const sessionUser: SessionUser = {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      cafeId: user.cafeId,
      branchId: user.branchId,
    };
    await setSessionCookie(await createSessionToken(sessionUser));

    // Keep system-default roles in sync with the permission catalog (new
    // keys added by app updates reach existing cafes on next login).
    if (user.cafeId) {
      try { await ensureCafeRoles(user.cafeId); } catch { /* non-blocking */ }
    }

    await audit({
      cafeId: user.cafeId,
      userId: user.id,
      action: "auth.login",
      entity: "User",
      entityId: user.id,
    });

    return NextResponse.json({ user: sessionUser });
  } catch (error) {
    return handleApiError(error);
  }
}
