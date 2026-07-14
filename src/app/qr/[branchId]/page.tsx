import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { loadCustomerMenu, MenuUnavailable } from "@/lib/customer-menu";
import { CustomerMenuPage } from "@/components/customer-menu/customer-menu-page";

export const dynamic = "force-dynamic";

// Legacy/fallback QR link by branch id. If the branch has a pretty
// menu slug we redirect to the canonical URL; otherwise serve directly.
export default async function QrByIdPage({
  params,
  searchParams,
}: {
  params: Promise<{ branchId: string }>;
  searchParams: Promise<{ table?: string }>;
}) {
  const [{ branchId }, { table }] = await Promise.all([params, searchParams]);

  const branch = await db.branch.findUnique({
    where: { id: branchId },
    include: { cafe: true },
  });

  if (branch?.menuSlug) {
    const query = table?.trim() ? `?table=${encodeURIComponent(table.trim())}` : "";
    redirect(`/menu/${branch.cafe.slug}/${branch.menuSlug}${query}`);
  }

  const result = await loadCustomerMenu(branch);
  if (result.status !== "ok") {
    return <MenuUnavailable reason={result.status} />;
  }

  return (
    <CustomerMenuPage
      menu={result.menu}
      initialTable={table?.trim() ? table.trim() : null}
    />
  );
}
