import { db } from "@/lib/db";
import { loadCustomerMenu, MenuUnavailable } from "@/lib/customer-menu";
import { CustomerMenuPage } from "@/components/customer-menu/customer-menu-page";

// Always fresh: manager edits to the menu appear immediately.
export const dynamic = "force-dynamic";

// Public customer menu: /menu/[cafeSlug]/[branchSlug]?table=5
// Must NEVER crash — every failure renders an Arabic message.
export default async function PublicMenuPage({
  params,
  searchParams,
}: {
  params: Promise<{ cafeSlug: string; branchSlug: string }>;
  searchParams: Promise<{ table?: string }>;
}) {
  const [{ cafeSlug, branchSlug }, { table }] = await Promise.all([
    params,
    searchParams,
  ]);

  let branch = null;
  try {
    branch = await db.branch.findFirst({
      where: {
        menuSlug: branchSlug,
        cafe: { slug: cafeSlug }, // both slugs must match — no cross-tenant guessing
      },
      include: { cafe: true },
    });
  } catch (e) {
    console.error("menu branch lookup failed", e);
    return <MenuUnavailable reason="error" />;
  }

  const result = await loadCustomerMenu(branch); // never throws
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
