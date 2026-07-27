import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requirePermission, handleApiError, ApiError } from "@/lib/api";
import { audit } from "@/lib/audit";
import { getBranchFinancialSettings } from "@/lib/financials";

type Params = { params: Promise<{ id: string }> };

// Owner (any branch in cafe) or branch manager (own branch only). Cashiers/
// waiters/baristas never reach this — they lack branches:manage.
async function authorizeBranch(branchId: string) {
  const session = await requirePermission("branches:manage");
  const branch = await db.branch.findUnique({ where: { id: branchId } });
  if (!branch) throw new ApiError(404, "الفرع غير موجود");
  if (session.role !== "SUPER_ADMIN" && branch.cafeId !== session.cafeId) {
    throw new ApiError(403, "ليس لديك صلاحية على هذا الفرع");
  }
  if (session.branchId && session.branchId !== branchId) {
    throw new ApiError(403, "ليس لديك صلاحية على فرع تاني");
  }
  return { session, branch };
}

// Read is allowed for any order-taker (POS needs it for live totals);
// editing (PATCH) stays restricted to owners/managers.
export async function GET(_req: NextRequest, { params }: Params) {
  try {
    const { id: branchId } = await params;
    const session = await requirePermission("orders:create");
    const branch = await db.branch.findUnique({ where: { id: branchId } });
    if (!branch) throw new ApiError(404, "الفرع غير موجود");
    if (session.role !== "SUPER_ADMIN" && branch.cafeId !== session.cafeId) {
      throw new ApiError(403, "ليس لديك صلاحية على هذا الفرع");
    }
    if (session.branchId && session.branchId !== branchId) {
      throw new ApiError(403, "ليس لديك صلاحية على فرع تاني");
    }
    const settings = await getBranchFinancialSettings(branchId);
    return NextResponse.json({ settings });
  } catch (error) {
    return handleApiError(error);
  }
}

const patchSchema = z.object({
  taxEnabled: z.boolean().optional(),
  taxRate: z.number().min(0).max(100).optional(),
  applyTaxTo: z.enum(["ALL_ORDERS", "DINE_IN_ONLY", "TAKEAWAY_ONLY", "DELIVERY_ONLY"]).optional(),
  serviceChargeEnabled: z.boolean().optional(),
  serviceChargeType: z.enum(["PERCENTAGE", "FIXED"]).optional(),
  serviceChargeRate: z.number().min(0).max(100).optional(),
  serviceChargeFixedAmount: z.number().min(0).optional(),
  applyServiceTo: z.enum(["ALL_ORDERS", "DINE_IN_ONLY", "TAKEAWAY_ONLY", "DELIVERY_ONLY"]).optional(),
});

export async function PATCH(request: NextRequest, { params }: Params) {
  try {
    const { id: branchId } = await params;
    const { session, branch } = await authorizeBranch(branchId);
    const prev = await getBranchFinancialSettings(branchId);
    const data = patchSchema.parse(await request.json());

    const updated = await db.branchFinancialSettings.update({
      where: { branchId },
      data,
    });

    const base = { cafeId: branch.cafeId, userId: session.id, entity: "BranchFinancialSettings", entityId: updated.id };
    const who = { branchId, branchName: branch.name, byName: session.name };
    const taxChanged = ["taxEnabled", "taxRate", "applyTaxTo"].some(
      (k) => data[k as keyof typeof data] !== undefined
    );
    const serviceChanged = ["serviceChargeEnabled", "serviceChargeType", "serviceChargeRate", "serviceChargeFixedAmount", "applyServiceTo"].some(
      (k) => data[k as keyof typeof data] !== undefined
    );
    if (taxChanged) {
      await audit({
        ...base, action: "TAX_SETTINGS_UPDATED",
        details: { ...who, oldValue: { taxEnabled: prev.taxEnabled, taxRate: Number(prev.taxRate), applyTaxTo: prev.applyTaxTo }, newValue: { taxEnabled: updated.taxEnabled, taxRate: Number(updated.taxRate), applyTaxTo: updated.applyTaxTo } },
      });
    }
    if (serviceChanged) {
      await audit({
        ...base, action: "SERVICE_SETTINGS_UPDATED",
        details: { ...who, oldValue: { enabled: prev.serviceChargeEnabled, type: prev.serviceChargeType, rate: Number(prev.serviceChargeRate), fixed: Number(prev.serviceChargeFixedAmount), applyTo: prev.applyServiceTo }, newValue: { enabled: updated.serviceChargeEnabled, type: updated.serviceChargeType, rate: Number(updated.serviceChargeRate), fixed: Number(updated.serviceChargeFixedAmount), applyTo: updated.applyServiceTo } },
      });
    }

    return NextResponse.json({ settings: updated });
  } catch (error) {
    return handleApiError(error);
  }
}
