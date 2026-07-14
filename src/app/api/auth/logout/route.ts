import { NextResponse } from "next/server";
import { clearSessionCookie, getSession } from "@/lib/auth";
import { audit } from "@/lib/audit";

export async function POST() {
  const session = await getSession();
  if (session) {
    await audit({
      cafeId: session.cafeId,
      userId: session.id,
      action: "auth.logout",
      entity: "User",
      entityId: session.id,
    });
  }
  await clearSessionCookie();
  return NextResponse.json({ ok: true });
}
