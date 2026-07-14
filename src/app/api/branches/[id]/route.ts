import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requirePermission, handleApiError, ApiError } from "@/lib/api";
import { audit } from "@/lib/audit";

type Params = { params: Promise<{ id: string }> };

const updateBranchSchema = z.object({
  name: z.string().min(1).optional(),
  address: z.string().nullable().optional(),
  phone: z.string().nullable().optional(),
  isActive: z.boolean().optional(),
  publicMenuEnabled: z.boolean().optional(),
  menuSlug: z
    .string()
    .regex(/^[a-z0-9-]{2,40}$/, "حروف إنجليزية صغيرة وأرقام وشرطات بس")
    .nullable()
    .optional(),
});

export async function PATCH(request: NextRequest, { params }: Params) {
  try {
    const session = await requirePermission("branches:manage");
    const { id } = await params;

    const branch = await db.branch.findUnique({ where: { id } });
    if (!branch) throw new ApiError(404, "Branch not found");
    // Tenant isolation + branch managers can only edit their own branch.
    if (session.role !== "SUPER_ADMIN" && branch.cafeId !== session.cafeId) {
      throw new ApiError(403, "Not allowed");
    }
    if (session.branchId && session.branchId !== id) {
      throw new ApiError(403, "Not allowed to edit another branch");
    }

    const data = updateBranchSchema.parse(await request.json());
    if (data.menuSlug) {
      const taken = await db.branch.findFirst({
        where: { cafeId: branch.cafeId, menuSlug: data.menuSlug, id: { not: id } },
      });
      if (taken) throw new ApiError(409, "اسم الرابط ده مستخدم في فرع تاني");
    }
    const updated = await db.branch.update({ where: { id }, data });

    await audit({
      cafeId: branch.cafeId,
      userId: session.id,
      action: "branch.update",
      entity: "Branch",
      entityId: id,
      details: data,
    });

    return NextResponse.json({ branch: updated });
  } catch (error) {
    return handleApiError(error);
  }
}
