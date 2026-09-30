import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";
import bcrypt from "bcryptjs";
import type { Role } from "@prisma/client";

const SESSION_COOKIE = "cafeops_session";
const SESSION_HOURS = 12;

/**
 * The development fallback, named so it can be refused by name.
 *
 * It is published in this repository, so a production process signing with
 * it is signing with a key anybody can read.
 */
const DEFAULT_DEV_SECRET = "insecure-dev-secret";

/** Short enough to brute-force is not a secret. 32 bytes of entropy. */
const MIN_SECRET_LENGTH = 32;

/**
 * The signing key, or a refusal.
 *
 * This used to warn and carry on: `AUTH_SECRET ?? "insecure-dev-secret"`,
 * with a comment explaining that it did not throw "to avoid breaking the
 * build step". The consequence was that one missing environment variable
 * turned every session cookie into a forgeable token — `verifySessionToken`
 * trusts the payload's role and cafeId wholesale, so a forged SUPER_ADMIN
 * cookie is full cross-tenant access, and the only symptom is a line in a
 * log nobody reads.
 *
 * So production now fails closed on a missing, empty, default, or short
 * secret. The build-step concern that motivated the warning is answered by
 * WHERE this is called rather than by weakening it: nothing runs at module
 * load any more, only when a token is actually signed or verified, which
 * `next build` never does.
 *
 * Pure in its `env` argument so every refusal is testable without a process.
 * Throws the reason as a CODE — the value itself is never included in an
 * error, a log, or a stack trace.
 */
export function resolveAuthSecret(
  env: { AUTH_SECRET?: string; NODE_ENV?: string } = process.env
): string {
  const value = env.AUTH_SECRET ?? "";
  if (env.NODE_ENV !== "production") {
    // Local and test runs keep a working default; they sign nothing that
    // anyone outside the machine will ever accept.
    return value || DEFAULT_DEV_SECRET;
  }
  if (!value) throw new Error("AUTH_SECRET_MISSING");
  if (value === DEFAULT_DEV_SECRET) throw new Error("AUTH_SECRET_IS_DEFAULT");
  if (value.length < MIN_SECRET_LENGTH) throw new Error("AUTH_SECRET_TOO_WEAK");
  return value;
}

// Resolved once per process, on first use rather than on import.
let cachedSecret: Uint8Array | null = null;
function secretBytes(): Uint8Array {
  cachedSecret ??= new TextEncoder().encode(resolveAuthSecret());
  return cachedSecret;
}

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
    .sign(secretBytes());
}

export async function verifySessionToken(
  token: string
): Promise<SessionUser | null> {
  try {
    const { payload } = await jwtVerify(token, secretBytes());
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
