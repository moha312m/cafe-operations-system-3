import { NextResponse, type NextRequest } from "next/server";
import { ApiError, handleApiError, requireActiveSession } from "@/lib/api";
import { clearSessionCookie } from "@/lib/auth";

// Server Components can reject a revoked account but cannot delete its cookie.
// Revalidate here before clearing so an active session keeps its existing token.
export async function GET(request: NextRequest) {
  try {
    const session = await requireActiveSession();
    const destination = session.role === "SUPER_ADMIN" ? "/admin/dashboard" : "/dashboard";
    return NextResponse.redirect(new URL(destination, request.url));
  } catch (error) {
    if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
      await clearSessionCookie();
      return NextResponse.redirect(new URL("/login", request.url));
    }
    return handleApiError(error);
  }
}
