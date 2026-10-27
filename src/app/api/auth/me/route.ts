import { NextResponse } from "next/server";
import { requireActiveSession, handleApiError } from "@/lib/api";
import { ROLE_PERMISSIONS } from "@/lib/permissions";

export async function GET() {
  try {
    const session = await requireActiveSession();
    return NextResponse.json({ user: session, permissions: ROLE_PERMISSIONS[session.role] });
  } catch (error) {
    return handleApiError(error);
  }
}
