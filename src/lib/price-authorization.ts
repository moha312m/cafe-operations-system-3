import { ApiError, requireKey } from "@/lib/api";
import { audit } from "@/lib/audit";
import type { SessionUser } from "@/lib/auth";

export async function requireCatalogPriceAuthority(actor: SessionUser, cafeId: string) {
  try { await requireKey("menu.edit_prices"); }
  catch (error) {
    if (error instanceof ApiError && error.status === 403) {
      await audit({ cafeId, userId: actor.id, action: "CATALOG_PRICE_REFUSED", entity: "Product",
        details: { permissionKey: "menu.edit_prices" } });
    }
    throw error;
  }
}
