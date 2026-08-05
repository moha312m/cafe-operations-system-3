import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireKey, handleApiError, ApiError, requireFeature } from "@/lib/api";
import { audit } from "@/lib/audit";
import { resolvePermissions } from "@/lib/perms/effective";

type Params = { params: Promise<{ id: string }> };

const patchSchema = z.object({
  name: z.string().trim().min(2).optional(),
  phone: z.string().trim().max(30).nullable().optional(),
  email: z.string().trim().email("بريد إلكتروني غير صحيح").nullable().optional().or(z.literal("")),
  address: z.string().trim().max(300).nullable().optional(),
  notes: z.string().trim().max(500).nullable().optional(),
  isActive: z.boolean().optional(),
});

// PATCH /api/suppliers/[id] — edit details and/or toggle active state.
// Toggling active requires the sensitive suppliers.deactivate key.
export async function PATCH(request: NextRequest, { params }: Params) {
  try {
    const session = await requireKey("suppliers.edit");
    await requireFeature(session, "purchasesEnabled");
    const { id } = await params;

    const supplier = await db.supplier.findUnique({ where: { id } });
    if (!supplier) throw new ApiError(404, "المورد غير موجود");
    if (session.role !== "SUPER_ADMIN" && supplier.cafeId !== session.cafeId) {
      throw new ApiError(403, "ليس لديك صلاحية لتنفيذ هذا الإجراء");
    }

    const data = patchSchema.parse(await request.json());

    if (data.isActive !== undefined && data.isActive !== supplier.isActive) {
      const { keys } = await resolvePermissions(session);
      if (!keys.has("suppliers.deactivate")) {
        throw new ApiError(403, "ليس لديك صلاحية إيقاف/تفعيل المورد");
      }
    }

    const updated = await db.supplier.update({
      where: { id },
      data: {
        ...(data.name !== undefined ? { name: data.name } : {}),
        ...(data.phone !== undefined ? { phone: data.phone || null } : {}),
        ...(data.email !== undefined ? { email: data.email || null } : {}),
        ...(data.address !== undefined ? { address: data.address || null } : {}),
        ...(data.notes !== undefined ? { notes: data.notes || null } : {}),
        ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
      },
    });

    const base = { cafeId: supplier.cafeId, userId: session.id, entity: "Supplier", entityId: id };
    if (data.isActive !== undefined && data.isActive !== supplier.isActive) {
      await audit({ ...base, action: "SUPPLIER_DEACTIVATED", details: { supplierId: id, name: updated.name, oldValue: supplier.isActive, newValue: data.isActive } });
    } else {
      await audit({ ...base, action: "SUPPLIER_UPDATED", details: { supplierId: id, name: updated.name } });
    }

    return NextResponse.json({ supplier: { id: updated.id, name: updated.name, isActive: updated.isActive } });
  } catch (error) {
    return handleApiError(error);
  }
}
