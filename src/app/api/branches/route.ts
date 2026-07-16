import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import {
  requirePermission,
  resolveCafeId,
  handleApiError,
  requireFeature,
} from "@/lib/api";
import { audit } from "@/lib/audit";

export async function GET(request: NextRequest) {
  try {
    const session = await requirePermission("menu:read"); // any staff can list branches
    const cafeId = resolveCafeId(
      session,
      request.nextUrl.searchParams.get("cafeId")
    );
    const branches = await db.branch.findMany({
      where: { cafeId },
      orderBy: { createdAt: "asc" },
    });
    return NextResponse.json({ branches });
  } catch (error) {
    return handleApiError(error);
  }
}

const createBranchSchema = z.object({
  name: z.string().min(1),
  address: z.string().optional(),
  phone: z.string().optional(),
  cafeId: z.string().optional(), // super admin only
});

export async function POST(request: NextRequest) {
  try {
    const session = await requirePermission("branches:manage");
    await requireFeature(session, "branchManagementEnabled");
    const data = createBranchSchema.parse(await request.json());
    const cafeId = resolveCafeId(session, data.cafeId);

    const branch = await db.branch.create({
      data: {
        cafeId,
        name: data.name,
        address: data.address,
        phone: data.phone,
      },
    });

    await audit({
      cafeId,
      userId: session.id,
      action: "branch.create",
      entity: "Branch",
      entityId: branch.id,
      details: { name: branch.name },
    });

    return NextResponse.json({ branch }, { status: 201 });
  } catch (error) {
    return handleApiError(error);
  }
}
