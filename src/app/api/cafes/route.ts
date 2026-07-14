import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requirePermission, handleApiError } from "@/lib/api";
import { hashPassword } from "@/lib/auth";
import { audit } from "@/lib/audit";

// Super admin: list all cafes with counts.
export async function GET() {
  try {
    await requirePermission("platform:manage");
    const cafes = await db.cafe.findMany({
      include: { _count: { select: { branches: true, users: true, orders: true } } },
      orderBy: { createdAt: "desc" },
    });
    return NextResponse.json({ cafes });
  } catch (error) {
    return handleApiError(error);
  }
}

const createCafeSchema = z.object({
  name: z.string().min(2),
  slug: z
    .string()
    .min(2)
    .regex(/^[a-z0-9-]+$/, "lowercase letters, numbers and dashes only"),
  currency: z.string().length(3).default("USD"),
  taxRate: z.number().min(0).max(100).default(0),
  // Onboarding creates the first owner account and main branch together
  // so a new tenant is usable immediately.
  ownerName: z.string().min(2),
  ownerEmail: z.string().email(),
  ownerPassword: z.string().min(8),
  mainBranchName: z.string().min(1).default("Main Branch"),
});

export async function POST(request: NextRequest) {
  try {
    const session = await requirePermission("platform:manage");
    const data = createCafeSchema.parse(await request.json());

    const existingEmail = await db.user.findUnique({
      where: { email: data.ownerEmail.toLowerCase() },
    });
    if (existingEmail) {
      return NextResponse.json(
        { error: "Owner email is already in use" },
        { status: 409 }
      );
    }

    const cafe = await db.cafe.create({
      data: {
        name: data.name,
        slug: data.slug,
        currency: data.currency,
        taxRate: data.taxRate,
        branches: { create: { name: data.mainBranchName } },
        users: {
          create: {
            email: data.ownerEmail.toLowerCase(),
            name: data.ownerName,
            passwordHash: await hashPassword(data.ownerPassword),
            role: "CAFE_OWNER",
          },
        },
      },
      include: { branches: true },
    });

    await audit({
      userId: session.id,
      action: "cafe.create",
      entity: "Cafe",
      entityId: cafe.id,
      details: { name: cafe.name, slug: cafe.slug },
    });

    return NextResponse.json({ cafe }, { status: 201 });
  } catch (error) {
    return handleApiError(error);
  }
}
