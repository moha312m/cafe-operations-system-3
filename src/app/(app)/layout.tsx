import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { db } from "@/lib/db";
import { AppShell } from "@/components/app-shell";
import { getCafeFeatures } from "@/lib/cafe-settings";
import { resolvePermissionKeys } from "@/lib/perms/effective";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getSession();
  if (!session) redirect("/login");

  // Platform owner works in the dedicated /admin surface, not the cafe app.
  if (session.role === "SUPER_ADMIN") redirect("/admin/dashboard");

  const [cafe, branch] = await Promise.all([
    session.cafeId
      ? db.cafe.findUnique({
          where: { id: session.cafeId },
          select: { id: true, name: true, slug: true, currency: true, taxRate: true, isActive: true },
        })
      : null,
    session.branchId
      ? db.branch.findUnique({
          where: { id: session.branchId },
          select: { name: true },
        })
      : null,
  ]);

  // A cafe suspended after login must not keep serving the app to its staff.
  if (cafe && !cafe.isActive) {
    const { clearSessionCookie } = await import("@/lib/auth");
    await clearSessionCookie();
    redirect("/login?suspended=1");
  }

  // Per-cafe feature flags drive which nav items appear.
  const features = cafe ? await getCafeFeatures(cafe.id) : null;

  // The acting user's effective permission keys seed the client `can()`.
  const permKeys = await resolvePermissionKeys(session);

  return (
    <AppShell
      user={session}
      permKeys={permKeys}
      cafe={
        cafe
          ? {
              id: cafe.id,
              name: cafe.name,
              slug: cafe.slug,
              currency: cafe.currency,
              taxRate: Number(cafe.taxRate),
            }
          : null
      }
      branchName={branch?.name ?? null}
      features={features}
    >
      {children}
    </AppShell>
  );
}
