import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { ROLE_PERMISSIONS } from "@/lib/permissions";

export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }
  return NextResponse.json({
    user: session,
    permissions: ROLE_PERMISSIONS[session.role],
  });
}
