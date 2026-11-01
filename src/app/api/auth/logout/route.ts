import { NextResponse } from "next/server";
import { clearSessionCookie, getSession } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { db } from "@/lib/db";
import { handleApiError } from "@/lib/api";

export async function POST() {
  try {
    const session = await getSession();
    if (session?.tokenId && session.tokenExpiresAt) {
      // Share the account lock with validation. A successful logout persists
      // this token's denial before clearing the browser's only retry copy.
      await db.$transaction(async tx => {
        await tx.$executeRaw`SET LOCAL lock_timeout = '2s'`;
        await tx.$executeRaw`SET LOCAL statement_timeout = '5s'`;
        await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${session.id} FOR NO KEY UPDATE`;
        const account = await tx.user.findUnique({ where: { id: session.id }, select: { id: true } });
        if (!account) return; // Already-deleted accounts cannot authenticate.
        await tx.sessionRevocation.upsert({
          where: { tokenId: session.tokenId! },
          create: { userId: session.id, tokenId: session.tokenId!, expiresAt: new Date(session.tokenExpiresAt! * 1000) },
          update: {},
        });
      });
      await audit({ cafeId: session.cafeId, userId: session.id, action: "auth.logout", entity: "User", entityId: session.id });
    }
    await clearSessionCookie();
    return NextResponse.json({ ok: true });
  } catch (error) {
    return handleApiError(error);
  }
}
