import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { loadCustomerMenu, MenuUnavailable } from "@/lib/customer-menu";
import { CustomerMenuPage } from "@/components/customer-menu/customer-menu-page";

export const dynamic = "force-dynamic";

// Public QR entry by branch id — the format printed on table stickers
// (/qr/[branchId]?table=N), kept working forever. If the branch has a
// pretty menu slug we redirect to the canonical URL; otherwise serve the
// menu directly. This page must NEVER crash: every failure renders an
// Arabic message instead.
export default async function QrByIdPage({
  params,
  searchParams,
}: {
  params: Promise<{ branchId: string }>;
  searchParams: Promise<{ table?: string }>;
}) {
  const [{ branchId }, { table }] = await Promise.all([params, searchParams]);

  // Branch lookup is fail-safe: a malformed code or DB hiccup shows the
  // invalid-QR page, not a server error.
  let branch = null;
  try {
    branch = await db.branch.findUnique({
      where: { id: branchId },
      include: { cafe: true },
    });
  } catch (e) {
    console.error("qr branch lookup failed", e);
    return <MenuUnavailable reason="error" />;
  }
  if (!branch) return <MenuUnavailable reason="invalid-qr" />;

  // NOTE: redirect() throws internally — it must stay outside try/catch.
  if (branch.menuSlug) {
    const query = table?.trim() ? `?table=${encodeURIComponent(table.trim())}` : "";
    redirect(`/menu/${branch.cafe.slug}/${branch.menuSlug}${query}`);
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
