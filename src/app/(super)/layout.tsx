import { redirect } from "next/navigation";
import { requireActiveSession, ApiError } from "@/lib/api";
import { AdminShell } from "@/components/admin/admin-shell";

// Every /admin/* page lives under this group. Only SUPER_ADMIN may enter;
// cafe owners/staff are bounced to their own dashboard so platform tools
// are never exposed to tenants.
export default async function SuperAdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Same guard as the café app: the role comes from the account row, not
  // from a twelve-hour cookie that may have been revoked or demoted.
  let session;
  try {
    session = await requireActiveSession();
  } catch (error) {
    if (error instanceof ApiError && (error.status === 401 || error.status === 403)) redirect("/api/auth/recover");
    throw error;
  }
  if (session.role !== "SUPER_ADMIN") redirect("/dashboard");

  return <AdminShell userName={session.name}>{children}</AdminShell>;
}
