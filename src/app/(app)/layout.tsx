import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { db } from "@/lib/db";
import { AppShell } from "@/components/app-shell";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getSession();
  if (!session) redirect("/login");

  const [cafe, branch] = await Promise.all([
    session.cafeId
      ? db.cafe.findUnique({
          where: { id: session.cafeId },
          select: { id: true, name: true, slug: true, currency: true, taxRate: true },
        })
      : null,
    session.branchId
      ? db.branch.findUnique({
          where: { id: session.branchId },
          select: { name: true },
        })
      : null,
  ]);

  return (
    <AppShell
      user={session}
      cafe={
        cafe
          ? { ...cafe, taxRate: Number(cafe.taxRate) }
          : null
      }
      branchName={branch?.name ?? null}
    >
      {children}
    </AppShell>
  );
}
