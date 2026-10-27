import { db } from "@/lib/db";
import { ApiError } from "@/lib/api";
import type { SessionUser } from "@/lib/auth";

// Loads an item and enforces cafe + branch scope in one place.
export async function findScopedItem(id: string, session: SessionUser) {
  const item = await db.inventoryItem.findUnique({ where: { id } });
  if (!item) throw new ApiError(404, "الخامة مش موجودة");
  if (session.role !== "SUPER_ADMIN" && item.cafeId !== session.cafeId) {
    throw new ApiError(403, "ليس لديك صلاحية لتنفيذ هذا الإجراء");
  }
  if (session.branchId && item.branchId !== session.branchId) {
    throw new ApiError(403, "ليس لديك صلاحية على فرع تاني");
  }
  return item;
}
