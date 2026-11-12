import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { ApiError, handleApiError, requireActiveSession, requireFeature, resolveCafeId } from "@/lib/api";
import { resolvePermissions } from "@/lib/perms/effective";
import { withIdempotency, requestScope } from "@/lib/idempotency";
import { attemptKey } from "@/lib/attempt-key";
import { incomingCountView, recordIncomingLine, startIncomingCount, submitIncomingCount } from "@/lib/stock-handover-v2";

type Params = { params: Promise<{ id: string }> };

// Stock handover v2 — the arriving employee's own blind count. Counting never
// waits on anything and never changes stock: these actions only record.
const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("start"), shiftId: z.string().min(1).nullish(), cafeId: z.string().optional() }).strict(),
  z.object({
    action: z.literal("line"),
    inventoryItemId: z.string().min(1),
    quantity: z.union([z.number(), z.string()]),
    reason: z.string().max(500).nullish(),
    cafeId: z.string().optional(),
  }).strict(),
  z.object({ action: z.literal("submit"), cafeId: z.string().optional() }).strict(),
]);

const mayCount = (keys: Set<string>) => keys.has("handover.accept") || keys.has("handover.manage") || keys.has("stock_count.submit");
const maySeeOutgoing = (keys: Set<string>) => keys.has("handover.manage") || keys.has("shifts.view_reports");

// GET /api/handovers/:id/incoming-count — the counter's own figures; the
// outgoing ones only after submitting (or for a manager).
export async function GET(request: NextRequest, { params }: Params) {
  try {
    const session = await requireActiveSession();
    const { keys } = await resolvePermissions(session);
    if (!mayCount(keys) && !maySeeOutgoing(keys)) throw new ApiError(403, "ليس لديك صلاحية");
    await requireFeature(session, "inventoryEnabled");
    const { id } = await params;
    const cafeId = resolveCafeId(session, request.nextUrl.searchParams.get("cafeId"));
    const view = await db.$transaction((tx) => incomingCountView(tx, { handoverId: id, actorId: session.id, cafeId, viewerBranchId: session.branchId, canSeeOutgoing: maySeeOutgoing(keys) }));
    return NextResponse.json(view);
  } catch (error) {
    return handleApiError(error);
  }
}

// POST /api/handovers/:id/incoming-count — start, record one item, or submit.
export async function POST(request: NextRequest, { params }: Params) {
  try {
    const session = await requireActiveSession();
    const { keys } = await resolvePermissions(session);
    if (!mayCount(keys)) throw new ApiError(403, "ليس لديك صلاحية لجرد الاستلام");
    await requireFeature(session, "inventoryEnabled");
    const { id } = await params;
    const body = schema.parse(await request.json());
    const cafeId = resolveCafeId(session, body.cafeId);
    const key = attemptKey(request);
    return await withIdempotency(request, requestScope(session, `POST /api/handovers/${id}/incoming-count`), body, async (tx) => {
      const actor = { actorId: session.id, cafeId, viewerBranchId: session.branchId };
      if (body.action === "start") {
        const started = await startIncomingCount(tx, { ...actor, handoverId: id, shiftId: body.shiftId ?? null });
        return NextResponse.json({ countId: started.count.id, created: started.created }, { status: started.created ? 201 : 200 });
      }
      if (body.action === "line") {
        const recorded = await recordIncomingLine(tx, { ...actor, handoverId: id, inventoryItemId: body.inventoryItemId, quantity: body.quantity, reason: body.reason ?? null, idempotencyKey: key });
        return NextResponse.json({
          lineId: recorded.line.id, revision: recorded.line.revision, quantity: recorded.line.quantity.toFixed(3), replayed: recorded.replayed,
          comparisonId: recorded.comparison?.comparisonId ?? null,
        }, { status: recorded.replayed ? 200 : 201 });
      }
      const submitted = await submitIncomingCount(tx, { ...actor, handoverId: id });
      return NextResponse.json({
        comparisonId: submitted.comparisonId, alreadySubmitted: submitted.alreadySubmitted, notified: submitted.notified,
        comparison: submitted.snapshot,
      });
    });
  } catch (error) {
    return handleApiError(error);
  }
}
