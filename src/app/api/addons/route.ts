import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requirePermission, resolveCafeId, handleApiError } from "@/lib/api";
import { audit } from "@/lib/audit";

export async function GET(request: NextRequest) {
  try {
    const session = await requirePermission("menu:read");
    const cafeId = resolveCafeId(
      session,
      request.nextUrl.searchParams.get("cafeId")
    );
    const addOns = await db.addOn.findMany({
      where: { cafeId },
      orderBy: { name: "asc" },
    });
    return NextResponse.json({ addOns });
  } catch (error) {
    return handleApiError(error);
  }
}

const createAddOnSchema = z.object({
  name: z.string().min(1),
  price: z.number().min(0),
  cafeId: z.string().optional(),
});

export async function POST(request: NextRequest) {
  try {
    const session = await requirePermission("menu:manage");
    const data = createAddOnSchema.parse(await request.json());
    const cafeId = resolveCafeId(session, data.cafeId);

    const addOn = await db.addOn.create({
      data: { cafeId, name: data.name, price: data.price },
    });

    await audit({
      cafeId,
      userId: session.id,
      action: "addon.create",
      entity: "AddOn",
      entityId: addOn.id,
      details: { name: addOn.name, price: data.price },
    });

    return NextResponse.json({ addOn }, { status: 201 });
  } catch (error) {
    return handleApiError(error);
  }
}
