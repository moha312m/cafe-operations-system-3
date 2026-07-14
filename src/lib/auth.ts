import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";
import bcrypt from "bcryptjs";
import type { Role } from "@prisma/client";

const SESSION_COOKIE = "cafeops_session";
const SESSION_HOURS = 12;

// AUTH_SECRET signs the session cookie. Missing it in production means
// every session is signed with a public default — warn loudly so it's
// caught in logs (we don't throw here to avoid breaking the build step).
if (!process.env.AUTH_SECRET && process.env.NODE_ENV === "production") {
  console.error(
    "⚠️  AUTH_SECRET is not set — sessions are insecure. Set it in your host's environment variables."
  );
}

const secret = new TextEncoder().encode(
  process.env.AUTH_SECRET ?? "insecure-dev-secret"
);

export type SessionUser = {
  id: string;
  email: string;
  name: string;
  role: Role;
  cafeId: string | null;
  branchId: string | null;
};

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, 10);
}

export async function verifyPassword(
  plain: string,
  hash: string
): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

export async function createSessionToken(user: SessionUser): Promise<string> {
  return new SignJWT({ ...user })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(user.id)
    .setIssuedAt()
    .setExpirationTime(`${SESSION_HOURS}h`)
    .sign(secret);
}

export async function verifySessionToken(
  token: string
): Promise<SessionUser | null> {
  try {
    const { payload } = await jwtVerify(token, secret);
    return {
      id: payload.id as string,
      email: payload.email as string,
      name: payload.name as string,
      role: payload.role as Role,
      cafeId: (payload.cafeId as string | null) ?? null,
      branchId: (payload.branchId as string | null) ?? null,
    };
  } catch {
    return null;
  }
}

export async function getSession(): Promise<SessionUser | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return verifySessionToken(token);
}

export async function setSessionCookie(token: string) {
  const store = await cookies();
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_HOURS * 60 * 60,
  });
}

export async function clearSessionCookie() {
  const store = await cookies();
  store.delete(SESSION_COOKIE);
}

export { SESSION_COOKIE };
