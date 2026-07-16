import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { AdminShell } from "@/components/admin/admin-shell";

// Every /admin/* page lives under this group. Only SUPER_ADMIN may enter;
// cafe owners/staff are bounced to their own dashboard so platform tools
// are never exposed to tenants.
export default async function SuperAdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getSession();
  if (!session) redirect("/login");
  if (session.role !== "SUPER_ADMIN") redirect("/dashboard");

  return <AdminShell userName={session.name}>{children}</AdminShell>;
}
