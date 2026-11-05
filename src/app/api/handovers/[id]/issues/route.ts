import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { ApiError, handleApiError, requireActiveSession, requireFeature, resolveCafeId } from "@/lib/api";
import { resolvePermissions } from "@/lib/perms/effective";
import { withIdempotency, requestScope } from "@/lib/idempotency";
import { attemptKey } from "@/lib/attempt-key";
import { reportHandoverIssueInTransaction } from "@/lib/handover-direct";

type Params = { params: Promise<{ id: string }> };

const schema = z
  .object({
    kind: z.enum(["CASH", "STOCK_ITEM", "OTHER"]),
    inventoryItemId: z.string().min(1).nullish(),
    amount: z.union([z.number(), z.string()]).nullish(),
    description: z.string().min(1, "اوصف الاختلاف").max(1000),
    idempotencyKey: z.string().min(1).max(200).optional(),
    cafeId: z.string().optional(),
  })
  .strict();

// POST /api/handovers/:id/issues — «الإبلاغ عن اختلاف», before or after acceptance.
export async function POST(request: NextRequest, { params }: Params) {
  try {
    const session = await requireActiveSession();
    const { keys } = await resolvePermissions(session);
    if (!keys.has("handover.view") && !keys.has("handover.accept") && !keys.has("handover.submit")) throw new ApiError(403, "ليس لديك صلاحية");
    await requireFeature(session, "inventoryEnabled");
    const { id } = await params;
    const body = schema.parse(await request.json());
    const cafeId = resolveCafeId(session, body.cafeId);
    const key = attemptKey(request, body.idempotencyKey);
    return await withIdempotency(request, requestScope(session, `POST /api/handovers/${id}/issues`), { ...body, idempotencyKey: undefined }, async (tx) => {
      const result = await reportHandoverIssueInTransaction(tx, {
        actorId: session.id, cafeId, viewerBranchId: session.branchId,
        input: { handoverId: id, kind: body.kind, inventoryItemId: body.inventoryItemId ?? null, amount: body.amount ?? null, description: body.description, idempotencyKey: key },
      });
      return NextResponse.json(result, { status: result.alreadyReported ? 200 : 201 });
    });
  } catch (error) {
    return handleApiError(error);
  }
}

// GET /api/handovers/:id/issues — what has been reported on this handover.
export async function GET(request: NextRequest, { params }: Params) {
  try {
    const session = await requireActiveSession();
    const { keys } = await resolvePermissions(session);
    if (!keys.has("handover.view")) throw new ApiError(403, "ليس لديك صلاحية");
    const { id } = await params;
    const cafeId = resolveCafeId(session, request.nextUrl.searchParams.get("cafeId"));
    const issues = await db.handoverIssue.findMany({
      where: { handoverId: id, cafeId, ...(session.branchId ? { branchId: session.branchId } : {}) },
      orderBy: { reportedAt: "asc" },
      select: { id: true, kind: true, itemNameSnapshot: true, amount: true, description: true, afterAcceptance: true, status: true, reportedAt: true, reportedBy: { select: { name: true } }, resolvedAt: true, resolutionNote: true },
    });
    return NextResponse.json({ issues: issues.map((i) => ({ ...i, amount: i.amount === null ? null : Number(i.amount) })) });
  } catch (error) {
    return handleApiError(error);
  }
}
