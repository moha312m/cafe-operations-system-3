import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import {
  requireKey,
  requireFeature,
  resolveCafeId,
  resolveBranchId,
  handleApiError,
} from "@/lib/api";
import {
  HandoverSubmitRefusedError,
  listHandoversForViewer,
  startHandoverCount,
  submitHandover,
} from "@/lib/handover";

// The handover the caller means is the one they NAME.
//
// There is no "the branch's current handover" here on purpose. A branch with
// a handover open is exactly the situation where inferring one is most
// plausible and most dangerous: two shifts closing near each other, a stale
// tab, a retried request, and the count lands against the wrong custodian's
// discharge. `handoverId` is required by both actions, and neither of them
// can create a `HandoverSession` — closing a shift is still the only way one
// comes into existence.
//
// `.strict()` on both members is the other half of that. A body carrying
// `countedQuantity`, `expectedQuantity`, `scopeItemIds` or `type` is refused
// BY NAME rather than having the field quietly dropped: obeying would let the
// person being measured write their own result, and ignoring would let them
// believe they had. It is the same refusal `assertNoClientScope` makes for an
// ordinary count start, expressed in the schema because this route has only
// two shapes to describe.
const actionSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("start_count"),
      handoverId: z.string().min(1, "لازم تحدد التسليم"),
      cafeId: z.string().optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("submit"),
      handoverId: z.string().min(1, "لازم تحدد التسليم"),
      cafeId: z.string().optional(),
    })
    .strict(),
]);

// GET /api/handovers — the branch's handovers, with no quantity in the shape.
export async function GET(request: NextRequest) {
  try {
    const session = await requireKey("handover.view");
    await requireFeature(session, "inventoryEnabled");

    const params = request.nextUrl.searchParams;
    const cafeId = resolveCafeId(session, params.get("cafeId"));
    const branchId = resolveBranchId(session, params.get("branchId"));
    const status = params.get("status");

    const handovers = await listHandoversForViewer({
      cafeId,
      branchId,
      status: status ? (status as never) : undefined,
    });
    return NextResponse.json({ handovers });
  } catch (error) {
    return handleApiError(error);
  }
}

// POST /api/handovers — start the handover's count, or submit the handover.
//
// `200` rather than `201` for `start_count`: a retry that reuses the count
// already open created nothing, and answering "created" to it would be false.
export async function POST(request: NextRequest) {
  try {
    const session = await requireKey("handover.submit");
    await requireFeature(session, "inventoryEnabled");

    const body = actionSchema.parse(await request.json());
    const cafeId = resolveCafeId(session, body.cafeId);

    if (body.action === "start_count") {
      const started = await startHandoverCount({
        handoverId: body.handoverId,
        actorId: session.id,
        cafeId,
        viewerBranchId: session.branchId,
      });
      return NextResponse.json({
        countSession: {
          id: started.countSessionId,
          type: started.type,
          scopeItemIds: started.scopeItemIds,
          reused: started.reused,
        },
      });
    }

    const submitted = await submitHandover({
      handoverId: body.handoverId,
      outgoingUserId: session.id,
      cafeId,
      viewerBranchId: session.branchId,
    });
    return NextResponse.json({
      status: submitted.status,
      position: submitted.position,
      alreadySubmitted: submitted.alreadySubmitted,
    });
  } catch (error) {
    // Unwrapped here, the way the close route unwraps `HandoverBlockedError`:
    // the aggregate is the feature, and letting it collapse to one message
    // would send a café back to fix one thing at a time.
    if (error instanceof HandoverSubmitRefusedError) {
      return NextResponse.json(
        {
          error: error.message,
          refusals: error.refusals,
          position: error.position,
        },
        { status: error.status }
      );
    }
    return handleApiError(error);
  }
}
