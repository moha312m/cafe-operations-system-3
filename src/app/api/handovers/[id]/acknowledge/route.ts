import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import {
  requireKey,
  requireFeature,
  resolveCafeId,
  handleApiError,
} from "@/lib/api";
import { acknowledgeStockLine, acknowledgeStockSheet } from "@/lib/handover";

type Params = { params: Promise<{ id: string }> };

// The handover the caller means is the one in the PATH, and the line is the
// one they name. Neither is inferred.
//
// `.strict()` for the reason the sibling `POST /api/handovers` states in its
// own comment: a body carrying `handedOverQuantity`, `varianceQuantity`,
// `decision` or `acknowledgedById` is refused BY NAME rather than quietly
// dropped. Obeying would let the person being measured write their own
// result; ignoring would let them believe they had.
//
// `acknowledgedById` is never read from the body — it is `session.id`. The
// signature belongs to whoever is signed in, and an acknowledgement made out
// in somebody else's name is the one thing this record must never carry.
const acknowledgeSchema = z
  .object({
    stockCountLineId: z.string().min(1, "لازم تحدد سطر الجرد"),
    /**
     * The reviewer's own spot count, or nothing.
     *
     * `null` and absent both mean "signed for without counting" and are
     * deliberately allowed through as themselves rather than coerced to 0:
     * the service records a NULL variance for that case, and NULL is not
     * zero.
     */
    incomingCountedQuantity: z.number().finite().min(0).nullable().optional(),
    disputeReasonCodeId: z.string().min(1).optional(),
    disputeNote: z.string().max(500).optional(),
    // HND-UX-003: an explicit refusal. A different quantity alone is accepted
    // and recorded; only this (or a dispute reason) makes the line DISPUTED.
    refuse: z.boolean().optional(),
    cafeId: z.string().optional(),
  })
  .strict();

const sheetSchema = z.object({
  countSessionId:z.string().min(1), countVersion:z.string().min(1), idempotencyKey:z.string().min(1).max(200), cafeId:z.string().optional(),
  lines:z.array(z.object({stockCountLineId:z.string().min(1),incomingCountedQuantity:z.number().finite().min(0).max(999999999.999).nullable(),
    disputeReasonCodeId:z.string().min(1).optional(),disputeNote:z.string().max(500).optional(),refuse:z.boolean().optional()}).strict()).min(1).max(2000),
}).strict();

// POST /api/handovers/:id/acknowledge — the arriving custodian signs for one
// line, and may say the shelf does not match.
//
// `handover.accept`: acknowledging is the act of the party TAKING the
// custody, which is exactly what that key names.
//
// `200`, not `201`: the body is the acknowledgement's VERDICT — what was
// handed over and what it differs from — rather than a pointer to a new
// resource. The same answer `accept-variance` gives for the same reason.
//
// Every refusal travels through the shared `handleApiError`: 403 for the key
// or the feature, 400 for what the caller sent (unknown field, missing line,
// missing or wrong-domain reason), 404 for a handover or line that is not
// theirs to see, 409 for a state that is not ready — the handover not in
// review, a line from a superseded count, a line never counted, or one
// already signed for.
export async function POST(request: NextRequest, { params }: Params) {
  try {
    const session = await requireKey("handover.accept");
    await requireFeature(session, "inventoryEnabled");
    const { id } = await params;

    const raw:unknown = await request.json();
    if(raw && typeof raw === 'object' && 'lines' in raw){
      const body=sheetSchema.parse(raw);
      const result=await acknowledgeStockSheet({...body,handoverId:id,acknowledgedById:session.id,cafeId:resolveCafeId(session,body.cafeId),viewerBranchId:session.branchId});
      return NextResponse.json(result);
    }
    const body = acknowledgeSchema.parse(raw);
    const cafeId = resolveCafeId(session, body.cafeId);

    const result = await acknowledgeStockLine({
      handoverId: id,
      stockCountLineId: body.stockCountLineId,
      acknowledgedById: session.id,
      incomingCountedQuantity: body.incomingCountedQuantity,
      disputeReasonCodeId: body.disputeReasonCodeId,
      refuse: body.refuse,
      disputeNote: body.disputeNote,
      cafeId,
      viewerBranchId: session.branchId,
    });

    // The acknowledged line's verdict and nothing more: no other line's
    // figures, no expected quantity, no session projection. Disclosure of the
    // rest of the count is the review view's business, and it opens because
    // this row now exists.
    return NextResponse.json(result);
  } catch (error) {
    return handleApiError(error);
  }
}
