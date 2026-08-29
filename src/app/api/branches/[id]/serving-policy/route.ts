import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireKey, handleApiError, ApiError } from "@/lib/api";
import { getSession } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { getEffectiveServingPolicy } from "@/lib/serving-policy";

type Params = { params: Promise<{ id: string }> };

// Whether staff may hand an order over before it is paid is a control, not a
// preference, so editing it needs the same key as the other sensitive
// settings. Reading it is open to anyone who works the floor, because the
// kitchen and POS screens have to show the right action.
async function authorizeBranch(branchId: string, forEdit: boolean) {
  // Reading needs no key beyond being signed in to this café: a barista has
  // to know whether they may hand an order over, and they hold none of the
  // POS or settings permissions. Editing stays behind settings.edit.
  let session;
  if (forEdit) {
    session = await requireKey("settings.edit");
  } else {
    session = await getSession();
    if (!session) throw new ApiError(401, "سجّل دخولك الأول");
  }
  const branch = await db.branch.findUnique({ where: { id: branchId } });
  if (!branch) throw new ApiError(404, "الفرع غير موجود");
  // Tenant isolation: a café may only ever see or move its own branches.
  if (session.role !== "SUPER_ADMIN" && branch.cafeId !== session.cafeId) {
    throw new ApiError(403, "ليس لديك صلاحية على هذا الفرع");
  }
  // Branch isolation: a branch-scoped user may not reach a sibling branch.
  if (session.branchId && session.branchId !== branchId) {
    throw new ApiError(403, "ليس لديك صلاحية على فرع تاني");
  }
  return { session, branch };
}

// GET — the policy actually in force here, plus whether each half is
// inherited, so the settings screen can show "using the café default".
export async function GET(_req: NextRequest, { params }: Params) {
  try {
    const { id: branchId } = await params;
    await authorizeBranch(branchId, false);
    const policy = await getEffectiveServingPolicy(branchId);
    return NextResponse.json({ policy });
  } catch (error) {
    return handleApiError(error);
  }
}

// null means "inherit the café setting" — the same value the column holds.
const policyValue = z.enum(["ALLOW_BEFORE_PAYMENT", "REQUIRE_PAYMENT_FIRST"]).nullable();
const patchSchema = z.object({
  dineInServingPolicyOverride: policyValue.optional(),
  takeawayServingPolicyOverride: policyValue.optional(),
});

export async function PATCH(request: NextRequest, { params }: Params) {
  try {
    const { id: branchId } = await params;
    const { session, branch } = await authorizeBranch(branchId, true);
    const data = patchSchema.parse(await request.json());

    const before = await getEffectiveServingPolicy(branchId);
    const updated = await db.branch.update({ where: { id: branchId }, data });
    const after = await getEffectiveServingPolicy(branchId);

    await audit({
      cafeId: branch.cafeId,
      userId: session.id,
      action: "SERVING_POLICY_UPDATED",
      entity: "Branch",
      entityId: branchId,
      details: {
        branchId,
        branchName: branch.name,
        byName: session.name,
        scope: "BRANCH",
        oldValue: { dineIn: before.dineIn, takeaway: before.takeaway },
        newValue: { dineIn: after.dineIn, takeaway: after.takeaway },
        overrides: {
          dineIn: updated.dineInServingPolicyOverride,
          takeaway: updated.takeawayServingPolicyOverride,
        },
      },
    });

    return NextResponse.json({ policy: after });
  } catch (error) {
    return handleApiError(error);
  }
}
