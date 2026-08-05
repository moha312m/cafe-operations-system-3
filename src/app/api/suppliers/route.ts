import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireKey, resolveCafeId, handleApiError, requireFeature } from "@/lib/api";
import { audit } from "@/lib/audit";

const supplierSelect = {
  id: true, name: true, phone: true, email: true, address: true,
  notes: true, isActive: true, createdAt: true,
  _count: { select: { invoices: true } },
} as const;

// GET /api/suppliers — cafe suppliers. ?q= search, ?active=1 to hide inactive.
export async function GET(request: NextRequest) {
  try {
    const session = await requireKey("suppliers.view");
    await requireFeature(session, "purchasesEnabled");
    const params = request.nextUrl.searchParams;
    const cafeId = resolveCafeId(session, params.get("cafeId"));
    const q = params.get("q")?.trim();
    const activeOnly = params.get("active") === "1";

    const suppliers = await db.supplier.findMany({
      where: {
        cafeId,
        ...(activeOnly ? { isActive: true } : {}),
        ...(q
          ? { OR: [
              { name: { contains: q, mode: "insensitive" as const } },
              { phone: { contains: q } },
            ] }
          : {}),
      },
      select: supplierSelect,
      orderBy: [{ isActive: "desc" }, { name: "asc" }],
    });
    return NextResponse.json({ suppliers });
  } catch (error) {
    return handleApiError(error);
  }
}

const createSchema = z.object({
  name: z.string().trim().min(2, "اسم المورد مطلوب"),
  phone: z.string().trim().max(30).optional(),
  email: z.string().trim().email("بريد إلكتروني غير صحيح").optional().or(z.literal("")),
  address: z.string().trim().max(300).optional(),
  notes: z.string().trim().max(500).optional(),
  cafeId: z.string().optional(),
});

// POST /api/suppliers — create a supplier.
export async function POST(request: NextRequest) {
  try {
    const session = await requireKey("suppliers.create");
    await requireFeature(session, "purchasesEnabled");
    const data = createSchema.parse(await request.json());
    const cafeId = resolveCafeId(session, data.cafeId);

    const supplier = await db.supplier.create({
      data: {
        cafeId,
        name: data.name,
        phone: data.phone || null,
        email: data.email || null,
        address: data.address || null,
        notes: data.notes || null,
      },
      select: supplierSelect,
    });

    await audit({
      cafeId, userId: session.id, action: "SUPPLIER_CREATED",
      entity: "Supplier", entityId: supplier.id,
      details: { supplierId: supplier.id, name: supplier.name },
    });

    return NextResponse.json({ supplier }, { status: 201 });
  } catch (error) {
    return handleApiError(error);
  }
}
