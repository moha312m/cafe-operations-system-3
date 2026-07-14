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

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export async function POST(request: NextRequest) {
  try {
    const { email, password } = loginSchema.parse(await request.json());

    const user = await db.user.findUnique({
      where: { email: email.toLowerCase() },
      include: { cafe: { select: { isActive: true } } },
    });

    // Same error for wrong email and wrong password.
    if (!user || !(await verifyPassword(password, user.passwordHash))) {
      throw new ApiError(401, "Invalid email or password");
    }
    if (!user.isActive || user.archivedAt) {
      throw new ApiError(403, "الحساب موقوف — كلم المدير");
    }
    if (user.cafe && !user.cafe.isActive) {
      throw new ApiError(403, "This cafe is suspended");
    }

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
